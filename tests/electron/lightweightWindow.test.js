'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLightweightWindow, LIGHTWEIGHT_IDLE_MS } = require('../../src/electron/lightweightWindow');

function fixture() {
  const timers = new Map();
  const releases = [];
  let sequence = 0;
  const state = { enabled: true, visible: false, minimized: false, destroyed: false, prepare: async () => ({ scrollTop: 12 }) };
  const win = { isVisible: () => state.visible, isMinimized: () => state.minimized, isDestroyed: () => state.destroyed };
  state.win = win;
  const controller = createLightweightWindow({
    getWindow: () => state.win,
    enabled: () => state.enabled,
    prepare: (...args) => state.prepare(...args),
    release: (...args) => { releases.push(args); state.destroyed = true; },
    setTimer: (callback, ms) => { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  const fire = async () => {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    await timer.callback();
  };
  return { controller, state, win, timers, releases, fire };
}

test('hidden windows release after one minute; background stats do not postpone the deadline', async () => {
  const f = fixture();
  f.controller.schedule();
  const first = [...f.timers.keys()][0];
  for (let i = 0; i < 30; i += 1) f.controller.schedule();
  assert.deepEqual([...f.timers.keys()], [first]);
  assert.equal(f.timers.get(first).ms, LIGHTWEIGHT_IDLE_MS);
  await f.fire();
  assert.deepEqual(f.releases, [[f.win, { scrollTop: 12 }]]);
  assert.equal(f.controller.isReleased(f.win), true);
});

test('disabled, visible and minimized windows never arm reclamation', () => {
  for (const state of [{ enabled: false }, { visible: true }, { minimized: true }]) {
    const f = fixture();
    Object.assign(f.state, state);
    f.controller.schedule();
    assert.equal(f.timers.size, 0);
  }
});

test('warm reopen cancels the timer and the next hide gets a full grace period', async () => {
  const f = fixture();
  f.controller.schedule();
  const stale = [...f.timers.values()][0].callback;
  f.controller.cancel();
  await stale();
  assert.equal(f.releases.length, 0);
  f.controller.schedule();
  assert.equal(f.timers.size, 1);
  await f.fire();
  assert.equal(f.releases.length, 1);
});

test('renderer drafts and timeouts retain the UI and retry after another minute', async () => {
  for (const prepare of [async () => null, async () => { throw new Error('timeout'); }]) {
    const f = fixture();
    f.state.prepare = prepare;
    f.controller.schedule();
    await f.fire();
    assert.equal(f.releases.length, 0);
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].ms, LIGHTWEIGHT_IDLE_MS);
  }
});

test('show, disable, replacement and quit fence an in-flight renderer response', async () => {
  for (const change of [
    (f) => { f.state.visible = true; f.controller.cancel(); },
    (f) => { f.state.enabled = false; },
    (f) => { f.state.win = { ...f.win }; },
    (f) => f.controller.stop()
  ]) {
    const f = fixture();
    let answer;
    f.state.prepare = () => new Promise((resolve) => { answer = resolve; });
    f.controller.schedule();
    const pending = f.fire();
    change(f);
    answer({ scrollTop: 99 });
    await pending;
    assert.equal(f.releases.length, 0);
    assert.equal(f.controller.isReleased(f.win), false);
  }
});

test('stats arriving during the veto handshake keep the same reclamation attempt', async () => {
  const f = fixture();
  let answer;
  f.state.prepare = () => new Promise((resolve) => { answer = resolve; });
  f.controller.schedule();
  const pending = f.fire();
  f.controller.schedule();
  assert.equal(f.timers.size, 0);
  answer({ scrollTop: 42 });
  await pending;
  assert.equal(f.releases.length, 1);
});

test('loss of the tray/painter at the deadline cannot wedge later reclamation', async () => {
  const f = fixture();
  f.controller.schedule();
  f.state.enabled = false;
  await f.fire();
  assert.equal(f.releases.length, 0);
  f.state.enabled = true;
  f.controller.schedule();
  assert.equal(f.timers.size, 1);
  await f.fire();
  assert.equal(f.releases.length, 1);
});

test('actual Windows/Linux quit guards distinguish reclamation from user close and quit', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const create = source.slice(source.indexOf('function createWindow('), source.indexOf('function handleZoomShortcut('));
  const closed = create.match(/win\.on\('closed', \(\) => \{[\s\S]*?\n {2}\}\);/)[0];
  const allClosed = source.match(/app\.on\('window-all-closed', \(\) => \{[\s\S]*?\n\}\);/)[0];
  for (const platform of ['win32', 'linux']) {
    let quitCalls = 0;
    const callbacks = {};
    const context = {
      win: { on: (name, callback) => { callbacks[name] = callback; } },
      app: { on: (name, callback) => { callbacks[name] = callback; }, quit: () => { quitCalls += 1; } },
      process: { platform }, quitRequested: false,
      settings: { lightweightMode: true }, tray: { isDestroyed: () => false },
      BrowserWindow: { getAllWindows: () => [{}] },
      backgroundOwnedWindow: () => true,
      lightweightWindow: { isReleased: () => true }
    };
    vm.runInNewContext(closed + '\n' + allClosed, context);
    callbacks.closed();
    callbacks['window-all-closed']();
    assert.equal(quitCalls, 0, `${platform}: an idle release preserves background work`);
    context.lightweightWindow.isReleased = () => false;
    callbacks.closed();
    assert.equal(quitCalls, 1, `${platform}: a real close still quits with only utility windows`);
    context.tray = null;
    callbacks['window-all-closed']();
    assert.equal(quitCalls, 2, `${platform}: no tray means no background-only keepalive`);
    context.tray = { isDestroyed: () => false };
    context.quitRequested = true;
    callbacks['window-all-closed']();
    assert.equal(quitCalls, 3, `${platform}: an explicit quit is never held open`);
  }
});
