'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');

const {
  decodeFirstFrameText,
  decodeSessionText,
  dshSessionFiles,
  readDshSessionHeader,
  resolveDshSessionsRoot,
  scanZstdFrames,
  zstdAvailable
} = require('../../src/shared/dshSessionFiles');

const hasZstd = zstdAvailable();

test('resolveDshSessionsRoot honors DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(
    resolveDshSessionsRoot({ env: { DSH_HOME: '/custom/dsh' }, homeDir: '/home/tester' }),
    path.join('/custom/dsh', 'sessions')
  );
  assert.equal(
    resolveDshSessionsRoot({ env: {}, homeDir: '/home/tester' }),
    path.join('/home/tester', '.dsh', 'sessions')
  );
});

// Regression: dshPaths.js's joiner only inserts a separator between the
// segments it joins itself — it does not normalize separators already
// present in an input like DSH_HOME. Exercised with an explicit `platform`
// override so this is caught on any host, not only a live Windows CI run.
test('resolveDshSessionsRoot normalizes to native separators on win32 even with a forward-slash DSH_HOME', () => {
  assert.equal(
    resolveDshSessionsRoot({ env: { DSH_HOME: '/custom/dsh' }, homeDir: '/home/tester', platform: 'win32' }),
    '\\custom\\dsh\\sessions'
  );
});

test('dshSessionFiles finds session.jsonl and session.jsonl.zstd two levels deep, ignores other files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-files-'));
  const dirA = path.join(root, 'projA', 'session-1');
  const dirB = path.join(root, 'projB', 'session-2');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirA, 'session.jsonl'), '{}');
  fs.writeFileSync(path.join(dirB, 'session.jsonl.zstd'), Buffer.from([]));
  fs.writeFileSync(path.join(dirB, 'session.jsonl.lock'), 'x');
  fs.writeFileSync(path.join(root, 'projA', 'stray.txt'), 'x'); // too shallow, not a session artifact

  const found = dshSessionFiles(root).sort();
  assert.deepEqual(found, [path.join(dirA, 'session.jsonl'), path.join(dirB, 'session.jsonl.zstd')].sort());
});

test('dshSessionFiles tolerates a missing root', () => {
  assert.deepEqual(dshSessionFiles(path.join(os.tmpdir(), 'does-not-exist-dsh-root')), []);
});

// This is the #410-style regression: dsh flushes one zstd frame per turn, so a
// multi-turn session is a concatenation of independently decodable frames. A
// decoder that runs zstdDecompressSync once over the whole buffer only
// recovers the first frame and silently drops every later message.
test('decodeSessionText recovers every frame in a multi-frame zstd transcript', { skip: !hasZstd }, () => {
  const lines = [
    JSON.stringify({ type: 'session', id: 's1' }),
    JSON.stringify({ type: 'user/message', seq: 1 }),
    JSON.stringify({ type: 'assistant/message', seq: 2 }),
    JSON.stringify({ type: 'assistant/message', seq: 3 })
  ];
  const buffer = Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))));
  const frames = scanZstdFrames(buffer);
  assert.equal(frames.length, lines.length, 'each line should decode as its own frame');

  const text = decodeSessionText('/tmp/session.jsonl.zstd', buffer);
  const decodedLines = text.split('\n').filter(Boolean);
  assert.equal(decodedLines.length, lines.length);
  assert.deepEqual(decodedLines, lines);
});

test('scanZstdFrames stops at a torn trailing frame instead of throwing', { skip: !hasZstd }, () => {
  const complete = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n', 'utf8'));
  const torn = zlib.zstdCompressSync(Buffer.from('{"type":"assistant/message","seq":2}\n', 'utf8')).subarray(0, 4);
  const buffer = Buffer.concat([complete, torn]);
  const frames = scanZstdFrames(buffer);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].end, complete.length);
});

// dsh flushes one zstd frame per append batch, and a live scan reads that
// batch mid-write: the final frame is often torn. dsh's own reader
// (decompressZstdPrefix, ZSTD_e_flush) and tokscale's streaming decoder keep
// the newline-complete records a torn final frame managed to write, dropping
// only the fragment at the cut — so decodeSessionText must recover them too,
// at zstd's block granularity. A large high-entropy final record forces the
// frame to span multiple blocks so a mid-tail cut leaves the earlier complete
// records recoverable, mirroring dsh's own zstd.spec.ts fixture.
test('decodeSessionText recovers complete records inside a torn final frame', { skip: !hasZstd }, () => {
  const header = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n', 'utf8'));
  const lineA = '{"type":"user/message","seq":1}\n';
  const lineB = '{"type":"assistant/message","seq":2}\n';
  const sentinel = 'TORN_SENTINEL_NEVER_RECOVERED';
  // High-entropy third record (no trailing newline) so the compressed frame is
  // large enough to span multiple zstd blocks; the sentinel sits deep in the
  // record so a partial recovery of it still cannot reach it.
  const noise = crypto.randomBytes(200 * 1024).toString('base64');
  const partial = JSON.stringify({ type: 'assistant/message', seq: 3, pad: noise + sentinel });
  const fullFrame = zlib.zstdCompressSync(Buffer.from(lineA + lineB + partial, 'utf8'));

  // Find a cut that leaves the two complete records recoverable but the third
  // truncated — the way a crash or a mid-write scan actually tears the file.
  let torn = null;
  for (const frac of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    const candidate = fullFrame.subarray(0, Math.floor(fullFrame.length * frac));
    let out;
    try { out = zlib.zstdDecompressSync(candidate, { finishFlush: zlib.constants.ZSTD_e_flush }).toString('utf8'); } catch (_) { continue; }
    if (out.includes(lineA) && out.includes(lineB) && !out.includes(sentinel)) { torn = candidate; break; }
  }
  assert.ok(torn, 'a mid-tail cut that keeps the two complete records recoverable must exist');

  const buffer = Buffer.concat([header, torn]);
  // Anti-vacuous: the torn frame is not a complete frame, so the scanner alone
  // only sees the header — without partial recovery, the two records inside the
  // torn frame would be invisible.
  assert.equal(scanZstdFrames(buffer).length, 1);

  const text = decodeSessionText('/tmp/session.jsonl.zstd', buffer);
  assert.ok(text.includes(lineA), 'the first complete record inside the torn frame must survive');
  assert.ok(text.includes(lineB), 'the second complete record inside the torn frame must survive');
  assert.ok(!text.includes(sentinel), 'the truncated third record must be dropped');
});

// Session-id lookup only needs the header, which is always the first event
// dsh writes. decodeFirstFrameText must not touch later frames, so a long
// transcript's discovery cost stays O(one frame) even when a trailing frame
// is corrupt or unrelated garbage.
test('decodeFirstFrameText decodes only the first frame, ignoring a corrupt later one', { skip: !hasZstd }, () => {
  const header = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n', 'utf8'));
  const corruptTail = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);
  const buffer = Buffer.concat([header, corruptTail]);
  assert.equal(decodeFirstFrameText('/tmp/session.jsonl.zstd', buffer), '{"type":"session","id":"s1"}\n');
});

test('decodeFirstFrameText returns empty text when even the first frame is torn', { skip: !hasZstd }, () => {
  const torn = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n', 'utf8')).subarray(0, 4);
  assert.equal(decodeFirstFrameText('/tmp/session.jsonl.zstd', torn), '');
});

test('decodeFirstFrameText reads raw .jsonl without decompression', () => {
  const text = decodeFirstFrameText('/tmp/session.jsonl', Buffer.from('{"type":"session"}\n', 'utf8'));
  assert.equal(text, '{"type":"session"}\n');
});

test('decodeSessionText reads raw .jsonl without decompression', () => {
  const text = decodeSessionText('/tmp/session.jsonl', Buffer.from('{"type":"session"}\n', 'utf8'));
  assert.equal(text, '{"type":"session"}\n');
});

// A header's first zstd frame is always tiny in practice (a small JSON
// record), but if a compressed frame ever exceeded the 64KB bounded
// head-read, falling back to a full read keeps the session discoverable
// instead of silently invisible.
test('readDshSessionHeader recovers a header whose compressed frame exceeds the 64KB bound', { skip: !hasZstd }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bigheader-'));
  const dir = path.join(root, 'proj', 'session-big');
  fs.mkdirSync(dir, { recursive: true });
  // High-entropy padding so the *compressed* frame itself exceeds 64KB —
  // a repeated-character pad would compress back down to a few bytes.
  const noise = crypto.randomBytes(80000).toString('base64');
  const header = `${JSON.stringify({ type: 'session', id: 'session-big', createdAt: 1750000000000, cwd: `/work/${noise}` })}\n`;
  const compressed = zlib.zstdCompressSync(Buffer.from(header, 'utf8'));
  assert.ok(compressed.length > 65536, 'the fixture must actually exceed the bounded read to be a real test');
  const filePath = path.join(dir, 'session.jsonl.zstd');
  fs.writeFileSync(filePath, compressed);

  const found = readDshSessionHeader(filePath);
  assert.equal(found?.id, 'session-big');
  assert.equal(found?.createdAt, 1750000000000);
});

// DSH names the transcript directory after the session id (dsh.rs
// `session_id_from_path`). When the header itself can't be parsed at all —
// torn, corrupt, or an unrecognized shape — the directory name is still a
// reliable session id, so the session stays discoverable rather than
// vanishing outright.
test('readDshSessionHeader falls back to the directory name when the header cannot be parsed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-badheader-'));
  const dir = path.join(root, 'proj', 'session-unreadable-header');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(filePath, 'this is not a session header at all\n');

  const found = readDshSessionHeader(filePath);
  assert.equal(found?.id, 'session-unreadable-header');
  assert.equal(found?.createdAt, undefined);
});
