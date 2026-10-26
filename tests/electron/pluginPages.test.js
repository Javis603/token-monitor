'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createPluginPages } = require('../../src/electron/plugins/pages');
function fixture(options = {}) {
  const handlers = new Map(), windows = [], demands = [], messages = [];
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.visible = false; this.minimized = false; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: windows.length, mainFrame: {}, getZoomFactor: () => 1, isDestroyed: () => this.isDestroyed(), setWindowOpenHandler() {}, send: (channel, payload) => messages.push({ channel, payload }) }); }
    isDestroyed() { return Boolean(this.dead); } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    show() { this.visible = true; this.emit('show'); } hide() { this.visible = false; if (!this.silentVisibility) this.emit('hide'); }
    minimize() { this.minimized = true; if (!this.silentVisibility) this.emit('minimize'); } restore() { this.minimized = false; this.emit('restore'); }
    getContentSize() { return [880, 640]; }
    contentView = { addChildView() {}, removeChildView() {} };
    static fromWebContents(sender) { return windows.find(win => win.webContents === sender); }
    focus() {} loadFile() { return Promise.resolve(); }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const plugin = { id: 'demo', name: 'Demo', status: 'active', views: [
    { ref: 'demo/first', title: 'First', surfaces: ['page'] }, { ref: 'demo/second', title: 'Second', surfaces: ['page'] }] };
  const manager = options.manager || { payload: surface => ({ surface, views: Object.fromEntries((demands.at(-1)?.[1] || []).map(ref => [ref, { ref, status: 'ok' }])) }), list: () => ({ plugins: [plugin] }), onViews: () => () => {}, onChanged: () => () => {}, setSurfaceDemand: (surface, refs) => demands.push([surface, refs]) };
  const ipcMain = { handle: (id, fn) => handlers.set(id, fn), removeHandler: id => handlers.delete(id) };
  const pages = createPluginPages({ BrowserWindow: Window, ipcMain, manager,
    getSettings: options.getSettings || (() => ({ themeColors: { accent: '#abcdef' }, interfaceFontFamily: 'Georgia', displayFontFamily: 'Arial', reduceMotion: 'on', tokenNumberAnimation: 'count', secret: 'never expose' })), getLocale: () => 'en' });
  return { pages, handlers, windows, demands, messages, manager, Window, ipcMain };
}
test('independent plugin pages follow native visibility and reuse their window', () => {
  const f = fixture(); f.pages.open('demo/first'); const win = f.windows[0]; win.emit('ready-to-show');
  assert.deepEqual(f.demands.at(-1), ['page', ['demo/first']]);
  assert.equal(f.messages.at(-1).payload.views['demo/first'].status, 'ok');
  win.minimize(); assert.deepEqual(f.demands.at(-1), ['page', []]);
  f.pages.open('demo/second'); assert.equal(f.windows.length, 1); assert.deepEqual(f.demands.at(-1), ['page', ['demo/second']]);
  win.hide(); assert.deepEqual(f.demands.at(-1), ['page', []]);
  win.show(); win.destroy(); assert.deepEqual(f.demands.at(-1), ['page', []]); f.pages.dispose();
});
test('page IPC accepts only its native sender and views of the same plugin', () => {
  const f = fixture(); f.pages.open('demo/first'); const event = { sender: f.windows[0].webContents };
  assert.throws(() => f.handlers.get('pluginPage:metadata')({ sender: {} }), /not a plugin page/);
  assert.throws(() => f.handlers.get('pluginPage:select')(event, 'other/first'), /does not belong/);
  const metadata = f.handlers.get('pluginPage:metadata')(event);
  assert.equal(metadata.secret, undefined);
  assert.deepEqual(metadata.appearance, { interfaceFontFamily: 'Georgia', displayFontFamily: 'Arial', textSize: undefined, reduceMotion: 'on', tokenNumberAnimation: 'count' });
  assert.equal(f.handlers.get('pluginPage:select')(event, 'demo/second').ref, 'demo/second'); f.pages.dispose();
});
