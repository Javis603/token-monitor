'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { MAX_COMPRESSED_BYTES, MAX_DECODED_BYTES, readCompressedCodexTranscript } = require('../../src/shared/providers/codex/transcript');
const { resolveSessionFile, findCodexSessionFiles, preferredCodexSessionFile } = require('../../src/shared/sessionFiles');
const { nativeIdForFile } = require('../../src/shared/providers/codex/sessionIdentity');
const { readCodexSessionState } = require('../../src/shared/providers/codex/sessionContext');
const { applySessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
const { readSessionDetail } = require('../../src/shared/sessionDetail');
const { readSessionActivity } = require('../../src/shared/providers/codex/sessionActivity');
const { buildLocalUsageView } = require('../../src/shared/providers/codex/localUsage');

const NATIVE_ID = '11111111-1111-4111-8111-111111111111';
const ID = `rollout-2026-10-12T12-00-00-${NATIVE_ID}`;
const NOW = Date.parse('2026-10-12T12:00:04Z');
const entry = (type, payload, timestamp = '2026-10-12T12:00:01Z') => JSON.stringify({ type, payload, timestamp });
const header = entry('session_meta', { id: NATIVE_ID, cwd: '/work/project' });
const started = entry('event_msg', { type: 'task_started' });
const usage = entry('event_msg', { type: 'token_count', info: {
  last_token_usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 40, reasoning_output_tokens: 15, total_tokens: 140 },
  total_token_usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 40, reasoning_output_tokens: 15, total_tokens: 140 },
  model_context_window: 1000
} });
const question = entry('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'q', arguments: '{}' });
const text = [header, started, usage, question].join('\n') + '\n';

function fixture(t, root = 'sessions', id = ID) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-codex-zst-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const dir = root === 'sessions' ? path.join(codexHome, root, '2026', '10', '12') : path.join(codexHome, root);
  fs.mkdirSync(dir, { recursive: true });
  const plain = path.join(dir, `${id}.jsonl`);
  const compressed = plain + '.zst';
  const write = (bytes = zlib.zstdCompressSync(Buffer.from(text))) => {
    fs.writeFileSync(compressed, bytes);
    fs.utimesSync(compressed, new Date(NOW - 1000), new Date(NOW - 1000));
  };
  write();
  return { home, codexHome, dir, plain, compressed, write };
}

test('compressed Codex live and archived rollouts preserve identity, metadata and detail accounting', t => {
  for (const root of ['sessions', 'archived_sessions']) {
    const f = fixture(t, root);
    assert.equal(resolveSessionFile('codex', ID, f.home, { env: {} }), f.compressed);
    assert.equal(nativeIdForFile(f.compressed), NATIVE_ID);
    const periods = { today: { sessions: { [`codex:${ID}`]: { client: 'codex', sessionId: ID, totalTokens: 140 } } } };
    applySessionMetadata(periods, f.home, { scopedHome: true, now: NOW,
      readCodexMeta: () => new Map(), readT3Meta: () => new Map() });
    const row = periods.today.sessions[`codex:${ID}`];
    assert.equal(row.nativeSessionId, NATIVE_ID);
    assert.equal(row.totalTokens, 140);
    assert.equal(row.projectLabel, 'project');
    assert.equal(row.lastUsedAt, '2026-10-12T12:00:01.000Z');
    assert.equal(row.contextTokens, 140);
    assert.equal(row.contextWindow, 1000);
    assert.equal(row.turnEnded, false);
    assert.equal(row.waitingForInput, true);
    const detail = readSessionDetail({ client: 'codex', sessionId: ID, home: f.home, env: {}, deps: { now: () => NOW } });
    assert.equal(detail.found, true);
    assert.equal(detail.canonicalSessionId, NATIVE_ID);
    assert.equal(detail.sessionId, ID);
    assert.equal(detail.totals.totalTokens, 140);
    assert.equal(detail.exchanges.reduce((count, ex) => count + ex.turns.length, 0), 1);
    fs.writeFileSync(f.plain, text);
    const plain = readSessionDetail({ client: 'codex', sessionId: ID, home: f.home, env: {}, deps: { now: () => NOW } });
    assert.deepEqual(plain, detail);
  }
});

test('compressed Session Detail decodes through the injected filesystem and closes its handle', t => {
  const f = fixture(t);
  const injected = zlib.zstdCompressSync(Buffer.from([
    header, started,
    entry('event_msg', { type: 'token_count', info: {
      last_token_usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 50, total_tokens: 250 },
      total_token_usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 50, total_tokens: 250 }
    } })
  ].join('\n')));
  let opened = 0;
  let closed = 0;
  let active = false;
  const fd = 123;
  const injectedFs = {
    openSync(file) {
      assert.equal(file, f.compressed);
      assert.equal(active, false);
      active = true;
      opened += 1;
      return fd;
    },
    fstatSync(handle) {
      assert.equal(handle, fd);
      assert.equal(active, true);
      return { isFile: () => true, size: injected.length };
    },
    readSync(handle, buffer, offset, length, position) {
      assert.equal(handle, fd);
      assert.equal(active, true);
      return injected.copy(buffer, offset, position, position + length);
    },
    closeSync(handle) {
      assert.equal(handle, fd);
      assert.equal(active, true);
      active = false;
      closed += 1;
    }
  };

  const detail = readSessionDetail({ client: 'codex', sessionId: ID, home: f.home, env: {}, deps: { fs: injectedFs } });
  assert.equal(detail.found, true);
  assert.equal(detail.canonicalSessionId, NATIVE_ID);
  assert.equal(detail.totals.totalTokens, 250, 'use injected bytes rather than the on-disk 140-token transcript');
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(active, false);
});

test('Codex discovery prefers plain files deterministically and supports legacy compressed archive keys', t => {
  const f = fixture(t);
  fs.writeFileSync(f.plain, text);
  assert.equal(resolveSessionFile('codex', ID, f.home, { env: {} }), f.plain);
  assert.equal(findCodexSessionFiles(f.codexHome, new Set([ID])).get(ID), f.plain);
  const old = fixture(t, 'archived_sessions', 'legacy-key');
  assert.equal(resolveSessionFile('codex', 'legacy-key', old.home, { env: {} }), old.compressed);
  assert.equal(resolveSessionFile('codex', '../escape', old.home, { env: {} }), '');
  const active = path.join(old.codexHome, 'sessions');
  fs.mkdirSync(active);
  fs.writeFileSync(path.join(active, 'legacy-key.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(text)));
  fs.writeFileSync(old.plain, text);
  assert.equal(findCodexSessionFiles(old.codexHome, ['legacy-key']).get('legacy-key'), old.plain);
});

test('Codex concatenated compressed frames retain every turn and reset changed state', t => {
  const f = fixture(t);
  const later = usage.replaceAll('12:00:01', '12:00:02');
  const ended = entry('event_msg', { type: 'task_complete' }, '2026-10-12T12:00:03Z');
  const frames = [text, later + '\n', ended].map(part => zlib.zstdCompressSync(Buffer.from(part)));
  f.write(Buffer.concat(frames));
  assert.equal(readCompressedCodexTranscript(f.compressed).toString(), text + later + '\n' + ended);
  const cache = new Map();
  const state = readCodexSessionState(f.compressed, { cache });
  assert.equal(state.turnEnded, true);
  assert.equal(state.waitingForInput, false);
  assert.equal(state.context.contextTokens, 140);
  assert.strictEqual(readCodexSessionState(f.compressed, { cache }), state);
  const detail = readSessionDetail({ client: 'codex', sessionId: ID, home: f.home, env: {} });
  assert.equal(detail.totals.totalTokens, 280);
  assert.equal(detail.exchanges.reduce((count, ex) => count + ex.turns.length, 0), 2);
  f.write();
  assert.equal(readCodexSessionState(f.compressed, { cache }).waitingForInput, true);
  f.write(Buffer.from('corrupted'));
  assert.deepEqual(readCodexSessionState(f.compressed, { cache }), {});
  assert.equal(nativeIdForFile(f.compressed), '');
});

test('plain Codex symlink lookup remains compatible while compressed symlinks stay excluded', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const target = path.join(f.home, 'plain-source.jsonl');
  fs.writeFileSync(target, text);
  fs.symlinkSync(target, f.plain);
  assert.equal(resolveSessionFile('codex', ID, f.home, { env: {} }), f.plain);
  assert.equal(preferredCodexSessionFile(f.compressed), f.plain);
  const detail = readSessionDetail({ client: 'codex', sessionId: ID, home: f.home, env: {} });
  assert.equal(detail.found, true);
  assert.equal(detail.totals.totalTokens, 140);
  fs.unlinkSync(f.plain);
  const compressedTarget = path.join(f.home, 'compressed-source.jsonl.zst');
  fs.renameSync(f.compressed, compressedTarget);
  fs.symlinkSync(compressedTarget, f.compressed);
  assert.equal(resolveSessionFile('codex', ID, f.home, { env: {} }), '');
  assert.equal(preferredCodexSessionFile(f.compressed), '');
  assert.throws(() => readCompressedCodexTranscript(f.compressed));
});

test('corrupt, torn and oversized compressed Codex transcripts fail without partial detail or identity', t => {
  const f = fixture(t);
  const valid = zlib.zstdCompressSync(Buffer.from(text));
  const huge = zlib.zstdCompressSync(Buffer.alloc(MAX_DECODED_BYTES + 1, 0x61));
  for (const bytes of [Buffer.from('invalid'), valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from('corrupt tail')]), huge]) {
    f.write(bytes);
    assert.throws(() => readCompressedCodexTranscript(f.compressed));
    assert.equal(nativeIdForFile(f.compressed), '');
    assert.deepEqual(readCodexSessionState(f.compressed), {});
    const detail = readSessionDetail({ client: 'codex', sessionId: ID, home: f.home, env: {} });
    assert.equal(detail.found, false);
    assert.equal(detail.error, 'read-failed');
    assert.equal(detail.totals.totalTokens, 0);
  }
  fs.truncateSync(f.compressed, MAX_COMPRESSED_BYTES + 1);
  const read = t.mock.method(fs, 'readSync');
  assert.throws(() => readCompressedCodexTranscript(f.compressed), /input budget/);
  assert.equal(read.mock.callCount(), 0, 'reject oversized input before allocating/reading it');
});

test('compressed detail retains its record-size gate and bounded header identity', t => {
  const f = fixture(t);
  f.write(zlib.zstdCompressSync(Buffer.from(header + '\n' + 'x'.repeat(16 * 1024 * 1024 + 1))));
  const detail = readSessionDetail({ client: 'codex', sessionId: ID, home: f.home, env: {} });
  assert.equal(detail.error, 'line-too-large');
  assert.equal(detail.totals.totalTokens, 0);
  f.write(zlib.zstdCompressSync(Buffer.from(entry('session_meta', { id: NATIVE_ID, instructions: 'x'.repeat(8 * 1024 * 1024) }))));
  assert.equal(nativeIdForFile(f.compressed), '');
});

test('live compressed activity shares the plain key while archived files stay out of pre-token discovery', async t => {
  const f = fixture(t);
  const options = { homeDir: f.home, env: {}, now: NOW, sqlite: null };
  const snapshot = { today: { sessions: {} } };
  let result = await readSessionActivity(snapshot, options);
  assert.deepEqual(Object.keys(result.sessions), [`codex:${ID}`]);
  assert.equal(result.sessions[`codex:${ID}`].waitingForInput, true);
  fs.writeFileSync(f.plain, [header, entry('event_msg', { type: 'task_complete' })].join('\n'));
  fs.utimesSync(f.plain, new Date(NOW - 1000), new Date(NOW - 1000));
  result = await readSessionActivity({ today: { sessions: {} } }, options);
  assert.deepEqual(result.sessions, {}, 'completed plain sibling overrides waiting compressed copy');
  const archive = fixture(t, 'archived_sessions');
  result = await readSessionActivity({ today: { sessions: {} } }, { ...options, homeDir: archive.home });
  assert.deepEqual(result.sessions, {});
});

test('verified compressed native coverage suppresses matching supplemental Dots usage', t => {
  const f = fixture(t);
  const nativePeriod = { sessions: { 'codex:opaque-key': { client: 'codex', sessionId: 'opaque-key', nativeSessionId: nativeIdForFile(f.compressed) } } };
  const rows = [{ threadId: NATIVE_ID, observedAt: new Date(NOW - 1000).toISOString(), model: 'gpt-test',
    usage: { input: 70, cacheRead: 30, output: 40, reasoning: 15, total: 140 } }];
  assert.equal(buildLocalUsageView(rows, { now: NOW, projectIdentity }).allTime.totalTokens, 140);
  assert.equal(buildLocalUsageView(rows, { now: NOW, nativePeriod, projectIdentity }).allTime.totalTokens, 0);
});


test('Codex decode budgets apply across frames and reject content-corrupt complete frames', t => {
  const f = fixture(t);
  const half = zlib.zstdCompressSync(Buffer.alloc(MAX_DECODED_BYTES / 2, 0x61));
  f.write(Buffer.concat([half, half, zlib.zstdCompressSync(Buffer.from('extra'))]));
  assert.throws(() => readCompressedCodexTranscript(f.compressed), /decode budget/);
  const frame = zlib.zstdCompressSync(Buffer.from(text), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
  frame[frame.length - 1] ^= 0xff;
  f.write(frame);
  assert.throws(() => readCompressedCodexTranscript(f.compressed));
  assert.equal(nativeIdForFile(f.compressed), '');
  const tiny = zlib.zstdCompressSync(Buffer.from('x'));
  f.write(Buffer.concat(Array(4097).fill(tiny)));
  assert.throws(() => readCompressedCodexTranscript(f.compressed), /excessive/);
});

test('compressed Codex discovery respects configured roots and bounded non-symlink traversal', t => {
  const f = fixture(t);
  const env = { CODEX_HOME: f.codexHome };
  assert.equal(resolveSessionFile('codex', ID, path.join(f.home, 'other'), { env }), f.compressed);
  assert.equal(resolveSessionFile('codex', ID, path.join(f.home, 'other'), { env, useEnvRoots: false }), '');
  const root = path.join(f.codexHome, 'sessions');
  fs.symlinkSync(f.compressed, path.join(root, 'linked.jsonl.zst'));
  assert.equal(resolveSessionFile('codex', 'linked', f.home, { env: {} }), '');
  let dir = root;
  for (let index = 0; index < 33; index++) dir = path.join(dir, 'nested');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'too-deep.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(text)));
  assert.equal(resolveSessionFile('codex', 'too-deep', f.home, { env: {} }), '');
});
