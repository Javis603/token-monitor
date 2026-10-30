'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createPluginRuntime } = require('../../src/electron/plugins/runtime');
function fakeFork(children, { delayedExit = false } = {}) {
  return () => {
    const child = new EventEmitter(); child.messages = []; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { if (!child.exited) { child.exited = true; child.emit('exit', 0); } };
    child.postMessage = message => {
      child.messages.push(message);
      if (message.type === 'stop' && !delayedExit) queueMicrotask(child.kill);
      if (message.type === 'call') queueMicrotask(() => child.emit('message', { type: 'reply', id: message.id, value: message.args }));
    };
    children.push(child); queueMicrotask(() => child.emit('message', { type: 'ready' })); return child;
  };
}
async function runtimeFixture(t, { initialSettings = {}, catalogFetch = async () => { throw Error('fixture offline'); }, Notification, safeMode = false, delayedExit = false, businessAdapters = {}, surfaceContext, beforeStart = () => {}, sourceDirectory = path.resolve(__dirname, '../fixtures/trusted-plugin') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-test-'));
  const handlers = new Map(), events = new Map(), children = [], windows = [];
  let settings = { pluginInitialSetup: {}, themeColors: {}, vendorColors: {}, pluginAuthorSkin: null, pluginsEnabled: true, pluginStates: {}, homeModuleOrder: 'plugin:trusted-fixture/panel', pluginMainPages: ['trusted-fixture/panel'], notchPluginPages: ['trusted-fixture/panel'], ...initialSettings };
  let confirmation = 1; const confirmations = [], dialogs = [];
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); this.visible = true; this.minimized = false; this.destroyed = false;
      this.webContents = new EventEmitter(); const wc = this.webContents;
      wc.id = windows.length + 1; wc.mainFrame = {}; wc.sent = []; wc.reloads = 0;
      wc.send = (channel, value) => wc.sent.push({ channel, value }); wc.isDestroyed = () => this.destroyed;
      wc.reload = () => { wc.reloads++; wc.emit('did-start-navigation', {}, '', false, true); };
      wc.setWindowOpenHandler = () => {}; windows.push(this);
    }
    static fromWebContents(wc) { return windows.find(win => win.webContents === wc); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    show() { this.visible = true; this.emit('show'); } hide() { this.visible = false; this.emit('hide'); }
    restore() { this.minimized = false; this.emit('restore'); } focus() {} loadFile() { return Promise.resolve(); }
    destroy() { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
  }
  const main = new BrowserWindow(), notch = new BrowserWindow();
  const electron = { BrowserWindow, Notification, utilityProcess: { fork: fakeFork(children, { delayedExit }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name), on: (name, fn) => events.set(name, fn), removeListener: name => events.delete(name) },
    session: { fromPartition: () => ({ fetch: catalogFetch }), defaultSession: { protocol: { handle() {}, unhandle() {} } } },
    dialog: { showMessageBox: async (_win, options) => { dialogs.push(options); return { response: confirmations.length ? confirmations.shift() : confirmation }; }, showOpenDialog: async () => ({ canceled: false, filePaths: [sourceDirectory] }) } };
  beforeStart(dir);
  const runtime = createPluginRuntime({ electron, businessAdapters, userDataDir: dir, getSettings: () => settings, getAppSettings: () => ({ public: true }), getContext: () => ({ source: 'fixture' }), getLocale: () => 'en',
    applySettingsPatch: patch => { settings = { ...settings, ...patch }; }, persistManagementSettings: patch => { settings = { ...settings, ...patch }; }, persistPluginStates: value => { settings.pluginStates = value; },
    isMainSender: event => event.sender === main.webContents, isSurfaceSender: event => event.sender === notch.webContents,
    surfaceContext: surfaceContext || (() => ({ visible: notch.visible, preparing: false })), env: { TOKEN_MONITOR_PLUGINS_SAFE_MODE: safeMode ? '1' : '0' }, log() {} });
  await runtime.start();
  t.after(async () => { for (const child of children) child.kill(); await runtime.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const invoke = (name, ...args) => handlers.get(name)(event(main), ...args);
  const send = (win, surface, refs = ['trusted-fixture/panel']) => events.get(win === main ? 'plugins:demand' : 'topNotch:pluginDemand')(event(win), { surface, refs });
  async function install() { const preview = await invoke('plugins:import', 'directory'); await invoke('plugins:install', preview.token); }
  async function setMasterEnabled(enabled) {
    const finish = await runtime.beforeSettingsChange(event(main), { pluginsEnabled: enabled });
    settings = { ...settings, pluginsEnabled: enabled }; runtime.settingsChanged(); await finish();
  }
  return { dir, runtime, children, handlers, events, main, notch, windows, invoke, send, install, setMasterEnabled, event,
    get settings() { return settings; }, dialogs, respond(...responses) { confirmations.push(...responses); }, cancel() { confirmation = 0; }, accept() { confirmation = 1; },
    lifecycle(win, callback, ids = ['trusted-fixture']) {
      const original = win.webContents.send;
      win.webContents.send = (channel, value) => {
        original(channel, value);
        if (channel === 'plugins:lifecycle') queueMicrotask(async () => {
          try { events.get('plugins:lifecycleReply')?.(event(win), { request: value.request, value: await callback(value) }); }
          catch (error) { events.get('plugins:lifecycleReply')?.(event(win), { request: value.request, error: error.message }); }
        });
      };
      events.get('plugins:lifecycleHost')(event(win), true);
      for (const id of ids) events.get('plugins:uiLoading')?.(event(win), id);
    } };
}
module.exports = { fakeFork, runtimeFixture };
