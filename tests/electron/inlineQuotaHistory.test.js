'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHistoryReader } = require('../../src/electron/renderer/limits/inlineHistory');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('inline history rejects a late account/backend read and preserves only same-scope superseded data', async () => {
  const pending = [];
  const states = [];
  const reader = createHistoryReader({ read: key => new Promise(resolve => pending.push({ key, resolve })), onChange: state => states.push(state) });
  reader.update('a', 'source-a', 1); await tick();
  reader.update('b', 'source-a', 1); await tick();
  pending[0].resolve({ key: 'a' }); await tick();
  assert.equal(states.at(-1).payload, null);
  pending[1].resolve({ key: 'b' }); await tick();
  assert.equal(states.at(-1).payload.key, 'b');
  reader.update('b', 'source-a', 2); await tick();
  pending[2].resolve(undefined); await tick();
  assert.equal(states.at(-1).payload.key, 'b');
  reader.update('b', 'source-b', 2); await tick();
  assert.equal(states.at(-1).payload, null);
  pending[3].resolve(undefined); await tick();
  assert.equal(states.at(-1).payload, null);
  reader.update('b', 'source-b', 3); await tick();
  pending[4].resolve({ key: 'b' }); await tick();
  reader.update('b', 'source-b', 4); await tick();
  pending[5].resolve(null); await tick();
  assert.equal(states.at(-1).payload, null);
});

test('inline history failure remains unavailable and does not retry on every repaint', async () => {
  let calls = 0;
  let latest;
  const reader = createHistoryReader({ read: async () => { calls++; throw Error('read failure'); }, onChange: state => { latest = state; } });
  reader.update('a', 'source-a', 1); await tick();
  assert.equal(latest.error, true);
  assert.equal(latest.payload, null);
  reader.update('a', 'source-a', 1); await tick();
  assert.equal(calls, 1);
});

test('read-only quota history IPC accepts the main widget and bounded keys only', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('limitsHistory:read'");
  const end = source.indexOf('\n  });', start) + '\n  });'.length;
  const mainWindow = {};
  let handler;
  const calls = [];
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle(_name, fn) { handler = fn; } }, mainWindow,
    BrowserWindow: { fromWebContents: sender => sender.owner },
    limitsHistoryPayload: key => { calls.push(key); return { key }; }
  });
  assert.equal(await handler({ sender: { owner: {} } }, 'a'), null);
  assert.equal(await handler({ sender: { owner: mainWindow } }, 'a'.repeat(2049)), null);
  assert.equal(await handler({ sender: { owner: mainWindow } }, {}), null);
  assert.equal((await handler({ sender: { owner: mainWindow } }, 'valid-key')).key, 'valid-key');
  assert.deepEqual(calls, ['valid-key']);
});
