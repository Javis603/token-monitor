'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { applyAntigravityThroughput, conversationFile, decodeGeneration, readConversation } = require('../../src/shared/providers/antigravity/throughput');
const { extractUsageFromTokscale } = require('../../src/shared/usage');
const { readSessionDetail } = require('../../src/shared/sessionDetail');
const { collectUsageOnce } = require('../../src/shared/collector');

function varint(input) {
  let value = BigInt(input);
  const bytes = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
}

function proto(fields) {
  return Buffer.concat(Object.entries(fields).map(([field, value]) => {
    if (typeof value === 'number' || typeof value === 'bigint') return Buffer.concat([varint(Number(field) * 8), varint(value)]);
    const data = typeof value === 'string' ? Buffer.from(value) : value;
    return Buffer.concat([varint(Number(field) * 8 + 2), varint(data.length), data]);
  }));
}

function timestamp(ms) {
  return proto({ 1: Math.floor(ms / 1000), 2: Math.round(ms % 1000 * 1e6) });
}

const start = new Date(2026, 9, 7, 12).getTime();
const model = 'gemini-3.8-flash-n';
function generation({ stepIdx = 1, output = 120, responseId = '', legacyStart = 0, duration = 2000, packed = false, reasoning = 0, systemInput = 0, modelId = model } = {}) {
  const chat = { 4: proto({ 1: systemInput, 2: 50, 3: output, 5: 20, 9: output - reasoning, 10: reasoning, ...(responseId ? { 11: responseId } : {}) }), 19: modelId };
  if (duration !== null) { chat[11] = timestamp(500); chat[12] = timestamp(duration - 500); }
  if (legacyStart) chat[9] = proto({ 4: timestamp(legacyStart) });
  return proto({ 1: proto(chat), 2: packed ? varint(stepIdx) : stepIdx });
}

function fixture(t, { wal = false, steps = true, cli = false, geminiDir = '.gemini' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-antigravity-speed-'));
  const geminiHome = path.join(home, geminiDir);
  const root = path.join(geminiHome, cli ? 'antigravity-cli' : 'antigravity', 'conversations');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'session.db');
  const db = new DatabaseSync(file);
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY,data BLOB)');
  if (steps) db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB)');
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  function step(idx, type, at, end, status = 3) {
    db.prepare('INSERT INTO steps VALUES(?,?,?,?)').run(idx, type, status, proto({ 1: timestamp(at), ...(end ? { 7: timestamp(end) } : {}) }));
  }
  function add(idx, options) { db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(idx, generation(options)); }
  return { home, geminiHome, file, db, step, add };
}

function scan(output = 120, overrides = {}) {
  return { entries: [{ client: 'antigravity-extension', sessionId: 'session', model, input: 50, output, cacheRead: 20, cost: 0.01, ...overrides }] };
}

test('new-schema generations retain timing without the deprecated timestamp, including step index zero and packed indices', () => {
  for (const packed of [false, true]) {
    const decoded = decodeGeneration(generation({ stepIdx: 0, packed }));
    assert.equal(decoded.startedAt, 0);
    assert.equal(decoded.stepIdx, 0);
    assert.equal(decoded.durationMs, 2000);
    assert.equal(decoded.tokens.output, 120);
  }
  assert.equal(decodeGeneration(generation({ legacyStart: start })).startedAt, start);
  assert.equal(decodeGeneration(generation({ duration: null })).durationMs, null);
  assert.equal(decodeGeneration(generation({ output: 0 })).tokens.output, 0);
  for (const invalid of [Buffer.from([0]), Buffer.from([10, 128]), Buffer.from([10, 2, 1]), Buffer.alloc(10, 255)]) {
    assert.equal(decodeGeneration(invalid), null);
  }
});

test('step joins distinguish model generation time from complete tool-inclusive user tasks', t => {
  const f = fixture(t);
  f.step(0, 14, start, start);
  f.step(1, 15, start + 1000, start + 3000);
  f.step(2, 132, start + 3000, start + 12000);
  f.step(3, 14, start + 60000, start + 60000);
  f.step(4, 15, start + 61000, start + 65000);
  f.add(1, { stepIdx: 1 });
  f.add(2, { stepIdx: 4, output: 200, duration: 4000 });
  const data = readConversation(f.file);
  assert.equal(data.generations[0].startedAt, start + 1000);
  assert.deepEqual(data.tasks.map(task => [task.generations[0].tokens.output, task.durationMs]), [[120, 12000], [200, 5000]]);
  const detail = readSessionDetail({ client: 'antigravity', sessionId: 'session', home: f.home });
  assert.equal(detail.found, true);
  assert.equal(detail.exchanges.length, 2);
  assert.equal(detail.exchanges[0].tokens.output * 1000 / detail.exchanges[0].durationMs, 10);
  assert.equal(detail.exchanges[0].turns[0].tokens.output * 1000 / detail.exchanges[0].turns[0].durationMs, 60);
});

test('missing generation durations retain output while running and partial-period tasks have unavailable task rates', t => {
  const f = fixture(t);
  const yesterday = new Date(2026, 9, 6, 23, 59).getTime();
  const today = new Date(2026, 9, 7, 0, 1).getTime();
  f.step(0, 14, yesterday, yesterday);
  f.step(1, 15, yesterday + 1000, yesterday + 3000);
  f.step(2, 15, today, today + 3000);
  f.add(1, { stepIdx: 1, output: 20, duration: null });
  f.add(2, { stepIdx: 2, output: 30 });
  const args = { client: 'antigravity', sessionId: 'session', home: f.home, deps: { now: () => start } };
  const all = readSessionDetail(args);
  assert.equal(all.exchanges[0].tokens.output, 50);
  assert.equal(all.exchanges[0].turns[0].durationMs, null);
  assert.ok(all.exchanges[0].durationMs > 0);
  const filtered = readSessionDetail({ ...args, period: 'today' });
  assert.equal(filtered.exchanges[0].tokens.output, 30);
  assert.equal(filtered.exchanges[0].durationMs, null);
  f.db.prepare('UPDATE steps SET status=2 WHERE idx=2').run();
  assert.equal(readConversation(f.file).tasks[0].durationMs, null);
});

test('legacy databases without steps still retain generation timing and response deduplication', t => {
  const f = fixture(t, { steps: false });
  f.add(1, { legacyStart: start, responseId: 'duplicate', output: 10 });
  f.add(2, { legacyStart: start, responseId: 'duplicate', output: 20 });
  const data = readConversation(f.file);
  assert.equal(data.generations.length, 1);
  assert.equal(data.generations[0].tokens.output, 20);
  assert.equal(data.generations[0].durationMs, 2000);
  const detail = readSessionDetail({ client: 'antigravity', sessionId: 'session', home: f.home });
  assert.equal(detail.exchanges[0].tokens.output, 20);
  assert.equal(detail.exchanges[0].durationMs, null);
});

test('collector supplements exact coverage without changing token/cost totals or existing performance', t => {
  const f = fixture(t);
  f.step(0, 14, start, start);
  f.step(1, 15, start + 1000, start + 3000);
  f.add(1, {});
  const json = scan();
  const before = extractUsageFromTokscale(json);
  applyAntigravityThroughput(json, { home: f.home, flags: ['--today'], now: start + 10000 });
  const after = extractUsageFromTokscale(json);
  assert.equal(after.totalTokens, before.totalTokens);
  assert.equal(after.costUsd, before.costUsd);
  assert.equal(after.timedOutputTokens, 120);
  assert.equal(after.timedDurationMs, 2000);
  assert.equal(after.sessions['antigravity:session'].timedOutputTokens, 120);
  assert.equal(after.modelThroughput[Object.keys(after.models)[0]].timedDurationMs, 2000);
  const existing = scan(120, { performance: { totalDurationMs: 1000, timedTokens: 150 } });
  const original = structuredClone(existing);
  applyAntigravityThroughput(existing, { home: f.home, now: start + 10000 });
  assert.deepEqual(existing, original);
  for (const mismatch of [scan(119), { entries: [scan().entries[0], scan().entries[0]] }, scan(120, { client: 'codex' })]) {
    const original = structuredClone(mismatch);
    applyAntigravityThroughput(mismatch, { home: f.home, now: start + 10000 });
    assert.deepEqual(mismatch, original);
  }
  const old = scan();
  applyAntigravityThroughput(old, { home: f.home, flags: ['--since', '2026-10-08'], now: start + 10000 });
  assert.equal(old.entries[0].performance, undefined);
});

test('WAL updates invalidate successful snapshots, while the database remains read-only', t => {
  const f = fixture(t, { wal: true });
  f.step(0, 14, start, start);
  f.step(1, 15, start + 1000, start + 3000);
  f.add(1, {});
  const dbBytes = fs.readFileSync(f.file);
  const walBytes = fs.readFileSync(`${f.file}-wal`);
  const first = readConversation(f.file);
  assert.equal(readConversation(f.file), first);
  assert.deepEqual(fs.readFileSync(f.file), dbBytes);
  assert.deepEqual(fs.readFileSync(`${f.file}-wal`), walBytes);
  const stat = fs.statSync(f.file);
  f.add(2, { output: 60 });
  assert.equal(fs.statSync(f.file).mtimeMs, stat.mtimeMs);
  assert.equal(readConversation(f.file).generations.length, 2);
});

test('busy, missing and corrupt sources fail safely and retry after recovery', t => {
  const f = fixture(t);
  f.step(0, 14, start, start);
  f.step(1, 15, start + 1000, start + 3000);
  f.add(1, {});
  f.db.exec('BEGIN EXCLUSIVE');
  assert.equal(readConversation(f.file), null);
  f.db.exec('ROLLBACK');
  assert.equal(readConversation(f.file).generations.length, 1);
  f.db.exec('DROP TABLE gen_metadata');
  assert.equal(readConversation(f.file), null);
  f.db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY,data BLOB)');
  f.add(1, {});
  assert.equal(readConversation(f.file).generations.length, 1);
  f.db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(2, Buffer.from([10, 255]));
  assert.equal(readConversation(f.file).complete, false);
  assert.equal(readConversation(f.file).tasks[0].durationMs, null);
  assert.equal(conversationFile('../session', f.home), '');
  assert.equal(conversationFile('absent', f.home), '');
  assert.equal(readConversation(path.join(f.home, 'missing.db')), null);
  assert.equal(fs.existsSync(path.join(f.home, 'missing.db')), false);
});


test('reasoning is counted once and fixed system input matches the real Tokscale contract', t => {
  const f = fixture(t);
  f.step(0, 14, start, start);
  f.step(1, 15, start + 1000, start + 3000);
  f.add(1, { output: 160, reasoning: 40, systemInput: 10 });
  const json = scan(120, { reasoning: 40, input: 60 });
  applyAntigravityThroughput(json, { home: f.home, now: start + 10000 });
  const period = extractUsageFromTokscale(json);
  assert.equal(period.totalTokens, 240);
  assert.equal(period.outputTokens, 160);
  assert.equal(period.timedOutputTokens, 160);
  assert.equal(period.timedTokens, 240);
  const detail = readSessionDetail({ client: 'antigravity', sessionId: 'session', home: f.home, sessionCost: 0.01 });
  assert.equal(detail.exchanges[0].tokens.output, 160);
  assert.equal(detail.exchanges[0].tokens.reasoning, 40);
  assert.equal(detail.exchanges[0].tokens.input, 60);
  assert.equal(detail.totals.totalTokens, 240);
  assert.equal(detail.totals.costUsd, 0.01);
});

test('single-model native aliases use the scan identity without guessing mixed-model mappings', t => {
  const f = fixture(t);
  f.step(0, 14, start, start);
  f.step(1, 15, start + 1000, start + 3000);
  f.add(1, { modelId: 'gemini-pro-default' });
  const json = scan(120, { model: 'gemini-3.1-pro' });
  applyAntigravityThroughput(json, { home: f.home, now: start + 10000 });
  assert.equal(extractUsageFromTokscale(json).timedOutputTokens, 120);
  f.add(2, { output: 20, modelId: 'gemini-pro-agent' });
  const mixed = scan(140, { model: 'gemini-3.1-pro' });
  applyAntigravityThroughput(mixed, { home: f.home, now: start + 10000 });
  assert.equal(mixed.entries[0].performance, undefined);
});


test('CLI default and GEMINI_CLI_HOME roots provide native timing and Session Details', t => {
  for (const geminiDir of ['.gemini', 'custom-gemini']) {
    const f = fixture(t, { cli: true, geminiDir });
    f.step(0, 14, start, start);
    f.step(1, 15, start + 1000, start + 3000);
    f.add(1, {});
    const env = geminiDir === '.gemini' ? {} : { GEMINI_CLI_HOME: f.geminiHome };
    assert.equal(conversationFile('session', f.home, true, env), f.file);
    const json = scan(120, { client: 'antigravity-cli' });
    applyAntigravityThroughput(json, { home: f.home, env, now: start + 10000 });
    assert.equal(extractUsageFromTokscale(json).timedOutputTokens, 120);
    const detail = readSessionDetail({ client: 'antigravity', sessionId: 'session', home: f.home, env });
    assert.equal(detail.found, true);
    assert.equal(detail.exchanges[0].tokens.output, 120);
    assert.equal(detail.totals.totalTokens, 190);
    assert.equal(detail.exchanges[0].durationMs, 3000);
    assert.equal(detail.exchanges[0].turns[0].durationMs, 2000);
    assert.equal(readSessionDetail({ client: 'antigravity', sessionId: 'session', home: f.home, env, useEnvRoots: false }).found, geminiDir === '.gemini');
  }
});

test('collector reads timing from the Windows HOME scanned by Tokscale instead of the profile', async t => {
  const f = fixture(t);
  f.step(0, 14, start, start);
  f.step(1, 15, start + 1000, start + 3000);
  f.add(1, {});
  const previousHome = process.env.HOME;
  // A native drive path on Windows; a UNC-shaped spelling of the same POSIX
  // directory elsewhere lets the Windows resolver run without a fake file tree.
  process.env.HOME = process.platform === 'win32' ? f.home : '/' + f.home;
  try {
    const summary = await collectUsageOnce({
      clients: 'antigravity', allTimeSince: '2026-01-01', deviceId: 'speed-test',
      homeDir: path.join(f.home, 'profile'), platform: 'win32', now: () => new Date(start + 10000),
      limitsEnabled: false, historyEnabled: false, wslScanEnabled: false,
      runTokscale: async () => scan()
    });
    for (const period of [summary.today, summary.month, summary.allTime]) {
      assert.equal(period.outputTokens, 120);
      assert.equal(period.timedOutputTokens, 120);
      assert.equal(period.timedDurationMs, 2000);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
