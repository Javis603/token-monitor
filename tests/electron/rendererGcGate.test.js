'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const start = main.indexOf('function windowShowsRendererContent(');
const end = main.indexOf('\nfunction ', start + 10);
const source = main.slice(start, end);
const context = {};
vm.runInNewContext(`${source}\nthis.windowShowsRendererContent = windowShowsRendererContent;`, context);

const window = (overrides = {}) => ({
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => false,
  getOpacity: () => 1,
  ...overrides
});

test('a visible window showing content blocks the renderer pass', () => {
  assert.equal(context.windowShowsRendererContent(window()), true);
  assert.equal(context.windowShowsRendererContent(window({ getOpacity: () => 0.02 })), true);
});

test('faded cards, hidden windows, minimized windows and destroyed windows do not block it', () => {
  assert.equal(context.windowShowsRendererContent(window({ getOpacity: () => 0 })), false);
  assert.equal(context.windowShowsRendererContent(window({ isVisible: () => false })), false);
  assert.equal(context.windowShowsRendererContent(window({ isMinimized: () => true })), false);
  assert.equal(context.windowShowsRendererContent(window({ isDestroyed: () => true })), false);
  assert.equal(context.windowShowsRendererContent(null), false);
});

test('an unreadable opacity is treated as showing content', () => {
  assert.equal(context.windowShowsRendererContent(window({ getOpacity: () => { throw new Error('gone'); } })), true);
  assert.equal(context.windowShowsRendererContent(window({ getOpacity: undefined })), true);
});

test('collectIdleRendererHeaps uses the content-visible gate', () => {
  assert.match(main, /for \(const win of BaseWindow\.getAllWindows\(\)\) \{[\s\S]*windowShowsRendererContent\(win\)/);
});

function runRendererPass(contents, windows = []) {
  const start = main.indexOf('const IDLE_RENDERER_GC_TIMEOUT_MS');
  const end = main.indexOf('\nfunction ', main.indexOf('function collectIdleRendererHeaps(') + 10);
  const context = {
    BaseWindow: { getAllWindows: () => windows },
    webContents: { getAllWebContents: () => contents },
    setTimeout, clearTimeout, Promise, Set
  };
  vm.runInNewContext(`${main.slice(start, end)}\nthis.collect = collectIdleRendererHeaps;`, context);
  return context.collect();
}

test('a renderer that is still loading is skipped instead of queueing gc for a reveal', async () => {
  let calls = 0;
  await runRendererPass([{
    isDestroyed: () => false,
    isLoading: () => true,
    executeJavaScript: () => { calls += 1; return Promise.resolve(); },
    getOSProcessId: () => 1,
    id: 1
  }]);
  assert.equal(calls, 0);
});

test('a loaded hidden renderer still collects', async () => {
  let calls = 0;
  await runRendererPass([{
    isDestroyed: () => false,
    isLoading: () => false,
    executeJavaScript: () => { calls += 1; return Promise.resolve(true); },
    getOSProcessId: () => 1,
    id: 1
  }]);
  assert.equal(calls, 1);
});
