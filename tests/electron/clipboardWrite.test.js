'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function clipboardHandler(writeText) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('clipboard:write',");
  const end = source.indexOf("  ipcMain.handle('app:openExternal',", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    clipboard: { writeText },
    ipcMain: { handle: (_channel, callback) => { handler = callback; } }
  });
  return handler;
}

test('clipboard IPC reports success only after Electron finishes writing', async () => {
  let finish;
  const write = new Promise((resolve) => { finish = resolve; });
  const handler = clipboardHandler((text) => {
    assert.equal(text, 'copy this');
    return write;
  });
  let completed = false;
  const result = Promise.resolve(handler(null, 'copy this')).then((value) => {
    completed = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  finish();
  assert.equal(await result, true);
});

test('clipboard IPC propagates a failed Electron write', async () => {
  const failure = new Error('clipboard unavailable');
  const handler = clipboardHandler(() => Promise.reject(failure));
  await assert.rejects(handler(null, 'text'), (error) => error === failure);
});
