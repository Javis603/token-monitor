'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { captureWindowViewState, restoreWindowViewState } = require('../../src/electron/renderer/windowViewState');

test('native transfer restores scroll and focus before the next paint without serializing DOM references', async () => {
  const focuses = [];
  const scroll = { isConnected: true, scrollTop: 120, scrollLeft: 30 };
  const removed = { isConnected: true, scrollTop: 15, scrollLeft: 0 };
  const active = { isConnected: true, focus: options => focuses.push(options) };
  const frames = [];
  const context = vm.createContext({ document: { activeElement: active, querySelectorAll: () => [active, scroll, removed] },
    requestAnimationFrame: callback => frames.push(callback) });
  vm.runInContext(`(${captureWindowViewState.toString()})()`, context);
  scroll.scrollTop = 0; scroll.scrollLeft = 0; removed.isConnected = false; removed.scrollTop = 0;
  const restore = vm.runInContext(`(${restoreWindowViewState.toString()})()`, context);
  assert.equal(scroll.scrollTop, 0);
  frames.shift()();
  await restore;
  assert.equal(scroll.scrollTop, 120); assert.equal(scroll.scrollLeft, 30);
  assert.equal(removed.scrollTop, 0, 'detached controls are not restored');
  assert.equal(focuses[0].preventScroll, true);
  assert.equal(vm.runInContext("globalThis[Symbol.for('token-monitor.window-view-state')].transferring", context), false);
});

test('a hidden host restores without waiting for animation frames that cannot run', async () => {
  const scroll = { isConnected: true, scrollTop: 50, scrollLeft: 0 };
  const context = vm.createContext({ document: { activeElement: null, querySelectorAll: () => [scroll] },
    requestAnimationFrame: () => { throw new Error('hidden frames are paused'); } });
  vm.runInContext(`(${captureWindowViewState.toString()})()`, context);
  scroll.scrollTop = 0;
  await vm.runInContext(`(${restoreWindowViewState.toString()})({afterPaint:false})`, context);
  assert.equal(scroll.scrollTop, 50);
});

test('collapsed transfers keep the expanded viewport without resuming ordinary hidden rendering', async () => {
  const scroll = { isConnected: true, scrollTop: 120, scrollLeft: 0 };
  const context = vm.createContext({ document: { hidden: true, activeElement: null, querySelectorAll: () => [scroll] },
    state: { windowVisible: false } });
  vm.runInContext(`(${captureWindowViewState.toString()})()`, context);
  scroll.scrollTop = 0;
  await vm.runInContext(`(${restoreWindowViewState.toString()})({afterPaint:false,restoreViewport:false})`, context);
  assert.equal(scroll.scrollTop, 0, 'collapsed layout must not receive the expanded viewport');
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const hidden = app.slice(app.indexOf('function isRendererWindowHidden()'), app.indexOf('function visibleStatsSurface()'));
  vm.runInContext(hidden, context);
  assert.equal(vm.runInContext('isRendererWindowHidden()', context), true);
  await vm.runInContext(`(${restoreWindowViewState.toString()})({afterPaint:false})`, context);
  assert.equal(scroll.scrollTop, 120);
  assert.equal(vm.runInContext('isRendererWindowHidden()', context), true, 'ordinary hidden windows stop rendering again');
});

test('native host visibility does not refill settings drafts, while pending settings changes still sync', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const guard = app.slice(app.indexOf('function isNativeWindowTransfer()'), app.indexOf('function isRendererWindowHidden()'));
  const handler = app.slice(app.indexOf('function handleWindowVisibilityChange()'), app.indexOf("document.addEventListener('visibilitychange'", app.indexOf('function handleWindowVisibilityChange()')));
  let syncs = 0;
  let flushes = 0;
  const context = vm.createContext({
    state: { settings: { hubMode: 'local' }, floatingBubble: {} }, els: {}, settingsDomSyncPending: false,
    syncPluginTrayDemand() {}, pluginViewHost: null,
    statsRenderScheduler: { visibilityChanged: () => true, flush: () => flushes++ },
    isRendererWindowHidden: () => false, applyFloatingBubbleState() {},
    isSettingsSurfaceVisible: () => true, syncSettingsForm: () => syncs++,
    renderConnectionStatus() {}, signalContentReady() {}, ensureServiceStatusTicker() {}
  });
  vm.runInContext(guard + handler, context);
  vm.runInContext("globalThis[Symbol.for('token-monitor.window-view-state')] = {transferring:true}; handleWindowVisibilityChange()", context);
  assert.equal(syncs, 0, 'native reparenting must preserve unfinished form fields');
  assert.equal(flushes, 1, 'visible content still paints');
  context.settingsDomSyncPending = true;
  vm.runInContext('handleWindowVisibilityChange()', context);
  assert.equal(syncs, 1, 'actual settings changes are not discarded');
  context.settingsDomSyncPending = false;
  vm.runInContext("globalThis[Symbol.for('token-monitor.window-view-state')].transferring=false; handleWindowVisibilityChange()", context);
  assert.equal(syncs, 2, 'ordinary visibility resumes normal settings synchronization');
});
