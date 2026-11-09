'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readCodexSessionState } = require('../../src/shared/providers/codex/sessionContext');
const { readSessionTitle } = require('../../src/shared/providers/claude/sessionMetadata');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const { normalizePeriod, mergePeriods, applyPeriodDelta } = require('../../src/shared/usage');
const { updateSessionUsageArchive, normalizeSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { sessionModelLabel, sessionModelTooltipEntries, sessionRowsForPeriod, groupSessionRows } = require('../../src/electron/renderer/sessionRows');
const { recentSessionRows } = require('../../src/electron/renderer/edgeDock/presentation');
const at = '2026-11-09T10:00:00.000Z';
const later = '2026-11-09T10:01:00.000Z';
const line = value => JSON.stringify(value) + '\n';
const row = extra => ({ client: 'codex', sessionId: 's', lastUsedAt: at, totalTokens: 100,
  models: { older: 90, newer: 10 }, ...extra });
const period = extra => normalizePeriod({ sessions: { 'codex:s': row(extra) } });
function fixture(t, client) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-model-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, client === 'codex' ? '.codex/sessions/2026/11/09' : '.claude/projects/fixture');
  fs.mkdirSync(dir, { recursive: true });
  const id = client === 'codex' ? 'rollout-2026-11-09T10-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : 's';
  const file = path.join(dir, id + '.jsonl');
  let bytesRead = 0;
  const cache = new Map();
  const deps = { cache, fs: { ...fs, readSync(...args) { const n = fs.readSync(...args); bytesRead += n; return n; } } };
  const read = () => client === 'codex' ? readCodexSessionState(file, deps)
    : (readSessionTitle(file, deps), cache.get(file));
  return { home, file, id, deps, read, bytesRead: () => bytesRead };
}

test('Codex latest model reuses bounded incremental reads, including before token accounting', t => {
  const f = fixture(t, 'codex');
  fs.writeFileSync(f.file, line({ type: 'turn_context', timestamp: at, payload: { model: 'older' } }));
  assert.equal(f.read().latestModel, 'older');
  const before = f.bytesRead();
  assert.equal(f.read().latestModel, 'older');
  assert.equal(f.bytesRead(), before, 'unchanged file needs no read');
  const append = line({ type: 'turn_context', timestamp: at, payload: { model: 'newer' } });
  fs.appendFileSync(f.file, append);
  assert.equal(f.read().latestModel, 'newer');
  assert.equal(f.bytesRead() - before, Buffer.byteLength(append), 'only appended bytes are read');
  const key = `codex:${f.id}`;
  const periods = { today: normalizePeriod({ sessions: { [key]: row({ sessionId: f.id }) } }) };
  applySessionMetadata(periods, f.home, { now: Date.parse(at), env: {}, resolveProjects: false,
    readCodexMeta: () => new Map(), readT3Meta: () => new Map(), codexDeps: f.deps });
  assert.equal(periods.today.sessions[key].latestModel, 'newer');
  fs.appendFileSync(f.file, line({ type: 'turn_context', timestamp: at, payload: {} }));
  assert.equal(f.read().latestModel, null, 'missing new configuration cannot inherit the previous model');
  fs.writeFileSync(f.file, '\n');
  assert.equal(f.read().latestModel, undefined, 'replacement/truncation resets the index');
});

test('Claude latest main response model shares metadata reads and ignores sidechain and synthetic errors', t => {
  const f = fixture(t, 'claude');
  const assistant = (model, extra = {}) => line({ type: 'assistant', timestamp: at,
    message: { model, content: [], usage: { input_tokens: 10 }, stop_reason: 'end_turn' }, ...extra });
  fs.writeFileSync(f.file, assistant('older'));
  assert.equal(f.read().latestModel, 'older');
  const before = f.bytesRead();
  f.read(); assert.equal(f.bytesRead(), before);
  const append = assistant('newer'); fs.appendFileSync(f.file, append);
  assert.equal(f.read().latestModel, 'newer');
  assert.equal(f.bytesRead() - before, Buffer.byteLength(append));
  for (const entry of [assistant('child', { isSidechain: true }), assistant('<synthetic>', { isApiErrorMessage: true }),
    line({ type: 'user', message: { content: 'next prompt' } })]) {
    fs.appendFileSync(f.file, entry); assert.equal(f.read().latestModel, 'newer');
  }
  const periods = { today: normalizePeriod({ sessions: { 'claude:s': row({ client: 'claude' }) } }) };
  applySessionMetadata(periods, f.home, { now: Date.parse(at), env: {}, resolveProjects: false, claudeMetadataDeps: f.deps });
  assert.equal(periods.today.sessions['claude:s'].latestModel, 'newer');
  const huge = line({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: 'x'.repeat(150_000) }],
    model: 'large-response', usage: { input_tokens: 10 }, stop_reason: 'end_turn' }, timestamp: at });
  fs.appendFileSync(f.file, huge);
  assert.equal(f.read().latestModel, 'large-response', 'oversized records use existing fragments');
});

test('latest model survives normalization, archives and exact deltas without stale observations winning', () => {
  const old = period({ latestModel: 'older' });
  const fresh = period({ latestModel: 'newer', lastUsedAt: later });
  for (const merged of [mergePeriods(old, fresh), mergePeriods(fresh, old), applyPeriodDelta(old, fresh, old)]) {
    assert.equal(merged.sessions['codex:s'].latestModel, 'newer');
  }
  assert.equal(mergePeriods(old, period({ latestModel: 'newer' })).sessions['codex:s'].latestModel, null, 'equal-time conflicts are unknown');
  assert.equal(mergePeriods(old, period({ lastUsedAt: later })).sessions['codex:s'].latestModel, null);
  assert.equal(applyPeriodDelta(fresh, old, old).sessions['codex:s'].latestModel, 'newer');
  assert.equal(period({ latestModel: {} }).sessions['codex:s'].latestModel, null);
  const archive = updateSessionUsageArchive(null, { today: fresh }, new Date(later)).archive;
  assert.equal(normalizeSessionUsageArchive(archive).sessions['codex:s'].periods.today.latestModel, 'newer');
  const replay = applySessionUsageArchive({ today: period({ lastUsedAt: later }) }, archive, { now: new Date(later) });
  assert.equal(replay.today.sessions['codex:s'].latestModel, 'newer', 'same-observation read miss preserves saved model');
});

test('label names latest model without a separator and hover retains weighted usage', () => {
  const session = row({ latestModel: 'newer' });
  assert.equal(sessionModelLabel(session), 'newer +1');
  assert.deepEqual(sessionModelTooltipEntries(session, { latestModelLabel: '最近使用' }), [
    ['older', '90', '90%'], ['newer (最近使用)', '10', '10%']
  ]);
  assert.equal(sessionModelLabel(row()), '2 models', 'legacy data never guesses by usage or order');
  assert.equal(sessionModelLabel(row({ latestModel: 'pre-token' })), 'pre-token +2');
  assert.deepEqual(sessionModelTooltipEntries(row({ latestModel: 'pre-token' }))[0], { full: 'Latest used: pre-token' });
  assert.equal(sessionModelLabel({ latestModel: 'pre-token', models: {} }), 'pre-token');
});

test('Sessions and Dock groups use latest main continuation while summing child usage', () => {
  const sessions = {
    'codex:old': row({ sessionId: 'old', nativeSessionId: 'conversation', latestModel: 'older' }),
    'codex:s': row({ nativeSessionId: 'conversation', latestModel: 'newer', lastUsedAt: later }),
    'codex:child': row({ sessionId: 'child', parentSessionId: 's', latestModel: 'child',
      models: { child: 100 }, lastUsedAt: '2026-11-09T10:02:00.000Z' })
  };
  const [group] = groupSessionRows(sessionRowsForPeriod({ sessions }));
  assert.equal(group.modelLabel, 'newer +2');
  assert.match(group.modelTooltipEntries.find(entry => entry[0]?.startsWith('newer'))[0], /Latest used/);
  const [dock] = recentSessionRows({ periods: { month: { sessions } } });
  assert.equal(sessionModelLabel(dock), 'newer +2');
});


test('nested tool configuration cannot replace the observed Codex model', t => {
  const f = fixture(t, 'codex');
  fs.writeFileSync(f.file, line({ type: 'turn_context', payload: { model: 'newer' } }));
  assert.equal(f.read().latestModel, 'newer');
  fs.appendFileSync(f.file, line({ type: 'response_item', payload: {
    type: 'function_call', arguments: { type: 'turn_context', model: 'nested-tool-data' }
  } }));
  assert.equal(f.read().latestModel, 'newer');
});

test('a resumed newer native observation without model evidence cannot claim the archived model', () => {
  const sessions = { 'codex:s': row({ archived: true, latestModel: 'older' }) };
  const nativeSessions = { 'codex:s': { client: 'codex', sessionId: 's', native: true,
    lastUsedAt: later, liveActivity: { state: 'running', observedAt: later } } };
  const [resumed] = sessionRowsForPeriod({ sessions }, { nativeSessions, now: new Date(later) });
  assert.equal(resumed.modelLabel, '2 models');
  assert.equal(resumed.value, 100);
});

test('explicit provider model evidence does not require a wall-clock timestamp', () => {
  const observed = period({ lastUsedAt: '', latestModel: 'newer' }).sessions['codex:s'];
  assert.equal(sessionModelLabel(observed), 'newer +1');
  assert.equal(sessionModelLabel(period({ lastUsedAt: '' }).sessions['codex:s']), '2 models');
});
