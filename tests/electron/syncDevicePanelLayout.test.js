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
  prepend(...children) { children.forEach(child => { child.parentElement = this; }); this.children.unshift(...children); }
  addEventListener() {}
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

test('sync settings draw one map from the target to its devices, with preferences after it', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const start = html.indexOf('id="syncSettingsDetails"');
  const end = html.indexOf('<section class="total-panel">', start);
  const section = html.slice(start, end);
  const order = ['syncMap', 'hubModeOptions', 'syncLocalIntro', 'syncPanelConnection', 'hubUrlInput', 'hubHostFields', 'icloudFields',
    'saveSettingsButton', 'syncDevicePanel', 'syncThisDeviceCard', 'deviceIconLocalRow', 'syncUploadIntervalRow', 'syncContentDetails'];
  const positions = order.map(id => section.indexOf(`id="${id}"`));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  // The device list and the save form live inside the map; preferences do not.
  const map = section.slice(section.indexOf('id="syncMap"'), section.indexOf('id="syncThisDeviceCard"'));
  assert.match(map, /^id="syncMap" class="settings-page-card sync-map"/);
  assert.ok(map.includes('id="syncDevicePanel"') && map.includes('id="syncDeviceSettings"'));
  assert.deepEqual([...section.matchAll(/data-sync-icon="(\w+)"/g)].map(match => match[1]), ['client', 'host', 'icloud']);
  assert.match(section, /id="syncLocalIntro"[^>]*data-sync-modes="local"/);
  assert.equal((section.match(/id="syncPanelConnection"/g) || []).length, 1);
  assert.doesNotMatch(section.slice(0, section.indexOf('id="syncContentDetails"')), /<summary|syncConnectionSettings|syncConnectionMode/);
  assert.match(section, /id="syncContentToggle"[^>]*class="settings-group-header cursor-settings-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="syncContentDetails"/);
  assert.match(section, /id="syncContentDetails" class="cursor-settings-details hidden" inert/);
  assert.match(section, /class="sync-mode-select"[\s\S]*?<select id="hubModeOptions"[\s\S]*?<span class="settings-section-disclosure" aria-hidden="true">/);
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /\.settings-sync-group\.expanded[^}]*\.settings-section-summary\s*\{\s*display:\s*none/);
  // The rail reaches the target only while nothing sits between them, and stops at the last device.
  assert.match(css, /\.sync-map:has\(\.sync-device-row\):not\(:has\(> #syncDeviceSettings:not\(\[hidden\]\)\)\) \{ --rail-link: var\(--rail\); \}/);
  assert.match(css, /\.sync-map \.sync-device-row:first-child \{ --rail-above: var\(--rail-link\); \}/);
  assert.match(css, /\.sync-map \.sync-device-row:last-child \{ --rail-below: transparent; \}/);
  // Collapsing a mode's fields must also collapse the space below them.
  assert.match(css, /\.sync-map-hub > \.accordion-animation-inner::after \{ content: ""; height: 12px; \}/);
  const mode = functionSource('syncHubModeUi', 'renderIcloudStatus');
  assert.match(mode, /node\.hidden = !shown;\s*node\.inert = !shown;/);
  assert.match(appSource, /for \(const slot of document\.querySelectorAll\('\[data-sync-icon\]'\)\) slot\.replaceChildren\(syncModeIcons\[slot\.dataset\.syncIcon\]\(document\)\);/);
});

test('sync edit and removal actions use local SVG masks without replacing their text labels', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const notices = fs.readFileSync(path.join(rendererDir, 'icons/THIRD_PARTY_NOTICES.md'), 'utf8');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.match(html, /id="syncConnectionEdit"[^>]*data-i18n="settings\.sync\.editConnection"[^>]*data-i18n-aria-label="settings\.sync\.editConnection"[^>]*>Change connection<\/button>/);
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
  assert.match(html, /class="sync-node-icon">\s*<span id="syncPanelSignal"[\s\S]*?class="sync-connection-heading">\s*<div id="syncConnectionIdentity"[\s\S]*?id="syncPanelState"/);
  assert.match(css.match(/\.sync-connection-heading\s*\{([^}]+)\}/)?.[1], /align-items:\s*center/);
  assert.doesNotMatch(css.match(/\.sync-panel-signal\s*\{([^}]+)\}/)?.[1], /margin-top/);
  assert.match(css.match(/\.sync-connection-identity\s*\{([^}]+)\}/)?.[1], /display:\s*flex/);
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
  const surface = rule('.plugin-menu,\n.view-switcher-menu,\n.select-control-popup,\n.appearance-color-picker,\n.sync-content-dialog,\n.plugin-catalog-dialog,\n.settings-help-popover,\n.app-update-popover');
  assert.ok(surface);
  for (const property of ['border', 'border-radius', 'background', 'box-shadow', 'backdrop-filter']) {
    assert.ok(surface.includes(`${property}:`), property);
  }
  assert.match(surface, /var\(--glass-rgb\)/);
  assert.doesNotMatch(rule('.plugin-menu'), /background:|border-radius:|box-shadow:/);
  assert.doesNotMatch(rule('.select-control-popup'), /background:|border-radius:|box-shadow:/);
  assert.doesNotMatch(rule('.sync-content-dialog,\n.settings-help-popover'), /background:|border-radius:|box-shadow:/);
  assert.doesNotMatch(rule('.view-switcher-menu'), /background:|border-radius:|box-shadow:/);
  assert.ok(rule('html.native-liquid-glass .plugin-menu,\nhtml.native-liquid-glass .select-control-popup,\nhtml.native-liquid-glass .appearance-color-picker,\nhtml.native-liquid-glass .view-switcher-menu,\nhtml.native-liquid-glass .sync-content-dialog,\nhtml.native-liquid-glass .plugin-catalog-dialog,\nhtml.native-liquid-glass .settings-help-popover,\nhtml.native-liquid-glass .app-update-popover'));
  assert.ok(rule('html.native-liquid-glass .plugin-menu button,\nhtml.native-liquid-glass .select-control-option,\nhtml.native-liquid-glass .view-switcher-menu-item'));
  const selected = '.select-control-option[data-selected="true"]';
  const highlighted = '.select-control-option[data-highlighted="true"]';
  assert.match(rule(selected), /var\(--accent-rgb\), 0\.12/);
  assert.match(rule(selected), /color:\s*var\(--accent\)/);
  assert.equal(rule(selected).trim().replace(/\s+/g, ' '), rule('.view-switcher-menu-item.is-current').trim().replace(/\s+/g, ' '));
  assert.match(rule(highlighted), /0\.07/);
  assert.ok(css.indexOf(`${selected} {`) > css.indexOf(`${highlighted} {`), 'selection wins when the same row is highlighted');
  assert.match(rule('.view-switcher-menu-item.is-current'), /0\.12/);
  assert.doesNotMatch(css, /\.select-control-option(?:\[data-selected="true"\])?::after/);
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
    const localIntro = { dataset: { syncModes: 'local' } };
    const context = vm.createContext({
      syncContentForm: null,
      state: { settings: { hubMode: mode }, appInfo: { platform: 'win32' } },
      els: {
        hubModeOptions: {}, icloudModeOption: {},
        hubClientFields: field('client'), hubHostFields: field('host'), icloudFields: field('icloud'),
        hubSecretInput: {}, hubUrlInput: { value: 'https://draft.test' }, secretInput: { value: 'draft' },
        syncMap: { querySelectorAll: () => [localIntro] }
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
    for (const id of ['client', 'host', 'icloud']) {
      assert.equal(hidden[id], mode !== id);
      const node = context.els[id === 'client' ? 'hubClientFields' : id === 'host' ? 'hubHostFields' : 'icloudFields'];
      assert.equal(node.inert, mode !== id);
    }
    assert.equal(context.els.hubUrlInput.value, 'https://draft.test');
    assert.equal(context.els.secretInput.value, 'draft');
    assert.equal(localIntro.hidden, mode !== 'local');
    assert.equal(localIntro.inert, mode !== 'local');
  }
});

test('sync mode enhances the native source with shared icons and translated descriptions', () => {
  const start = appSource.indexOf('const SYNC_MODE_DESCRIPTIONS =');
  const end = appSource.indexOf('function toggleAccordionRow(', start);
  const calls = [];
  const context = vm.createContext({
    window: { TokenMonitorSelectControl: { enhance(select, options) { calls.push({ select, options }); return {}; } }, addEventListener() {} },
    els: { hubModeOptions: {} },
    document: { querySelectorAll: () => [] },
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

function hubPairingFixture(loadPairingQr, mode = 'host') {
  const lan = { address: '192.168.1.20', interface: 'Wi-Fi' };
  const tailscale = { address: '100.79.20.30', interface: 'Tailscale' };
  const url = mode === 'client' ? 'https://hub.example.com' : `http://${lan.address}:17321`;
  const button = new Element();
  let onClose;
  const dialog = {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    addEventListener(event, handler) { if (event === 'close') onClose = handler; },
    dispatchClose() { onClose(); }
  };
  const editor = { contains: () => false };
  const context = vm.createContext({
    state: {
      settings: { hubMode: mode, hubUrl: url, secret: 'synthetic-client-secret' },
      settingsSections: { sync: true },
      floatingBubble: { collapsed: false, side: null },
      hubInfo: { listening: true, listeningPort: 17321, lanAddresses: [lan, tailscale] }
    },
    els: {
      hubModeOptions: { value: mode }, hubStatusRow: {}, syncConnectionPairPhone: button,
      hubAddressList: { replaceChildren() {} }, hubPairingDialog: dialog,
      hubPairingAddress: {}, hubPairingQr: {}, hubPairingHelp: {}, hubPairingInternetHelp: {},
      hubPairingError: {}, hubSecretInput: { value: 'synthetic-host-secret' },
      hubUrlInput: { value: 'https://draft.example.com' }, secretInput: { value: 'synthetic-draft-secret' },
      syncConnectionEditor: editor, syncDeviceSettings: editor, syncConnectionEdit: {},
      syncConnectionCancel: {}, syncConnectionIdentity: {}, syncConnectionEndpoint: {},
      syncUploadIntervalRow: {}, syncConnectionSaveError: {},
    },
    clientConnectionEditing: false, hubSaveBusy: false, hubSaveError: false,
    visiblyOpen: true, hasDraft: false, clientConnectionHasDraft: () => context.hasDraft,
    document: {
      activeElement: null, createElement: () => new Element(),
      documentElement: { classList: { toggle() {} } }, body: { classList: { toggle() {} } }
    },
    isRendererWindowHidden: () => false, syncPluginTrayDemand() {}, syncPluginLimitsDemand() {},
    loadPairingQr, renderIcloudStatus() {}, setHoverMarqueeText() {}, syncHubProfileControls() {},
    syncDevicePanelApi: panelApi, isSettingsSurfaceVisible: () => context.visiblyOpen && !context.state.floatingBubble.collapsed,
    t: (key, values) => values?.url ? `${key} ${values.url}` : key
  });
  const start = appSource.indexOf('let hubAddressesExpanded =');
  const end = appSource.indexOf('async function copyToClipboard(', start);
  const pairing = appSource.slice(start, end).replace("import('./hubPairingQr.mjs')", 'loadPairingQr()');
  const status = appSource.slice(appSource.indexOf('function renderHubStatus('),
    appSource.indexOf('const SYNC_PANEL_AGE_REFRESH_MS'));
  const connection = functionSource('syncHubConnectionUi', 'syncHubProfileControls');
  const bubbleState = appSource.slice(appSource.indexOf('function applyFloatingBubbleState('),
    appSource.indexOf('const BUBBLE_CONTENT_VALUES'));
  vm.runInContext(status + pairing + connection + bubbleState, context);
  context.renderHubAddresses = () => {};
  return { url, dialog, context, button, lan, tailscale };
}

test('Host Hub pairing still offers private Wi-Fi and Tailscale', async () => {
  const rendered = [];
  const { url, dialog, context, lan, tailscale } = hubPairingFixture(async () => ({
    drawHubPairingQr(_canvas, address, secret) { rendered.push([address, secret]); }
  }));
  for (const { address, interface: label } of [lan, tailscale]) {
    const row = context.hubAddressRow({ address, interface: label }, 17321);
    assert.ok(row.querySelector('.hub-pairing-button'));
  }
  const unsupported = context.hubAddressRow({ address: '203.0.113.15', interface: 'Other' }, 17321);
  assert.equal(unsupported.querySelector('.hub-pairing-button'), null);
  await context.showHubPairingQr(url, { isConnected: true });
  assert.deepEqual(rendered, [[url, 'synthetic-host-secret']]);
  assert.equal(context.els.hubPairingHelp.hidden, false);
  assert.equal(context.els.hubPairingInternetHelp.hidden, true);
  context.renderHubStatus();
  assert.equal(dialog.open, true);

  context.state.hubInfo.listeningPort = 17322;
  context.renderHubStatus();
  assert.equal(dialog.open, false);
  assert.equal(context.els.hubPairingQr.width, 0);
  assert.equal(context.els.hubPairingAddress.textContent, '');
});

test('leaving Host mode while the QR module loads prevents opening the dialog', async () => {
  const loadResults = [
    async () => ({ drawHubPairingQr() { assert.fail('drawing after leaving Host mode'); } }),
    async () => { throw new Error('load failed'); }
  ];
  for (const loadPairingQr of loadResults) {
    const { url, dialog, context } = hubPairingFixture(loadPairingQr);
    const opening = context.showHubPairingQr(url, { isConnected: true });
    context.els.hubModeOptions.value = 'local';
    await opening;
    assert.equal(dialog.open, false);
  }
});

test('client Pair phone encodes only the saved public HTTPS address and secret', async () => {
  const rendered = [];
  const { url, dialog, context, button } = hubPairingFixture(async () => ({
    drawHubPairingQr(_canvas, address, secret) { rendered.push([address, secret]); }
  }), 'client');
  context.syncHubConnectionUi();
  assert.equal(button.hidden, false);
  assert.equal(button['aria-label'], `settings.sync.pairPhoneAt ${url}`);
  await context.showHubPairingQr(context.els.hubUrlInput.value, { isConnected: true });
  assert.equal(dialog.open, false);
  await context.showHubPairingQr(url, { isConnected: true });
  assert.deepEqual(rendered, [[url, 'synthetic-client-secret']]);
  assert.equal(context.els.hubPairingAddress.textContent, url);
  assert.equal(context.els.hubPairingHelp.hidden, true);
  assert.equal(context.els.hubPairingInternetHelp.hidden, false);
  context.syncHubConnectionUi();
  assert.equal(dialog.open, true, 'an unrelated refresh leaves the current dialog open');
});

test('client Pair phone stays hidden for unsupported saved URLs, secrets and open drafts', () => {
  const { url, context, button } = hubPairingFixture(() => assert.fail('encoder loaded'), 'client');
  for (const value of [
    '', 'http://hub.example.com', 'https://192.0.2.1', 'https://[2001:db8::1]', 'https://hub.0x7f',
    'https://localhost', 'https://hub.local', 'https://hub.internal', 'https://hub.ts.net',
    'https://user@hub.example.com', 'https://hub.example.com/api', 'https://hub.example.com/..',
    'https://hub.example.com?', 'https://hub.example.com#', 'https://hub.example.com:0',
    'https://hub.example.com:65536', 'https://-hub.example.com', 'https://hub..example.com',
    'https://hub.example.com/a/../', 'https://hub.example.com\n',
  ]) {
    context.state.settings.hubUrl = value;
    context.syncHubConnectionUi();
    assert.equal(button.hidden, true, value);
  }
  context.state.settings.hubUrl = url;
  for (const secret of ['', '  ', 'has\ncontrol', 'x'.repeat(513)]) {
    context.state.settings.secret = secret;
    context.syncHubConnectionUi();
    assert.equal(button.hidden, true);
  }
  context.state.settings.hubUrl = 'https://hub.example.com:8443/';
  context.state.settings.secret = 'synthetic-client-secret';
  context.syncHubConnectionUi();
  assert.equal(button.hidden, false);
  context.hasDraft = true;
  context.syncHubConnectionUi();
  assert.equal(button.hidden, true);
});

test('client pairing clears the dialog when its saved connection or surface changes', async () => {
  const changes = [
    context => { context.state.settings.hubUrl = 'https://other.example.com'; },
    context => { context.state.settings.secret = 'synthetic-rotated-secret'; },
    context => { context.els.hubModeOptions.value = 'local'; },
    context => { context.state.settings.hubMode = 'host'; },
    context => { context.clientConnectionEditing = true; },
    context => { context.state.settingsSections.sync = false; },
    context => { context.visiblyOpen = false; }
  ];
  for (const change of changes) {
    const { url, dialog, context } = hubPairingFixture(async () => ({
      drawHubPairingQr(canvas) { canvas.width = 100; }
    }), 'client');
    await context.showHubPairingQr(url, { isConnected: true });
    assert.equal(dialog.open, true);
    change(context);
    context.syncHubConnectionUi();
    assert.equal(dialog.open, false);
    assert.equal(context.els.hubPairingQr.width, 0);
    assert.equal(context.els.hubPairingAddress.textContent, '');
  }
});

test('collapsing the floating bubble closes and clears an open pairing QR', async () => {
  for (const mode of ['host', 'client']) {
    const { url, dialog, context } = hubPairingFixture(async () => ({
      drawHubPairingQr(canvas) { canvas.width = 100; }
    }), mode);
    await context.showHubPairingQr(url, { isConnected: true });
    assert.equal(dialog.open, true);
    context.applyFloatingBubbleState({ collapsed: true, side: 'left' }, { renderContent: false });
    assert.equal(dialog.open, false);
    assert.equal(context.els.hubPairingQr.width, 0);
    assert.equal(context.els.hubPairingAddress.textContent, '');
  }
});

test('client pairing discards a pending encoder load when the saved secret changes', async () => {
  const { promise, resolve } = Promise.withResolvers();
  const { url, dialog, context } = hubPairingFixture(() => promise, 'client');
  const opening = context.showHubPairingQr(url, { isConnected: true });
  context.state.settings.secret = 'synthetic-rotated-secret';
  context.syncHubConnectionUi();
  context.state.settings.secret = 'synthetic-client-secret';
  context.syncHubConnectionUi();
  resolve({ drawHubPairingQr() { assert.fail('drawing a cancelled request'); } });
  await opening;
  assert.equal(dialog.open, false);
});

test('a queued dialog close does not discard a new encoder load', async () => {
  const { promise, resolve } = Promise.withResolvers();
  const { url, dialog, context } = hubPairingFixture(() => promise, 'client');
  const opening = context.showHubPairingQr(url, { isConnected: true });
  dialog.dispatchClose();
  resolve({ drawHubPairingQr(canvas) { canvas.width = 100; } });
  await opening;
  assert.equal(dialog.open, true);
  dialog.close();
  dialog.dispatchClose();
  assert.equal(context.els.hubPairingQr.width, 0);
});

test('client pairing clears a partial canvas if the encoder fails', async () => {
  const { url, dialog, context } = hubPairingFixture(async () => ({
    drawHubPairingQr(canvas) { canvas.width = 100; throw new Error('encode failed'); }
  }), 'client');
  await context.showHubPairingQr(url, { isConnected: true });
  assert.equal(dialog.open, true);
  assert.equal(context.els.hubPairingError.hidden, false);
  assert.equal(context.els.hubPairingInternetHelp.hidden, true);
  assert.equal(context.els.hubPairingQr.width, 0);
});

test('the pairing button has a visible keyboard focus outline', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.match(css, /\.hub-pairing-button:focus-visible\s*\{[^}]*outline:\s*1px solid/);
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
  const document = { createElement: () => { const element = new Element(); element.ownerDocument = document; return element; } };
  const context = vm.createContext({
    document,
    state: { settings: {} }, deviceIconsApi: require('../../src/electron/renderer/deviceIcons'),
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
  assert.equal(title.children[0]['aria-label'], 'Long workstation name · workstation.local');
  assert.equal(meta.children.length, 1);
  assert.equal(meta.children[0].textContent, 'Windows 11 25H2 · Widget v0.64.0');
  assert.equal(side.children.length, 2);
  assert.doesNotMatch(appSource, /sync-device-tag/);

  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const metaRule = css.match(/\.sync-device-meta-text\s*\{([^}]+)\}/)?.[1];
  assert.ok(metaRule);
  assert.doesNotMatch(metaRule, /text-overflow:\s*ellipsis|white-space:\s*nowrap/);
  // Status sits on its own third row at every width, so online and offline rows line up.
  assert.match(css.match(/\.sync-device-side\s*\{([^}]+)\}/)?.[1], /grid-column:\s*2 \/ -1;\s*grid-row:\s*3/);
  assert.match(css.match(/\.sync-device-title\s*\{([^}]+)\}/)?.[1], /grid-column:\s*2 \/ -1/);
  assert.doesNotMatch(css, /@container\s*\(max-width:\s*340px\)/);
});

test('empty device list refreshes when the runtime starts syncing', () => {
  const list = new Element();
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    els: { syncDeviceList: list, syncPanelCount: {} },
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

test('sync timestamp changes reuse the device row and pass the latest data to its updater', () => {
  const list = new Element();
  const updates = [];
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    els: { syncDeviceList: list, syncPanelCount: {} },
    state: { mode: 'sync', settings: { hubMode: 'client' } },
    syncDevicePanelApi: panelApi,
    currentLocale: () => 'en',
    availableBreakdownIds: () => ['device'],
    t: key => key,
    devicesBeingDeleted: new Set(),
    resetDeviceDeleteConfirmation() {},
    syncDeviceRow: row => { const item = new Element(); item.dataset.key = row.key; return item; },
    updateSyncDeviceRow(item, row) { updates.push({ item, row }); }
  });
  vm.runInContext(`let syncPanelListScope = '';
${functionSource('renderSyncPanelDevices', 'syncDeviceRow')}`, context);
  const [row] = panelApi.deviceRows([{ deviceId: 'remote', receivedAt: '2026-10-02T00:00:00Z' }]);
  context.renderSyncPanelDevices([row]);
  const existing = list.children[0];
  const latest = { ...row, syncedAt: '2026-10-02T00:01:00Z' };
  context.renderSyncPanelDevices([latest]);
  assert.equal(list.children[0], existing);
  assert.deepEqual(updates, [{ item: existing, row: latest }]);
});
