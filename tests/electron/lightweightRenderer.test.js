'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function fixture() {
  let callback;
  const context = {
    state: { settingsSections: { window: true }, sessionPage: 2 },
    window: { tokenMonitor: { onPrepareLightweight: (fn) => { callback = fn; } } },
    lightweightUiPaused: () => true,
    isSettingsPanelOpen: () => false,
    lightweightDraftFields: new Map(),
    hubDraftDirty: { hubUrl: false, secret: false, deviceId: false, hubHostPort: false },
    // Forms can legitimately be blank while hidden/lazily initialized. This
    // presentation comparison must not veto a window with no actual edits.
    hubDraftHasChanges: () => { throw new Error('lazy form comparison'); },
    clientConnectionEditing: false,
    pendingSettingsPatches: new Set(),
    SETTINGS_SECTION_IDS: ['general', 'window'],
    els: { breakdown: { scrollTop: 12 }, settingsPanel: { scrollTop: 34 } },
    document: { scrollingElement: { scrollTop: 56 } }
  };
  const start = source.indexOf('window.tokenMonitor.onPrepareLightweight?.(');
  const end = source.indexOf('\nfunction signalContentReady()', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), context);
  return { context, check: () => JSON.parse(JSON.stringify(callback())) };
}

test('an untouched lazy Hub form does not block reclamation', () => {
  const f = fixture();
  assert.equal(f.check().canSuspend, true);
});

test('clean Settings returns only bounded navigation state, including its section', () => {
  const f = fixture();
  f.context.isSettingsPanelOpen = () => true;
  assert.deepEqual(f.check(), {
    canSuspend: true, scrollTop: 12, pageScrollTop: 56, sessionPage: 2,
    settingsOpen: true, settingsSection: 'window', settingsScrollTop: 34
  });
});

test('real drafts, login flows, writes, session details and visible UI veto reclamation', () => {
  for (const block of [
    (c) => { c.hubDraftDirty.hubUrl = true; },
    (c) => { c.clientConnectionEditing = true; },
    (c) => { c.state.workbuddySignInBusy = true; },
    (c) => { c.pendingSettingsPatches.add({ secret: 'fixture' }); },
    (c) => { c.state.subscriptionEditingId = 'new'; },
    (c) => { c.state.openSession = { sessionId: 'fixture' }; },
    (c) => { c.lightweightUiPaused = () => false; },
    (c) => { c.lightweightDraftFields.set({ isConnected: true, value: 'unsaved-credential' }, 'unsaved-credential'); }
  ]) {
    const f = fixture();
    block(f.context);
    const result = f.check();
    assert.equal(result.canSuspend, false);
    assert.doesNotMatch(JSON.stringify(result), /fixture|unsaved-credential|secret/);
  }
});

test('cleared or replaced credential forms no longer hold the window', () => {
  for (const field of [{ isConnected: false, value: 'draft' }, { isConnected: true, value: '' }]) {
    const f = fixture();
    f.context.lightweightDraftFields.set(field, 'draft');
    assert.equal(f.check().canSuspend, true);
  }
});

test('lightweight hidden UI does not poll; ordinary hidden UI keeps its existing cadence', () => {
  const start = source.indexOf('function restartTimer()');
  const end = source.indexOf('\nfunction clamp(', start);
  const schedules = [];
  let paused = true;
  const context = {
    state: { refreshTimer: 1, streamConnected: true, settings: {} },
    lightweightUiPaused: () => paused,
    clearInterval() {},
    setInterval: (_fn, ms) => { schedules.push(ms); return 2; },
    refreshStats() {}
  };
  vm.runInNewContext(source.slice(start, end) + '\nrestartTimer();', context);
  assert.equal(context.state.refreshTimer, null);
  assert.deepEqual(schedules, []);
  paused = false;
  vm.runInNewContext('restartTimer();', context);
  assert.deepEqual(schedules, [300_000]);
});

test('a settings acknowledgement clears only its own saved draft', async () => {
  for (const changedWhileSaving of [false, true]) {
    let acknowledge;
    const field = { value: 'saved', isConnected: true };
    const drafts = new Map([[field, 'saved']]);
    const context = {
      document: { getElementById: () => field },
      lightweightDraftFields: drafts,
      setSyncContentEditError() {}, appearancePreview: {},
      state: { settingsPushRevision: 1 }, pendingSettingsPatches: new Set(),
      syncContentForm: null,
      window: { tokenMonitor: { updateSettings: () => new Promise(resolve => { acknowledge = resolve; }) } },
      applyPersistedSettings() {}
    };
    const start = source.indexOf('async function saveSettings(');
    const end = source.indexOf('\n// The resolved settings', start);
    vm.runInNewContext(source.slice(start, end), context);
    const pending = context.saveSettings({ hubUrl: 'saved' });
    assert.equal(context.pendingSettingsPatches.size, 1);
    if (changedWhileSaving) { field.value = 'new unsaved value'; drafts.set(field, field.value); }
    acknowledge({});
    await pending;
    assert.equal(context.pendingSettingsPatches.size, 0);
    assert.equal(drafts.has(field), changedWhileSaving, 'newer unsaved typing must still veto release');
  }
});

test('recovery from an unresponsive visible UI refreshes missed stats and transport state', () => {
  let receive; let refreshes = 0, resets = 0;
  const context = {
    window: { tokenMonitor: { onWindowVisibilityPush: callback => { receive = callback; } } },
    state: { windowVisible: true, settings: { lightweightMode: true } },
    isRendererWindowHidden: () => false, handleWindowVisibilityChange() {},
    resetLiveTokenRateTracking: () => { resets += 1; }, resetDisplayLiveTokenRateTracking: () => { resets += 1; },
    resumeLightweightUi: () => { refreshes += 1; }
  };
  const start = source.indexOf('window.tokenMonitor.onWindowVisibilityPush?.(');
  const end = source.indexOf('\nwindow.tokenMonitor.onStatsPush', start);
  vm.runInNewContext(source.slice(start, end), context);
  receive(true, false); assert.equal(refreshes, 0);
  receive(true, true); assert.equal(refreshes, 1); assert.equal(resets, 2);
  context.isRendererWindowHidden = () => true;
  receive(false, true); assert.equal(refreshes, 1, 'hidden recovery waits for the ordinary visibility resume');
});
