'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  actionWindowForEvent,
  handoffWindow,
  showWindow
} = require('../../src/electron/windowLifecycle');

class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.destroyed = options.destroyed === true;
    this.visible = options.visible === true;
    this.destroyCalls = 0;
    this.focusCalls = 0;
    this.showCalls = 0;
    this.showInactiveCalls = 0;
  }

  destroy() { this.destroyCalls += 1; this.destroyed = true; }
  focus() { this.focusCalls += 1; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  show() { this.showCalls += 1; this.visible = true; this.emit('show'); }
  showInactive() { this.showInactiveCalls += 1; this.visible = true; this.emit('show'); }
}

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; }
  };
}

test('inactive reveal relies on the window show lifecycle without emitting a duplicate', () => {
  const win = new FakeWindow();
  let showEvents = 0;
  win.on('show', () => { showEvents += 1; });

  showWindow(win, true);
  assert.equal(win.showInactiveCalls, 1);
  assert.equal(win.showCalls, 0);
  assert.equal(showEvents, 1);
});

test('reveal skips visible and destroyed windows and falls back to show when needed', () => {
  const visible = new FakeWindow({ visible: true });
  const destroyed = new FakeWindow({ destroyed: true });
  const fallback = new FakeWindow();
  fallback.showInactive = undefined;

  showWindow(visible, true);
  showWindow(destroyed, true);
  showWindow(fallback, true);
  assert.equal(visible.showInactiveCalls, 0);
  assert.equal(destroyed.showInactiveCalls, 0);
  assert.equal(fallback.showCalls, 1);
});

test('window handoff releases the old window when the replacement is shown', () => {
  const oldWindow = new FakeWindow();
  const nextWindow = new FakeWindow();
  const timers = fakeTimers();

  handoffWindow(oldWindow, nextWindow, {
    focus: true,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });

  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 3000);
  nextWindow.emit('show');
  assert.equal(oldWindow.destroyCalls, 1);
  assert.equal(nextWindow.focusCalls, 1);
  assert.equal(timers.scheduled[0].cleared, true);

  timers.scheduled[0].fn();
  assert.equal(oldWindow.destroyCalls, 1);
});

test('window handoff uses the fallback when show never arrives', () => {
  const oldWindow = new FakeWindow();
  const nextWindow = new FakeWindow();
  const timers = fakeTimers();

  handoffWindow(oldWindow, nextWindow, {
    focus: true,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });
  timers.scheduled[0].fn();

  assert.equal(oldWindow.destroyCalls, 1);
  assert.equal(nextWindow.focusCalls, 1);
  assert.equal(nextWindow.listenerCount('show'), 0);
  nextWindow.emit('show');
  assert.equal(oldWindow.destroyCalls, 1);
  assert.equal(nextWindow.focusCalls, 1);
});

test('window handoff releases immediately for visible or unusable replacements', () => {
  const visibleOld = new FakeWindow();
  const visibleNext = new FakeWindow({ visible: true });
  const visibleTimers = fakeTimers();
  handoffWindow(visibleOld, visibleNext, {
    focus: true,
    setTimeout: visibleTimers.setTimeout,
    clearTimeout: visibleTimers.clearTimeout
  });
  assert.equal(visibleOld.destroyCalls, 1);
  assert.equal(visibleNext.focusCalls, 1);
  assert.equal(visibleTimers.scheduled.length, 0);

  const missingOld = new FakeWindow();
  handoffWindow(missingOld, null);
  assert.equal(missingOld.destroyCalls, 1);

  const destroyedOld = new FakeWindow();
  handoffWindow(destroyedOld, new FakeWindow({ destroyed: true }));
  assert.equal(destroyedOld.destroyCalls, 1);
});

test('window actions prefer the sender window and ignore destroyed targets', () => {
  const sender = {};
  const senderWindow = new FakeWindow();
  const fallbackWindow = new FakeWindow();
  const BrowserWindow = {
    fromWebContents(contents) { return contents === sender ? senderWindow : null; }
  };

  assert.equal(actionWindowForEvent(BrowserWindow, { sender }, fallbackWindow), senderWindow);

  senderWindow.destroyed = true;
  assert.equal(actionWindowForEvent(BrowserWindow, { sender }, fallbackWindow), null);
});

test('window actions fall back only when the sender has no owning window', () => {
  const fallbackWindow = new FakeWindow();
  const BrowserWindow = { fromWebContents: () => null };

  assert.equal(actionWindowForEvent(BrowserWindow, { sender: {} }, fallbackWindow), fallbackWindow);

  fallbackWindow.destroyed = true;
  assert.equal(actionWindowForEvent(BrowserWindow, {}, fallbackWindow), null);
  assert.equal(actionWindowForEvent(BrowserWindow, {}, null), null);
});
