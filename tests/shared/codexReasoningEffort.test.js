'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { readCodexSessionState } = require('../../src/shared/providers/codex/sessionContext');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const { normalizePeriod, mergePeriods, applyPeriodDelta } = require('../../src/shared/usage');
const { normalizeSessionUsageArchive, updateSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');

const at = '2026-10-25T10:00:00.000Z';
const next = '2026-10-25T10:01:00.000Z';
const record = (type, payload, timestamp = at) => JSON.stringify({ type, payload, timestamp }) + '\n';
const turn = payload => record('turn_context', { model: 'gpt-fixture-high', ...payload });
const start = () => record('event_msg', { type: 'task_started' }, next);
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-effort-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '25');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'rollout-2026-10-25T10-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const file = path.join(dir, id + '.jsonl');
  const cache = new Map();
  let bytesRead = 0;
  const deps = { cache, fs: { ...fs, readSync(...args) {
    const count = fs.readSync(...args); bytesRead += count; return count;
  } } };
  return { home, file, id, deps, bytesRead: () => bytesRead, read: () => readCodexSessionState(file, deps) };
}

test('Codex effort updates before token usage and reuses the context/cache read', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, turn({ effort: 'high' }));
  assert.equal(f.read().reasoningEffort, 'high');
  const bytes = f.bytesRead();
  assert.equal(f.read().reasoningEffort, 'high');
  assert.equal(f.bytesRead(), bytes, 'unchanged metadata needs no new read');
  fs.appendFileSync(f.file, turn({ effort: 'low' }));
  assert.equal(f.read().reasoningEffort, 'low', 'no token_count is required');
  assert.equal(f.bytesRead(), fs.statSync(f.file).size, 'only the existing append bytes were read');
  for (const effort of [undefined, null, '', ' ', {}, ['high'], 7, 'unknown', 'x'.repeat(33)]) {
    fs.appendFileSync(f.file, turn({ effort: 'high' }) + turn({ effort }));
    assert.equal(f.read().reasoningEffort, null, JSON.stringify(effort));
  }
  fs.appendFileSync(f.file, turn({ reasoning_effort: 'xhigh' }));
  assert.equal(f.read().reasoningEffort, 'xhigh');
  fs.appendFileSync(f.file, turn({ effort: null, reasoning_effort: 'high' }));
  assert.equal(f.read().reasoningEffort, null, 'an explicit primary clear is authoritative');
});

test('new turns and partial/oversized configuration cannot retain previous effort', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, turn({ effort: 'high' }) + start());
  assert.equal(f.read().reasoningEffort, null);
  const full = turn({ effort: 'low' }).trimEnd();
  fs.appendFileSync(f.file, full.slice(0, -2));
  assert.equal(f.read().reasoningEffort, null);
  fs.appendFileSync(f.file, full.slice(-2));
  assert.equal(f.read().reasoningEffort, 'low', 'complete final JSON without newline is valid');
  fs.appendFileSync(f.file, '\n' + record('response_item', { text: 'partial' }).slice(0, -3));
  assert.equal(f.read().reasoningEffort, 'low', 'ordinary tool output is not a new turn');
  fs.appendFileSync(f.file, '}\n' + start() + turn({ effort: 'low', padding: 'x'.repeat(100_000) }));
  assert.equal(f.read().reasoningEffort, null);
});

test('bounded cold reads, truncation, replacement and read failures do not invent effort', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, turn({ effort: 'high' }) + '\n'.repeat(1200_000)
    + record('event_msg', { type: 'task_complete' }));
  assert.equal(Object.hasOwn(f.read(), 'reasoningEffort'), false, 'metadata outside the existing tail supplies no evidence');
  assert.equal(f.bytesRead(), 1024 * 1024, 'the badge does not widen the read');
  fs.writeFileSync(f.file, turn({ effort: 'high' }) + '\n'.repeat(1200_000));
  assert.equal(Object.hasOwn(f.read(), 'reasoningEffort'), false, 'widening for a boundary does not turn older configuration into a clear');
  fs.writeFileSync(f.file, turn({ effort: 'high' }));
  assert.equal(f.read().reasoningEffort, 'high');
  fs.writeFileSync(f.file, start());
  assert.equal(f.read().reasoningEffort, null, 'shrink resets the index');
  const replacement = f.file + '.replacement';
  fs.writeFileSync(replacement, turn({ effort: 'low' }));
  fs.renameSync(replacement, f.file);
  assert.equal(f.read().reasoningEffort, 'low');
  fs.unlinkSync(f.file);
  assert.equal(f.read().reasoningEffort, undefined, 'read failure returns no earlier setting');
});

for (const compressed of [false, true]) {
  test(`bounded cold ${compressed ? 'compressed' : 'plain'} reads retain catalog effort through archive capture`, t => {
    const f = fixture(t);
    const file = f.file + (compressed ? '.zst' : '');
    let transcript = turn({ effort: 'high' }) + '\n'.repeat(1200_000)
      + record('event_msg', { type: 'task_complete' }, next);
    const write = () => fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(Buffer.from(transcript)) : transcript);
    write();
    const dbPath = path.join(f.home, '.codex', 'state_5.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, reasoning_effort TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(f.id, 'Saved title', 'high');
    db.close();
    const state = readCodexSessionState(file, f.deps);
    assert.equal(Object.hasOwn(state, 'reasoningEffort'), false);
    if (!compressed) assert.equal(f.bytesRead(), 1024 * 1024, 'cold read retains its existing budget');
    const periods = { today: normalizePeriod({ sessions: { ['codex:' + f.id]: {
      client: 'codex', sessionId: f.id, totalTokens: 10, lastUsedAt: next
    } } }) };
    const resolve = () => {
      applySessionMetadata(periods, f.home, { now: Date.parse(next), env: {}, resolveProjects: false,
        readT3Meta: () => new Map(), codexDeps: { ...f.deps, dbPaths: [dbPath], sqlite: { DatabaseSync } } });
      return periods.today.sessions['codex:' + f.id].reasoningEffort;
    };
    assert.equal(resolve(), 'high', 'a bounded miss must not override the SQLite setting');
    const saved = updateSessionUsageArchive(null, periods, new Date(next)).archive;
    assert.equal(normalizeSessionUsageArchive(saved).sessions['codex:' + f.id].periods.today.reasoningEffort, 'high');
    transcript += start(); write();
    assert.equal(resolve(), null, 'an observed new turn still clears the catalog setting');
    transcript += turn({ effort: 'low' }); write();
    assert.equal(resolve(), 'low');
  });
}

test('effort survives age and read misses while fresh turn metadata can clear it', t => {
  const f = fixture(t);
  const periods = { today: { sessions: { ['codex:' + f.id]: {
    client: 'codex', sessionId: f.id, totalTokens: 10, reasoningEffort: 'old'
  } } } };
  const resolve = now => {
    applySessionMetadata(periods, f.home, { now, env: {}, resolveProjects: false,
      readCodexMeta: () => new Map(), readT3Meta: () => new Map(), codexDeps: f.deps });
    return periods.today.sessions['codex:' + f.id].reasoningEffort;
  };
  fs.writeFileSync(f.file, turn({ effort: 'high' }));
  assert.equal(resolve(Date.parse(at) + 1800_000), 'high');
  const bytes = f.bytesRead();
  assert.equal(resolve(Date.parse(at) + 1800_001), 'high');
  assert.equal(f.bytesRead(), bytes, 'out-of-window resolution does not read state again');
  fs.appendFileSync(f.file, start());
  assert.equal(resolve(Date.parse(next)), null);
  fs.appendFileSync(f.file, turn({ effort: 'low' }, next));
  assert.equal(resolve(Date.parse(next)), 'low');
  fs.unlinkSync(f.file);
  assert.equal(resolve(Date.parse(next)), 'low', 'a missing transcript is not an explicit new configuration');
});

test('normalization, merge and deltas replace effort snapshots including unknown', () => {
  const period = (effort, lastUsedAt = at) => normalizePeriod({ sessions: { 'codex:s': {
    client: 'codex', sessionId: 's', totalTokens: 10, lastUsedAt, reasoningEffort: effort
  } } });
  const old = period('high');
  for (const effort of ['low', null]) {
    const fresh = period(effort, next);
    for (const merged of [mergePeriods(old, fresh), mergePeriods(fresh, old), applyPeriodDelta(old, fresh, old)]) {
      assert.equal(merged.sessions['codex:s'].reasoningEffort, effort);
    }
  }
  const missing = period(undefined, next);
  delete missing.sessions['codex:s'].reasoningEffort;
  assert.equal(mergePeriods(old, missing).sessions['codex:s'].reasoningEffort, null);
  assert.equal(mergePeriods(period('high'), period('low')).sessions['codex:s'].reasoningEffort, null);
  assert.equal(normalizePeriod({ sessions: { s: { client: 'gemini', sessionId: 's', totalTokens: 1,
    reasoningEffort: 'high' } } }).sessions['gemini:s'].reasoningEffort, undefined);
});

test('session archives retain effort independently of expiring activity', () => {
  const session = { client: 'codex', sessionId: 's', totalTokens: 10, lastUsedAt: at, reasoningEffort: 'high' };
  const { archive } = updateSessionUsageArchive(null, { today: { sessions: { 'codex:s': session } } }, new Date(at));
  assert.equal(archive.sessions['codex:s'].periods.today.reasoningEffort, 'high');
  assert.equal(normalizeSessionUsageArchive(archive).sessions['codex:s'].periods.today.reasoningEffort, 'high');
  archive.sessions['codex:s'].periods.today.reasoningEffort = '<script>';
  assert.equal(normalizeSessionUsageArchive(archive).sessions['codex:s'].periods.today.reasoningEffort, null);
});

for (const client of ['codex', 'claude']) test(`${client} later collection preserves effort only for the same unchanged observation`, () => {
  const snapshot = extra => ({ today: normalizePeriod({ sessions: { [`${client}:s`]: {
    client, sessionId: 's', totalTokens: 10, lastUsedAt: at, ...extra
  } } }) });
  for (const [extra, expected] of [[{}, 'high'], [{ reasoningEffort: null }, null], [{ lastUsedAt: next }, undefined]]) {
    const saved = updateSessionUsageArchive(null, snapshot({ reasoningEffort: 'high' }), new Date(at)).archive;
    const current = snapshot(extra);
    updateSessionUsageArchive(saved, current, new Date(next));
    const restored = applySessionUsageArchive(current, normalizeSessionUsageArchive(saved), { now: new Date(next) });
    assert.equal(restored.today.sessions[`${client}:s`].reasoningEffort, expected);
    assert.equal(current.today.sessions[`${client}:s`].reasoningEffort, extra.reasoningEffort, 'capture does not mutate the scanner row');
  }
});
