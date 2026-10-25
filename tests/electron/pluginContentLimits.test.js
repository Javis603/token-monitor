'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { LIMITS, createPluginStorage, performNetRequest, validateMetricValue } = require('../../src/electron/plugins/broker');
const { MAX_BYTES, validMessage } = require('../../src/electron/plugins/host/message');

function memoryFs() {
  const files = new Map();
  return {
    files,
    readFileSync: (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
    writeFileSync: (file, text) => files.set(file, text),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdirSync() {}
  };
}

test('text metrics keep paragraph-length values', () => {
  assert.equal(validateMetricValue('text', 'x'.repeat(4096)).value.length, 4096);
  assert.equal(validateMetricValue('text', 'x'.repeat(5000)).value.length, LIMITS.textChars);
});

test('object metrics carry structured lists up to the IPC envelope', () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Item ${i}`, meta: { tags: ['a', 'b'], score: { value: i } } }));
  const list = validateMetricValue('object', { items });
  assert.equal(list.ok, true, 'a 200-row list with nested fields is accepted');
  const nest = (levels) => Array.from({ length: levels - 1 }).reduce((inner) => ({ child: inner }), { leaf: 1 });
  assert.equal(validateMetricValue('object', nest(LIMITS.objectDepth)).ok, true, `${LIMITS.objectDepth} nested objects are accepted`);
  assert.equal(validateMetricValue('object', nest(LIMITS.objectDepth + 1)).ok, false, 'depth stays bounded');
  // The largest accepted object still fits a Worker publish message.
  const largest = { blob: 'x'.repeat(LIMITS.objectBytes - 20) };
  assert.equal(validateMetricValue('object', largest).ok, true);
  assert.equal(validMessage({ type: 'publish', metric: 'payload', value: largest }), true);
  assert.ok(LIMITS.objectBytes < MAX_BYTES);
  assert.equal(validateMetricValue('object', { blob: 'x'.repeat(LIMITS.objectBytes) }).ok, false, 'larger objects are rejected');
});

for (const [label, character] of [['ASCII', 'x'], ['Chinese', '中'], ['emoji', '😀']]) {
  test(`object metric quota counts UTF-8 bytes at the ${label} boundary`, () => {
    const overhead = Buffer.byteLength(JSON.stringify({ text: '' }), 'utf8');
    for (const delta of [-1, 0, 1]) {
      const payloadBytes = LIMITS.objectBytes + delta - overhead;
      const width = Buffer.byteLength(character, 'utf8');
      const value = { text: character.repeat(Math.floor(payloadBytes / width)) + 'x'.repeat(payloadBytes % width) };
      assert.equal(Buffer.byteLength(JSON.stringify(value), 'utf8'), LIMITS.objectBytes + delta);
      assert.equal(validMessage({ type: 'publish', metric: 'payload', value }), true, 'the outer wire budget must not mask the metric quota');
      const result = validateMetricValue('object', value);
      assert.equal(result.ok, delta <= 0, `${delta} bytes from the quota`);
      if (result.ok) assert.deepEqual(result.value, value);
      else assert.equal(result.error, 'object too large');
    }
  });
}

test('plugin storage holds megabytes and charges each key once', () => {
  const fsImpl = memoryFs();
  const storage = createPluginStorage({ dir: '/data', pluginId: 'notes', fsImpl, flushDelayMs: 60_000 });
  const chunk = 'x'.repeat(60 * 1024);
  let stored = 0;
  try { for (;;) { storage.set(`k${stored}`, chunk); stored += 1; } } catch (error) { assert.match(error.message, /storage quota exceeded/); }
  assert.ok(stored >= 80, `stored ${stored} chunks of 60 KiB`);
  for (let i = 0; i < 20; i++) storage.set('k0', chunk);
  assert.throws(() => storage.set('extra', chunk), /storage quota exceeded/, 'overwrites do not inflate the size');
  assert.equal(storage.delete('k1'), true);
  assert.equal(storage.set('extra', chunk), true, 'deleting returns capacity');
  assert.equal(storage.set('__proto__', { kept: true }), true);
  storage.flush();
  const file = fsImpl.files.get(path.join('/data', 'notes.json'));
  const saved = JSON.parse(file);
  assert.ok(Buffer.byteLength(file) <= LIMITS.storageBytes);
  assert.deepEqual(Object.getOwnPropertyDescriptor(saved, '__proto__').value, { kept: true });
  const reopened = createPluginStorage({ dir: '/data', pluginId: 'notes', fsImpl });
  assert.deepEqual(reopened.get('__proto__'), { kept: true });
  assert.throws(() => reopened.set('another', chunk), /storage quota exceeded/, 'a reloaded store keeps its size');
});

test('network responses up to 8 MiB are delivered and larger ones fail', async () => {
  const fetchOf = (size) => async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => 'x'.repeat(size) });
  const request = { url: 'https://api.example/', method: 'GET', headers: {} };
  const delivered = await performNetRequest(fetchOf(4 * 1024 * 1024), request);
  assert.equal(delivered.text.length, 4 * 1024 * 1024);
  await assert.rejects(performNetRequest(fetchOf(LIMITS.responseBytes + 1), request), /response too large/);
  assert.equal(LIMITS.requestTimeoutMs, 60_000, 'slow APIs such as model calls get a minute');
});
