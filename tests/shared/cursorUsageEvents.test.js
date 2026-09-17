'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCursorUsageEventIndex } = require('../../src/shared/providers/cursor/usageEvents');

function event(timestamp, tokens, extra = {}) {
  return {
    timestamp: String(Date.parse(timestamp)),
    model: 'default',
    tokenUsage: { inputTokens: tokens - 30, outputTokens: 10, cacheReadTokens: 15, cacheWriteTokens: 5 },
    ...extra
  };
}

function cacheDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (relative, events) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), JSON.stringify({ usageEventsDisplay: events }));
  };
  return { dir, write };
}

const AT = '2026-08-13T23:42:39.510Z';

test('Cursor cache events resolve to the session tokscale files them under', (t) => {
  const { dir, write } = cacheDir(t);
  write('usage.json', [
    event(AT, 100, { conversationId: ' conv-1 ' }),
    event('2026-08-13T23:50:00.000Z', 200)
  ]);
  write('usage.team-a.json', [event('2026-08-14T01:00:00.000Z', 300)]);
  const index = createCursorUsageEventIndex({ cacheDir: dir })();

  assert.deepEqual(index.sessionsAt(Date.parse(AT), 100), ['conv-1']);
  assert.deepEqual(index.sessionsAt(Date.parse(AT), 101), []);
  // The fallback day is UTC, as tokscale formats it.
  assert.deepEqual(index.sessionsAt(Date.parse('2026-08-13T23:50:00.000Z'), 200), ['cursor-active-2026-08-13']);
  assert.deepEqual(index.sessionsAt(Date.parse('2026-08-14T01:00:00.000Z'), 300), ['cursor-team-a-2026-08-14']);
});

test('archived Cursor caches answer only for events that name their conversation', (t) => {
  const { dir, write } = cacheDir(t);
  write('archive/usage.team-b-2026-09-01T10-00-00.json', [
    event(AT, 100, { conversationId: 'conv-2' }),
    event('2026-08-13T23:50:00.000Z', 200)
  ]);
  write('usage.last-sync-attempt.json.tmp', []);
  const index = createCursorUsageEventIndex({ cacheDir: dir })();

  assert.deepEqual(index.sessionsAt(Date.parse(AT), 100), ['conv-2']);
  assert.deepEqual(index.sessionsAt(Date.parse('2026-08-13T23:50:00.000Z'), 200), []);
});

test('the same event in a live and an archived cache is one session, two sessions stay ambiguous', (t) => {
  const { dir, write } = cacheDir(t);
  write('usage.json', [event(AT, 100, { conversationId: 'conv-1' })]);
  write('archive/usage.active-2026-09-01T10-00-00.json', [event(AT, 100, { conversationId: 'conv-1' })]);
  write('usage.team-a.json', [event(AT, 100, { conversationId: 'conv-3' })]);
  const index = createCursorUsageEventIndex({ cacheDir: dir })();

  assert.deepEqual(index.sessionsAt(Date.parse(AT), 100).sort(), ['conv-1', 'conv-3']);
});

test('the Cursor cache is reparsed only after a file changes', (t) => {
  const { dir, write } = cacheDir(t);
  write('usage.json', [event(AT, 100, { conversationId: 'conv-1' })]);
  let parses = 0;
  const readFileSync = (...args) => {
    parses += 1;
    return fs.readFileSync(...args);
  };
  const read = createCursorUsageEventIndex({ cacheDir: dir, fs: { ...fs, readFileSync } });

  const first = read();
  assert.equal(read(), first);
  assert.equal(parses, 1);

  write('usage.json', [event(AT, 100, { conversationId: 'conv-1' }), event('2026-08-15T00:00:00.000Z', 50)]);
  fs.utimesSync(path.join(dir, 'usage.json'), new Date(), new Date(Date.now() + 5000));
  assert.notEqual(read().signature, first.signature);
  assert.equal(parses, 2);
});

test('a missing Cursor cache yields an empty index', () => {
  const index = createCursorUsageEventIndex({ cacheDir: path.join(os.tmpdir(), 'no-such-cursor-cache') })();
  assert.equal(index.signature, '');
  assert.deepEqual(index.sessionsAt(Date.parse(AT), 100), []);
});
