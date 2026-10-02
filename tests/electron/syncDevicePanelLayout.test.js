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
  append(...children) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.className?.split(' ').includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  insertBefore(child, before) {
    child.remove();
    child.parentElement = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
  }
  moveBefore(child, before) { this.insertBefore(child, before); }
  setAttribute(name, value) { this[name] = value; }
}

test('sync connection summary and inline editor precede frequency and devices without another disclosure', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const start = html.indexOf('id="syncSettingsDetails"');
  const end = html.indexOf('<section class="total-panel">', start);
  const section = html.slice(start, end);
  assert.ok(section.indexOf('id="hubModeOptions"') < section.indexOf('id="hubUrlInput"'));
  assert.ok(section.indexOf('id="syncPanelConnection"') < section.indexOf('id="hubUrlInput"'));
  assert.ok(section.indexOf('id="saveSettingsButton"') < section.indexOf('id="syncUploadIntervalRow"'));
  assert.ok(section.indexOf('id="syncUploadIntervalRow"') < section.indexOf('id="syncDevicePanel"'));
  assert.equal((section.match(/id="syncPanelConnection"/g) || []).length, 1);
  assert.doesNotMatch(section, /<details|<summary|syncConnectionSettings|syncConnectionMode/);
  assert.match(section, /class="sync-mode-select"[\s\S]*?<select id="hubModeOptions"[\s\S]*?<span class="settings-section-disclosure" aria-hidden="true">/);
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.doesNotMatch(css.match(/\.sync-connection-fields\s*\{([^}]+)\}/)?.[1] || '', /\bgap:/);
  assert.doesNotMatch(css, /\.settings-sync-group\.expanded[^}]*\.settings-section-summary\s*\{\s*display:\s*none/);
});

test('sync edit and removal actions use local SVG masks without replacing their text labels', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const notices = fs.readFileSync(path.join(rendererDir, 'icons/THIRD_PARTY_NOTICES.md'), 'utf8');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.match(html, /id="syncConnectionEdit"[^>]*data-i18n="settings\.sync\.editConnection">Change connection<\/button>/);
  for (const [selector, icon] of [
    ['.sync-connection-edit::before', 'pencil-line'],
    ['.sync-device-side .device-delete-label::before', 'trash']
  ]) {
    const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(match => match[1].trim() === selector)?.[2];
    assert.ok(rule, selector);
    assert.ok(rule.includes(`mask: url("icons/actions/${icon}.svg") center / contain no-repeat;`));
    const svg = fs.readFileSync(path.join(rendererDir, `icons/actions/${icon}.svg`), 'utf8');
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /stroke-width="2"/);
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|https?:\/\/(?!www\.w3\.org)/);
    assert.ok(notices.includes(`actions/${icon}.svg: ${icon}`));
  }
  assert.match(css, /\.settings-panel \.sync-connection-edit:focus-visible/);
  assert.match(css, /\.settings-panel \.sync-device-side \.device-delete-button:focus-visible/);
});

test('sync status aligns icon and text in one heading and keeps a separate clipped hostname line', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const connection = css.match(/\.sync-panel-connection\s*\{([^}]+)\}/)?.[1];
  assert.match(connection, /display:\s*grid/);
  assert.doesNotMatch(connection, /flex-wrap/);
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.match(html, /class="sync-connection-heading">\s*<span class="sync-connection-status">[\s\S]*?id="syncPanelSignal"[\s\S]*?id="syncPanelState"/);
  assert.match(css.match(/\.sync-connection-status\s*\{([^}]+)\}/)?.[1], /align-items:\s*center/);
  assert.match(css.match(/\.sync-connection-heading\s*\{([^}]+)\}/)?.[1], /align-items:\s*center/);
  assert.doesNotMatch(css.match(/\.sync-panel-signal\s*\{([^}]+)\}/)?.[1], /margin-top/);
  assert.match(css.match(/\.sync-connection-identity\s*\{([^}]+)\}/)?.[1], /display:\s*grid/);
  const endpoint = css.match(/#syncConnectionEndpoint\s*\{([^}]+)\}/)?.[1];
  assert.match(endpoint, /overflow:\s*hidden/);
  assert.match(endpoint, /white-space:\s*nowrap/);
  assert.match(endpoint, /text-overflow:\s*clip/);
  assert.doesNotMatch(endpoint, /ellipsis/);
  assert.match(appSource, /bindHoverMarquee\(els\.syncConnectionEndpoint\)/);
  assert.match(functionSource('syncHubConnectionUi', 'beginClientConnectionEdit'), /setHoverMarqueeText\(els\.syncConnectionEndpoint, syncDevicePanelApi\.connectionEndpoint/);
});

test('select and navigation popups share their regular and native glass surface', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const rule = selector => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(match => match[1].trim() === selector)?.[2];
  const surface = rule('.view-switcher-menu,\n.select-control-popup');
  assert.ok(surface);
  for (const property of ['padding', 'border', 'border-radius', 'background', 'box-shadow', 'backdrop-filter']) {
    assert.ok(surface.includes(`${property}:`), property);
  }
  assert.match(surface, /var\(--glass-rgb\)/);
  assert.doesNotMatch(rule('.select-control-popup'), /background:|border-radius:|box-shadow:/);
  assert.doesNotMatch(rule('.view-switcher-menu'), /background:|border-radius:|box-shadow:/);
  assert.ok(rule('html.native-liquid-glass .select-control-popup,\nhtml.native-liquid-glass .view-switcher-menu'));
  assert.ok(rule('html.native-liquid-glass .select-control-option,\nhtml.native-liquid-glass .view-switcher-menu-item'));
  const selected = '.select-control-option[data-selected="true"]';
  const highlighted = '.select-control-option[data-highlighted="true"]';
  assert.match(rule(selected), /var\(--accent-rgb\), 0\.12/);
  assert.match(rule(selected), /color:\s*var\(--accent\)/);
  assert.equal(rule(selected).trim().replace(/\s+/g, ' '), rule('.view-switcher-menu-item.is-current').trim().replace(/\s+/g, ' '));
  assert.match(rule(highlighted), /0\.07/);
  assert.ok(css.indexOf(selected) > css.indexOf(highlighted), 'selection wins when the same row is highlighted');
  assert.match(rule('.view-switcher-menu-item.is-current'), /0\.12/);
  assert.doesNotMatch(css, /\.select-control-option\[data-selected="true"\]::after/);
});

test('device rows are static and status spacing does not depend on a removal button', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /\.sync-device-row(?:(?:\s*\+\s*)\.sync-device-row)?:hover/);
  assert.match(css.match(/\.sync-device-side\s*\{([^}]+)\}/)?.[1], /display:\s*grid/);
  assert.doesNotMatch(css.match(/\.sync-device-presence\s*\{([^}]+)\}/)?.[1], /min-height|padding/);
  assert.match(css.match(/\.sync-device-action\s*\{([^}]+)\}/)?.[1], /height:\s*0/);
  assert.match(css.match(/^\.sync-device-side \.device-delete-button\s*\{([^}]+)\}/m)?.[1], /align-self:\s*center/, 'sync removal overrides the legacy flex-start alignment');
  assert.match(css.match(/\.sync-device-side \.device-delete-label\s*\{([^}]+)\}/)?.[1], /display:\s*inline-flex;[^}]*justify-self:\s*end;[^}]*gap:\s*5px/);
  assert.match(css, /content:\s*attr\(data-confirm-text\);\s*padding-left:\s*17px;\s*visibility:\s*hidden/);
  assert.match(css, /@container\s*\(max-width:\s*240px\)/);
  const source = functionSource('renderSyncPanelDevices', 'syncDeviceRow');
  assert.match(source, /list\.moveBefore\(item, before\)/);
  assert.match(source, /updateSyncDeviceRow\(item, row\)/);
  assert.doesNotMatch(source, /replaceChildren\(\.\.\.rows/);
});

test('device presence uses a static solid online dot and an outlined offline dot', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const online = css.match(/\.sync-device-dot\s*\{([^}]+)\}/)?.[1];
  const offline = css.match(/\.sync-device-row\.is-stale \.sync-device-dot\s*\{([^}]+)\}/)?.[1];
  assert.match(online, /width:\s*6px;[^}]*height:\s*6px/);
  assert.match(online, /background:\s*var\(--success\)/);
  assert.doesNotMatch(online, /box-shadow|animation|transition/);
  assert.match(offline, /background:\s*transparent/);
  assert.match(offline, /box-shadow:\s*inset 0 0 0 1px var\(--muted\)/);
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
      renderHubBuildStatus() {}, syncHubConnectionUi() {}, syncHubSaveButton() {}
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
    currentLocale: () => 'en', devicesBeingDeleted: new Set(),
    deviceRuntimeLabel: () => 'Widget',
    deviceBreakdownApi: { devicePlatformLabel: () => 'Windows 11 25H2' },
    createDeviceRemoveButton: () => {
      const button = new Element();
      button.className = 'device-delete-button';
      const label = new Element(); label.className = 'device-delete-label';
      button.append(label);
      return button;
    }
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
  assert.match(css, /@container\s*\(max-width:\s*340px\)/);
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
    syncDeviceRow: row => { const item = new Element(); item.dataset.key = row.key; return item; },
    updateSyncDeviceRow() {}
  });
  vm.runInContext(`let syncPanelListScope = '';
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
    syncDeviceRow: row => { const item = new Element(); item.dataset.key = row.key; return item; },
    updateSyncDeviceRow() {}
  });
  vm.runInContext(`let syncPanelListScope = '';
${functionSource('renderSyncPanelDevices', 'syncDeviceRow')}`, context);
  const [row] = panelApi.deviceRows([{ deviceId: 'remote', receivedAt: '2026-10-02T00:00:00Z' }]);
  context.renderSyncPanelDevices([row]);
  const existing = list.children[0];
  context.renderSyncPanelDevices([{ ...row, syncedAt: '2026-10-02T00:01:00Z' }]);
  assert.equal(list.children[0], existing);
});
