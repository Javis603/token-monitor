'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '../../src/electron/renderer');
const appSource = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const panelApi = require('../../src/electron/renderer/syncDevicePanel');

function functionSource(name, nextName) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start);
  return appSource.slice(start, end);
}

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll() { return []; }
  setAttribute(name, value) { this[name] = value; }
}

test('sync fields are directly accessible before status and devices without another disclosure', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const start = html.indexOf('id="syncSettingsDetails"');
  const end = html.indexOf('<section class="total-panel">', start);
  const section = html.slice(start, end);
  assert.ok(section.indexOf('id="hubModeOptions"') < section.indexOf('id="hubUrlInput"'));
  assert.ok(section.indexOf('id="saveSettingsButton"') < section.indexOf('id="syncDevicePanel"'));
  assert.doesNotMatch(section, /<details|<summary|syncConnectionSettings|syncConnectionMode/);
  assert.match(section, /class="sync-mode-select"[\s\S]*?<select id="hubModeOptions"[\s\S]*?<span class="settings-section-disclosure" aria-hidden="true">/);
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.doesNotMatch(css.match(/\.sync-connection-fields\s*\{([^}]+)\}/)?.[1] || '', /\bgap:/);
  assert.match(css, /\.settings-sync-group\.expanded[^}]*\.settings-section-summary\s*\{\s*display:\s*none/);
});

test('sync method selects the corresponding fields without touching draft input values', () => {
  const source = functionSource('syncHubModeUi', 'renderIcloudStatus');
  for (const mode of ['local', 'client', 'host', 'icloud']) {
    const hidden = {};
    const field = id => ({ classList: { toggle(name, value) { hidden[id] = value; } } });
    const context = vm.createContext({
      state: { settings: { hubMode: mode }, appInfo: { platform: 'win32' } },
      els: {
        hubModeOptions: {}, syncModeDescription: {}, icloudModeOption: {},
        hubClientFields: field('client'), hubHostFields: field('host'), icloudFields: field('icloud'),
        hubSecretInput: {}, hubUrlInput: { value: 'https://draft.test' }, secretInput: { value: 'draft' }
      },
      SYNC_MODE_DESCRIPTIONS: { local: 'local', client: 'client', host: 'host', icloud: 'icloud' },
      syncModeSelect: { sync() {} },
      t: key => key, renderHubStatus() {}, renderIcloudStatus() {}, renderSyncPanel() {},
      renderHubBuildStatus() {}, syncHubSaveButton() {}
    });
    vm.runInContext(source, context);
    context.syncHubModeUi();
    assert.equal(context.els.icloudModeOption.disabled, true);
    assert.equal(context.els.hubModeOptions.value, mode);
    assert.ok(context.els.syncModeDescription.textContent);
    for (const id of ['client', 'host', 'icloud']) {
      assert.equal(hidden[id], mode !== id);
      const node = context.els[id === 'client' ? 'hubClientFields' : id === 'host' ? 'hubHostFields' : 'icloudFields'];
      assert.equal(node.inert, mode !== id);
    }
    assert.equal(context.els.hubUrlInput.value, 'https://draft.test');
    assert.equal(context.els.secretInput.value, 'draft');
  }
});

test('sync mode enhances the native source with shared icons and translated descriptions', () => {
  const start = appSource.indexOf('const SYNC_MODE_DESCRIPTIONS =');
  const end = appSource.indexOf('function toggleAccordionRow(', start);
  const calls = [];
  const context = vm.createContext({
    window: { TokenMonitorSelectControl: { enhance(select, options) { calls.push({ select, options }); return {}; } }, addEventListener() {} },
    els: { hubModeOptions: {} },
    t: key => key
  });
  vm.runInContext(appSource.slice(start, end), context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].select, context.els.hubModeOptions);
  for (const value of ['local', 'client', 'host', 'icloud']) {
    const meta = calls[0].options.getOptionMeta({ value });
    assert.match(meta.description, /^settings\.sync\./);
    assert.equal(typeof meta.icon, 'function');
    const icon = meta.icon({ createElementNS: () => new Element() });
    assert.equal(icon.viewBox, '0 0 24 24');
    assert.ok(icon.children.length);
  }
  assert.match(appSource, /syncModeSelect\?\.sync\(\)/);
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="selectControl.js"') < html.indexOf('src="app.js"'));
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.match(css, /\.sync-mode-select:has\(\.select-control-trigger\)[^{]*\{\s*display:\s*none/);
  assert.match(css, /\.select-control-trigger:focus-visible/);
});

test('closing sync settings or navigating away cancels the active picker', () => {
  assert.match(functionSource('applySettingsSectionDom', 'setSettingsSectionExpanded'), /id === 'sync' && !open[\s\S]*?syncModeSelect\?\.close\(\)/);
  const viewStart = appSource.indexOf('function openViewFromTray(');
  const viewEnd = appSource.indexOf('const HOME_HISTORY_MAX_RETRIES', viewStart);
  assert.match(appSource.slice(viewStart, viewEnd), /syncModeSelect\?\.close\(\)/);
  const start = appSource.indexOf("els.settingsButton.addEventListener('click'");
  const end = appSource.indexOf("els.saveSettingsButton.addEventListener('click'", start);
  assert.match(appSource.slice(start, end), /else\s*\{\s*syncModeSelect\?\.close\(\)/);
});

test('device versions get their own line rather than competing with sync status', () => {
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    window: { tokenMonitor: { deleteDevice() {} } },
    osIconFor: () => 'windows',
    t: key => key,
    deviceRuntimeLabel: () => 'Widget',
    deviceBreakdownApi: { devicePlatformLabel: () => 'Windows 11 25H2' },
    createDeviceRemoveButton: () => new Element()
  });
  vm.runInContext(functionSource('syncDeviceRow', 'renderHubBuildStatus'), context);
  const row = context.syncDeviceRow({
    key: 'workstation', name: 'Long workstation name', hostname: 'workstation.local',
    platform: 'win32', agentVersion: '0.64.0', agentRuntime: 'electron-widget',
    stale: true, canRemove: true
  });
  const [, main, side] = row.children;
  const [title, meta] = main.children;
  assert.equal(title.children[0].title, 'Long workstation name · workstation.local');
  assert.equal(meta.children.length, 1);
  assert.equal(meta.children[0].textContent, 'Windows 11 25H2 · Widget v0.64.0');
  assert.equal(side.children.length, 2);
  assert.doesNotMatch(appSource, /sync-device-tag/);

  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const metaRule = css.match(/\.sync-device-meta-text\s*\{([^}]+)\}/)?.[1];
  assert.ok(metaRule);
  assert.doesNotMatch(metaRule, /text-overflow:\s*ellipsis|white-space:\s*nowrap/);
  assert.match(css, /@container\s*\(max-width:\s*280px\)/);
});

test('empty device list refreshes when the runtime starts syncing', () => {
  const list = new Element();
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    els: { syncDeviceList: list, syncPanelCount: {}, syncPanelOpenDevices: {} },
    state: { mode: 'local', settings: { hubMode: 'client' } },
    syncDevicePanelApi: panelApi,
    currentLocale: () => 'en',
    availableBreakdownIds: () => ['device'],
    t: key => key,
    devicesBeingDeleted: new Set(),
    resetDeviceDeleteConfirmation() {},
    syncDeviceRow: () => new Element()
  });
  vm.runInContext(`let syncPanelListSignature = '';
${functionSource('renderSyncPanelDevices', 'syncDeviceRow')}`, context);
  context.renderSyncPanelDevices([]);
  assert.equal(list.children[0].textContent, 'settings.sync.panel.waiting');
  context.state.mode = 'sync';
  context.renderSyncPanelDevices([]);
  assert.equal(list.children[0].textContent, 'settings.sync.panel.empty');
});

test('sync timestamp changes keep the existing device row and its controls', () => {
  const list = new Element();
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    els: { syncDeviceList: list, syncPanelCount: {}, syncPanelOpenDevices: {} },
    state: { mode: 'sync', settings: { hubMode: 'client' } },
    syncDevicePanelApi: panelApi,
    currentLocale: () => 'en',
    availableBreakdownIds: () => ['device'],
    t: key => key,
    devicesBeingDeleted: new Set(),
    resetDeviceDeleteConfirmation() {},
    syncDeviceRow: () => new Element()
  });
  vm.runInContext(`let syncPanelListSignature = '';
${functionSource('renderSyncPanelDevices', 'syncDeviceRow')}`, context);
  const [row] = panelApi.deviceRows([{ deviceId: 'remote', receivedAt: '2026-10-02T00:00:00Z' }]);
  context.renderSyncPanelDevices([row]);
  const existing = list.children[0];
  context.renderSyncPanelDevices([{ ...row, syncedAt: '2026-10-02T00:01:00Z' }]);
  assert.equal(list.children[0], existing);
});
