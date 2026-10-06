'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const panelApi = require('../../src/electron/renderer/syncDevicePanel');
const i18n = require('../../src/electron/renderer/i18n');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function harness(settings = {}, overrides = {}) {
  const document = { activeElement: null };
  const control = (value = '') => ({
    value, hidden: false, dataset: {}, listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    contains(element) { return this === element; },
    focus() { document.activeElement = this; },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; }
  });
  const els = Object.fromEntries([
    'hubUrlInput', 'secretInput', 'deviceIdInput', 'hubPortInput', 'saveSettingsButton',
    'syncConnectionEditor', 'syncConnectionIdentity', 'syncConnectionEndpoint', 'syncConnectionEdit',
    'syncConnectionCancel', 'syncConnectionSaveError', 'syncDeviceSettings', 'syncUploadIntervalRow'
  ].map(id => [id, control()]));
  els.syncConnectionEditor.contains = element => [els.hubUrlInput, els.secretInput].includes(element);
  els.syncDeviceSettings.contains = element => [els.deviceIdInput, els.saveSettingsButton, els.syncConnectionCancel].includes(element);
  const state = { settings: { hubMode: 'client', hubUrl: 'https://saved.example', secret: '', deviceId: 'me', hubHostPort: 17321, ...settings } };
  const patches = [];
  const context = vm.createContext({
    state, els, document, syncDevicePanelApi: panelApi,
    t: key => i18n.translate('en', key),
    preserveSettingsPanelScroll: callback => callback(),
    isSettingsSurfaceVisible: () => true,
    setHoverMarqueeText: (element, value) => { element.textContent = value; },
    saveSettings: async patch => {
      patches.push({ ...patch });
      state.settings = { ...state.settings, ...patch };
      context.syncHubDraftFields();
    },
    refreshHubInfo: async () => {}, refreshHubBuildStatus: async () => {}, refreshStats: async () => {},
    ...overrides
  });
  const draft = app.slice(app.indexOf('const HUB_DRAFT_FIELDS = ['), app.indexOf('let settingsDomSyncPending ='));
  const save = app.slice(app.indexOf("els.saveSettingsButton.addEventListener('click'"), app.indexOf('els.syncPanelOpenDevices?.addEventListener'));
  vm.runInContext(`${draft}\n${save}`, context);
  context.syncHubDraftFields();
  const edit = (field, value) => {
    const id = { hubUrl: 'hubUrlInput', secret: 'secretInput', deviceId: 'deviceIdInput', hubHostPort: 'hubPortInput' }[field];
    els[id].value = value;
    context.markHubDraftDirty(field);
  };
  return { context, state, els, document, patches, edit, save: () => els.saveSettingsButton.listeners.click() };
}

test('configured URL needs no secret and connectivity does not select the editor', () => {
  const { context, state, els } = harness();
  assert.equal(els.syncConnectionEditor.hidden, true);
  assert.equal(els.syncDeviceSettings.inert, true);
  assert.equal(els.syncConnectionEdit.hidden, false);
  for (const connected of [false, true]) {
    state.streamConnected = connected;
    state.streamFailure = { reason: 'network' };
    context.syncHubConnectionUi();
    assert.equal(els.syncConnectionEditor.hidden, true);
  }
  for (const hubUrl of ['', '   ']) {
    const setup = harness({ hubUrl });
    assert.equal(setup.els.syncConnectionEditor.hidden, false);
    assert.equal(setup.els.syncDeviceSettings.inert, false);
    assert.equal(setup.els.syncConnectionEdit.hidden, true);
  }
});

test('opening freezes even clean fields, compares against new saved values, and Cancel restores the latest settings', () => {
  const { context, state, els, document, patches } = harness({ secret: 'old-secret' });
  context.beginClientConnectionEdit({ focus: true });
  assert.equal(document.activeElement, els.hubUrlInput);
  state.settings = { ...state.settings, hubUrl: 'https://new.example', secret: 'new-secret', deviceId: 'new-device' };
  context.syncHubDraftFields();
  assert.deepEqual([els.hubUrlInput.value, els.secretInput.value, els.deviceIdInput.value], ['https://saved.example', 'old-secret', 'me']);
  assert.equal(els.saveSettingsButton.disabled, false);
  assert.equal(els.syncConnectionEditor.hidden, false);
  context.cancelClientConnectionEdit();
  assert.deepEqual([els.hubUrlInput.value, els.secretInput.value, els.deviceIdInput.value], ['https://new.example', 'new-secret', 'new-device']);
  assert.equal(els.syncConnectionEditor.hidden, true);
  assert.equal(document.activeElement, els.syncConnectionEdit);
  assert.deepEqual(patches, []);
});

test('first setup focus preserves fields when an external push configures the connection', () => {
  const { context, state, els } = harness({ hubUrl: '' });
  context.beginClientConnectionEdit();
  state.settings = { ...state.settings, hubUrl: 'https://external.example', secret: 'external' };
  context.syncHubDraftFields();
  assert.equal(els.hubUrlInput.value, '');
  assert.equal(els.secretInput.value, '');
  assert.equal(els.syncConnectionEditor.hidden, false);
  assert.equal(els.saveSettingsButton.disabled, false);
});

test('client drafts survive mode and panel changes without trapping non-client controls', () => {
  const { context, state, els, edit } = harness();
  edit('hubUrl', 'https://draft.example');
  for (const mode of ['local', 'host', 'icloud', 'client']) {
    state.settings = { ...state.settings, hubMode: mode };
    context.syncHubDraftFields();
    assert.equal(els.hubUrlInput.value, 'https://draft.example');
    assert.equal(els.syncDeviceSettings.hidden, false);
    assert.equal(els.syncDeviceSettings.inert, false);
    assert.equal(els.syncUploadIntervalRow.hidden, mode !== 'client');
  }
  context.isSettingsSurfaceVisible = () => false;
  context.syncHubDraftFields();
  context.isSettingsSurfaceVisible = () => true;
  context.syncHubDraftFields();
  assert.equal(els.syncConnectionEditor.hidden, false);
});

test('Cancel leaves a hidden host port draft intact and host dirtiness does not prevent client closure', async () => {
  const { context, state, els, edit, save } = harness({ hubMode: 'host' });
  edit('hubHostPort', '18000');
  state.settings = { ...state.settings, hubMode: 'client' };
  context.syncHubDraftFields();
  edit('hubUrl', 'https://draft.example');
  context.cancelClientConnectionEdit();
  assert.equal(els.hubPortInput.value, '18000');
  assert.equal(els.syncConnectionEditor.hidden, true);
  edit('hubUrl', 'https://next.example');
  await save();
  assert.equal(els.syncConnectionEditor.hidden, true);
  assert.equal(els.hubPortInput.value, '18000');
});

test('own settings broadcast cannot close the editor before persistence resolves', async () => {
  const { context, state, els, edit, save } = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  context.saveSettings = async patch => {
    state.settings = { ...state.settings, ...patch };
    context.syncHubDraftFields();
    assert.equal(els.syncConnectionEditor.hidden, false);
    await gate;
  };
  edit('hubUrl', 'https://next.example');
  const pending = save();
  assert.equal(els.syncConnectionCancel.disabled, true);
  context.cancelClientConnectionEdit();
  assert.equal(els.syncConnectionEditor.hidden, false);
  release();
  await pending;
  assert.equal(els.syncConnectionEditor.hidden, true);
  assert.equal(els.syncConnectionCancel.disabled, false);
});

test('new input while saving, including a reversion, keeps the editor open', async () => {
  for (const newer of ['https://newer.example', 'https://saved.example']) {
    const { context, state, els, edit, save } = harness();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    context.saveSettings = async patch => {
      await gate;
      state.settings = { ...state.settings, ...patch };
      context.syncHubDraftFields();
    };
    edit('hubUrl', 'https://submitted.example');
    const pending = save();
    edit('hubUrl', newer);
    release();
    await pending;
    assert.equal(els.hubUrlInput.value, newer);
    assert.equal(els.syncConnectionEditor.hidden, false);
    assert.equal(els.saveSettingsButton.disabled, false);
  }
});

test('new editor session or changed mode prevents save closure', async () => {
  const { context, state, els } = harness();
  context.beginClientConnectionEdit({ focus: true });
  const { revisions, editRevision } = vm.runInContext('({ revisions: { ...hubDraftRevisions }, editRevision: clientConnectionEditRevision })', context);
  context.finishClientConnectionSave(revisions, editRevision - 1);
  assert.equal(els.syncConnectionEditor.hidden, false);
  state.settings = { ...state.settings, hubMode: 'host' };
  context.finishClientConnectionSave(revisions, editRevision);
  assert.equal(vm.runInContext('clientConnectionEditing', context), true);
  state.settings = { ...state.settings, hubMode: 'client' };
  context.syncHubConnectionUi();
  assert.equal(els.syncConnectionEditor.hidden, false);
  context.finishClientConnectionSave(revisions, editRevision);
  assert.equal(els.syncConnectionEditor.hidden, true);
});

test('persistence failure keeps drafts and safe feedback until retry succeeds', async () => {
  const { context, els, edit, save } = harness();
  const persist = context.saveSettings;
  context.saveSettings = async () => { throw new Error('raw secret must not appear'); };
  edit('hubUrl', 'https://retry.example');
  await save();
  assert.equal(els.hubUrlInput.value, 'https://retry.example');
  assert.equal(els.syncConnectionEditor.hidden, false);
  assert.equal(els.saveSettingsButton.disabled, false);
  assert.equal(els.syncConnectionSaveError.hidden, false);
  assert.equal(els.syncConnectionSaveError.textContent, i18n.translate('en', 'settings.sync.saveFailed'));
  context.syncHubDraftFields();
  assert.equal(els.syncConnectionSaveError.hidden, false);
  context.saveSettings = persist;
  await save();
  assert.equal(els.syncConnectionSaveError.hidden, true);
  assert.equal(els.syncConnectionEditor.hidden, true);
});

test('successful persistence closes before refresh and refresh failure is not a save failure', async () => {
  const { context, els, edit, save } = harness();
  context.refreshStats = async () => {
    assert.equal(els.syncConnectionEditor.hidden, true);
    throw new Error('refresh failed');
  };
  edit('hubUrl', 'https://next.example');
  await assert.rejects(save(), /refresh failed/);
  assert.equal(els.syncConnectionEditor.hidden, true);
  assert.equal(els.syncConnectionSaveError.hidden, true);
  assert.equal(els.saveSettingsButton.disabled, true);
});

test('saving an empty URL keeps the setup form visible', async () => {
  const { els, edit, save } = harness();
  edit('hubUrl', '');
  await save();
  assert.equal(els.syncConnectionEditor.hidden, false);
  assert.equal(els.syncConnectionEdit.hidden, true);
});

test('endpoint summary cannot leak URL credentials or suffixes', () => {
  for (const [value, expected] of [
    ['https://user:password@hub.example:8443/private?secret=abc#token', 'hub.example:8443'],
    ['http://[::1]:17321/path?token=x', '[::1]:17321'],
    ['https://hub.example/', 'hub.example'],
    ['not a URL with secret', ''], ['file:///private/secret', ''], ['javascript:secret', ''], ['', '']
  ]) assert.equal(panelApi.connectionEndpoint(value), expected);
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'pt-BR']) {
    for (const key of ['editConnection', 'savedEndpoint', 'saveFailed']) {
      assert.equal(typeof i18n.MESSAGES[locale][`settings.sync.${key}`], 'string');
    }
  }
});
