'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_JSON_BODY_BYTES } = require('../../src/shared/http');
const { MAX_UPLOAD_BYTES, createUploadBaselines } = require('../../src/shared/uploadDelta');

test('the hub JSON body ceiling matches the upload ceiling', () => {
  assert.equal(MAX_UPLOAD_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_JSON_BODY_BYTES, MAX_UPLOAD_BYTES);
});

test('upload baselines require an exact revision, apply atomically, and bind device identity', () => {
  const cache = createUploadBaselines();
  const initial = { deviceId: 'a', value: 10, nullable: 1, nested: JSON.parse('{"__proto__":null}') };
  const ack = cache.commit('a', initial);
  const delta = { deviceId: 'a', baseRevision: ack.revision, patch: [{ op: 'replace', path: '/value', value: 0 }, { op: 'replace', path: '/nullable', value: null }] };
  assert.deepEqual(cache.prepare(delta), { ...initial, value: 0, nullable: null });
  assert.throws(() => cache.prepare({ ...delta, baseRevision: 'wrong' }), { status: 409 });
  assert.throws(() => cache.prepare({ ...delta, patch: [...delta.patch, { op: 'replace', path: '/missing/x', value: 1 }] }), { status: 400 });
  assert.equal(cache.prepare({ ...delta, patch: [] }).value, 10, 'failed patch never commits');
  assert.throws(() => cache.prepare({ ...delta, patch: [{ op: 'replace', path: '/deviceId', value: 'b' }] }), { status: 400 });
  assert.throws(() => cache.prepare({ ...delta, patch: [{ op: 'replace', path: '', value: [] }] }), { status: 400 });
  assert.throws(() => cache.prepare({ ...delta, patch: [{ op: 'add', path: '/constructor/prototype/polluted', value: true }] }), { status: 400 });
  assert.equal({}.polluted, undefined);
  const next = cache.commit('a', cache.prepare(delta));
  assert.notEqual(next.revision, ack.revision);
  assert.throws(() => cache.prepare(delta), { status: 409 }, 'duplicate delta cannot apply twice');
});

test('wire and reconstructed payload sizes are bounded; eviction and restart require full sync', () => {
  const cache = createUploadBaselines({ maxEntries: 1 });
  const ack = cache.commit('a', { deviceId: 'a' });
  assert.throws(() => cache.prepare({ deviceId: 'a', baseRevision: ack.revision, patch: [{ op: 'add', path: '/huge', value: 'x'.repeat(MAX_UPLOAD_BYTES) }] }), { status: 413 });
  cache.commit('b', { deviceId: 'b' });
  assert.throws(() => cache.prepare({ deviceId: 'a', baseRevision: ack.revision, patch: [] }), { status: 409 });
  const bounded = createUploadBaselines({ maxBytes: 100 });
  assert.equal(bounded.commit('a', { deviceId: 'a', huge: 'x'.repeat(101) }), undefined);
  assert.throws(() => createUploadBaselines().prepare({ deviceId: 'a', baseRevision: ack.revision, patch: [] }), { status: 409 });
});
