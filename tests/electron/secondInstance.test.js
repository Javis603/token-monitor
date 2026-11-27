'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const section = (first, next) => main.slice(main.indexOf(first), main.indexOf(next, main.indexOf(first)));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const app = new EventEmitter();
  const windows = [];
  const context = vm.createContext({
    app, setImmediate, mainWindow: null, quitRequested: false, screenUiSuspended: false,
    settings: { trayMode: false }, mainWindowPopoverReveal: null,
    floatingBubbleState: { collapsed: false },
    applyMacActivationPolicy() {}, applyMacSpaceBehavior() {},
    scheduleMainWindowShowSync() {}, restoreWindowMaximized() {},
    createWindow(onConstruct) {
      const win = {
        shows: 0, restores: 0, minimized: false, destroyed: false,
        isDestroyed() { return this.destroyed; },
        isMinimized() { return this.minimized; },
        restore() { this.restores++; this.minimized = false; },
        show() { this.shows++; }
      };
      windows.push(win);
      // A native BaseWindow constructor dispatches second-instance before
      // returning its window to createWindow's mainWindow assignment.
      onConstruct?.();
      context.mainWindow = win;
    }
  });
  vm.runInContext([
    section('function focusExistingWindow()', 'function currentWindowToggleShortcutStatus('),
    section("app.on('second-instance'", "app.on('window-all-closed'")
  ].join('\n'), context);
  return { app, context, windows };
}

test('a second launch during native window construction reuses the completed main window', async () => {
  const { app, context, windows } = fixture();
  context.createWindow(() => {
    app.emit('second-instance');
    app.emit('second-instance');
  });
  await nextTurn();
  assert.equal(windows.length, 1);
  assert.equal(context.mainWindow, windows[0]);
  assert.equal(windows[0].shows, 2);
});

test('a later launch still restores and shows the existing minimized window', async () => {
  const { app, context, windows } = fixture();
  context.createWindow();
  windows[0].minimized = true;
  app.emit('second-instance');
  await nextTurn();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].restores, 1);
  assert.equal(windows[0].shows, 1);
});

test('a queued launch respects quit and screen suspension before reopening', async () => {
  for (const flag of ['quitRequested', 'screenUiSuspended']) {
    const { app, context, windows } = fixture();
    app.emit('second-instance');
    context[flag] = true;
    await nextTurn();
    assert.equal(windows.length, 0);
  }
});
