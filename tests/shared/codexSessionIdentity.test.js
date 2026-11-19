'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nativeIdForFile } = require('../../src/shared/providers/codex/sessionIdentity');
const { applySessionMetadata, applyT3SessionParents } = require('../../src/shared/sessionMetadata');
const { normalizePeriod, mergePeriods, stripSessionTextFromPeriod } = require('../../src/shared/usage');
const ID = '01a128e7-84b0-7443-9d1d-af0368c81583';
const OTHER = '01a128fb-c3c9-7db1-b6bb-ae2d204f9043';
function directory(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-codex-identity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
test('verified header identity overrides multi-UUID filename hints, changes with file replacement, and rejects incomplete headers', t => {
  const home = directory(t); const file = path.join(home, `${OTHER}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: ID, instructions: 'x'.repeat(100_000) } }) + '\n');
  assert.equal(nativeIdForFile(file), ID);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: OTHER } }) + '\n');
  assert.equal(nativeIdForFile(file), OTHER);
  fs.writeFileSync(file, '{"type":"session_meta","payload":');
  assert.equal(nativeIdForFile(file), '');
  fs.writeFileSync(file, JSON.stringify({ type: 'message', payload: { id: ID } }) + '\n');
  assert.equal(nativeIdForFile(file), '');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: ID, padding: 'x'.repeat(8 * 1024 * 1024) } }) + '\n');
  assert.equal(nativeIdForFile(file), '');
});
test('metadata enriches historical continuations before the context freshness gate without guessing multi-UUID filenames', t => {
  const home = directory(t); const dir = path.join(home, '.codex', 'sessions', '2026', '01', '01'); fs.mkdirSync(dir, { recursive: true });
  const sessionId = `rollout-2026-01-01T10-00-00-${ID}_${OTHER}`;
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: ID } }) + '\n');
  const parent = { client: 'codex', sessionId, totalTokens: 10, costUsd: 1 };
  const child = { client: 'claude', sessionId: 'child', totalTokens: 20, costUsd: 2 };
  const periods = { today: { sessions: { [`codex:${sessionId}`]: parent, 'claude:child': child } } };
  const deps = { scopedHome: true, readCodexMeta: () => new Map(), readT3Meta: () => new Map(),
    readT3SessionParents: undefined };
  applySessionMetadata(periods, home, deps);
  assert.equal(parent.nativeSessionId, ID);
  // Reader injection uses the existing SQLite adapter boundary in other fixtures;
  // normalization must retain the same independently verified identity.
  const wire = normalizePeriod(periods.today);
  assert.equal(wire.sessions[`codex:${sessionId}`].nativeSessionId, ID);
  assert.equal(wire.totalTokens, 0, 'identity enrichment never recomputes aggregate usage');
  applyT3SessionParents({}, home);
});
test('unchanged large histories reuse header identities while changed files are revalidated', t => {
  const home = directory(t);
  const files = Array.from({ length: 600 }, (_, index) => path.join(home, `${index}.jsonl`));
  for (const file of files) {
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: ID } }) + '\n');
    assert.equal(nativeIdForFile(file), ID);
  }
  const read = t.mock.method(fs, 'readSync');
  for (const file of files) assert.equal(nativeIdForFile(file), ID);
  assert.equal(read.mock.callCount(), 0, 'warm full scans do not reread unchanged headers');
  fs.writeFileSync(files[0], JSON.stringify({ type: 'session_meta', payload: { id: OTHER } }) + '\n');
  assert.equal(nativeIdForFile(files[0]), OTHER);
  assert.ok(read.mock.callCount() > 0, 'replacement headers are checked again');
});
test('native identity survives sync normalization and title removal; conflicts and invalid/client-mismatched values do not group', () => {
  const make = nativeSessionId => normalizePeriod({ sessions: { 'codex:record': { client: 'codex', sessionId: 'record', totalTokens: 10, nativeSessionId } } });
  const a = make(ID); const b = make(OTHER);
  assert.equal(stripSessionTextFromPeriod(a).sessions['codex:record'].nativeSessionId, ID);
  assert.equal(mergePeriods(a, a).sessions['codex:record'].nativeSessionId, ID);
  assert.equal(mergePeriods(a, b, a).sessions['codex:record'].nativeSessionId, undefined);
  assert.equal(make('not-a-native-id').sessions['codex:record'].nativeSessionId, undefined);
  const wrong = normalizePeriod({ sessions: { 'claude:record': { client: 'claude', sessionId: 'record', totalTokens: 10, nativeSessionId: ID } } });
  assert.equal(wrong.sessions['claude:record'].nativeSessionId, undefined);
});

test('retained archive restores verified conversation identity without persisting transient activity', () => {
  const { captureSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
  const { emptyPeriod } = require('../../src/shared/usage');
  const now = new Date('2026-10-11T06:00:00Z');
  const record = normalizePeriod({ sessions: { 'codex:record': { client: 'codex', sessionId: 'record', totalTokens: 10, costUsd: 1, nativeSessionId: ID,
    liveActivity: { state: 'running', source: 'test', observedAt: now.toISOString() } } } });
  const archive = captureSessionUsageArchive(null, { periods: { today: record, month: record, allTime: record } }, now);
  const restored = applySessionUsageArchive({ today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }, JSON.parse(JSON.stringify(archive)), { now });
  assert.equal(restored.today.sessions['codex:record'].nativeSessionId, ID);
  assert.equal(restored.today.sessions['codex:record'].liveActivity, undefined);
  assert.equal(restored.today.totalTokens, 10);
  assert.equal(restored.today.costUsd, 1);
});


test('header identity accepts an EOF-terminated record and ignores later metadata records', t => {
  const file = path.join(directory(t), 'session.jsonl');
  const header = id => JSON.stringify({ type: 'session_meta', payload: { id } });
  fs.writeFileSync(file, header(ID));
  assert.equal(nativeIdForFile(file), ID);
  fs.writeFileSync(file, header(ID) + '\r\n' + header(OTHER) + '\n');
  assert.equal(nativeIdForFile(file), ID);
  fs.writeFileSync(file, '{invalid}\n' + header(OTHER) + '\n');
  assert.equal(nativeIdForFile(file), '', 'a later valid record cannot establish identity');
  for (const payload of [null, {}, { id: 123 }, { id: {} }]) {
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload }) + '\n');
    assert.equal(nativeIdForFile(file), '');
  }
});

test('header size bound accepts a complete record at 8 MiB but rejects one byte beyond it', t => {
  const file = path.join(directory(t), 'session.jsonl');
  const limit = 8 * 1024 * 1024;
  const header = padding => JSON.stringify({ type: 'session_meta', payload: { id: ID, padding } });
  const padding = 'x'.repeat(limit - Buffer.byteLength(header('')));
  const exact = header(padding);
  assert.equal(Buffer.byteLength(exact), limit);
  fs.writeFileSync(file, exact);
  assert.equal(nativeIdForFile(file), ID);
  fs.writeFileSync(file, header(padding + 'x'));
  assert.equal(nativeIdForFile(file), '');
});

test('cached header identity cannot survive deletion or substitution with a directory or symlink', t => {
  const home = directory(t);
  const file = path.join(home, 'session.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: ID } }));
  assert.equal(nativeIdForFile(file), ID);
  fs.unlinkSync(file);
  assert.equal(nativeIdForFile(file), '');
  fs.mkdirSync(file);
  assert.equal(nativeIdForFile(file), '');
  fs.rmdirSync(file);
  // Windows requires symlink privileges; the deletion/directory checks still run there.
  if (process.platform !== 'win32') {
    const target = path.join(home, 'target.jsonl');
    fs.writeFileSync(target, JSON.stringify({ type: 'session_meta', payload: { id: OTHER } }));
    fs.symlinkSync(target, file);
    assert.equal(nativeIdForFile(file), '', 'identity must come from a regular rollout file');
  }
});
