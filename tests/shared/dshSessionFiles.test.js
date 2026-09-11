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
  dshSessionLogRank,
  indexDshSessionHeaders,
  isDshSessionLogName,
  readDshSessionHeader,
  readDshSessionTitle,
  resolveDshSessionsRoot,
  scanZstdFrames,
  zstdAvailable
} = require('../../src/shared/providers/dsh/sessionFiles');

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

// The torn-frame case above is a frame cut off mid-write. The other failure
// mode is a frame whose framing is complete but whose content is corrupt — a
// checksum mismatch, say — which scanZstdFrames cannot see (it only walks the
// frame/block structure). tokscale's streaming decoder keeps every record it
// read before hitting that error, so decodeSessionText must do the same: stop
// at the first undecodable frame and keep the valid prefix, instead of letting
// the error throw the header and earlier turns away with it.
test('decodeSessionText keeps the valid prefix when a complete frame is content-corrupt', { skip: !hasZstd }, () => {
  const header = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n', 'utf8'));
  const goodTurn = zlib.zstdCompressSync(Buffer.from('{"type":"assistant/message","seq":2}\n', 'utf8'));
  // Set the frame-descriptor checksum flag and append a wrong checksum: the
  // frame stays framing-complete (so scanZstdFrames sees it) but
  // zstdDecompressSync rejects it as ZSTD_error_checksum_wrong.
  const badTurn = zlib.zstdCompressSync(Buffer.from('{"type":"assistant/message","seq":3}\n', 'utf8'));
  badTurn[4] |= 0x04;
  const corrupt = Buffer.concat([badTurn, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
  const buffer = Buffer.concat([header, goodTurn, corrupt]);

  // Anti-vacuous: the corrupt frame is structurally complete, so the scanner
  // alone sees all three frames — its corruption is invisible to framing.
  assert.equal(scanZstdFrames(buffer).length, 3);

  const text = decodeSessionText('/tmp/session.jsonl.zstd', buffer);
  assert.ok(text.includes('{"type":"session","id":"s1"}'), 'the header frame must survive');
  assert.ok(text.includes('{"type":"assistant/message","seq":2}'), 'the good turn before the corrupt frame must survive');
  assert.ok(!text.includes('"seq":3'), 'the corrupt frame must be dropped');
});

// The two failure modes combine: a content-corrupt complete frame followed by
// a torn tail. The corruption boundary must win — once a complete frame fails
// to decode, nothing after it is trusted, not even a torn tail whose complete
// records a ZSTD_e_flush recovery could still read. (Before this was fixed,
// tailStart came from the last *scanned* frame, so the decoder leapt the
// corrupt frame and resurrected records from beyond the boundary.)
test('decodeSessionText does not recover a torn tail past a content-corrupt frame', { skip: !hasZstd }, () => {
  const header = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n', 'utf8'));
  const goodTurn = zlib.zstdCompressSync(Buffer.from('{"type":"assistant/message","seq":2}\n', 'utf8'));
  // Framing-complete, content-corrupt frame — the same checksum fixture as the
  // prefix test above.
  const badTurn = zlib.zstdCompressSync(Buffer.from('{"type":"assistant/message","seq":3}\n', 'utf8'));
  badTurn[4] |= 0x04;
  const corrupt = Buffer.concat([badTurn, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);

  // A torn tail whose complete prefix is recoverable with ZSTD_e_flush, built
  // the same way as the torn-frame test: a large multi-block frame cut
  // mid-stream so the leading record survives a partial recovery.
  const lineA = '{"type":"user/message","seq":4}\n';
  const tailSentinel = 'TAIL_SENTINEL_MUST_NOT_SURVIVE';
  const noise = crypto.randomBytes(200 * 1024).toString('base64');
  const partial = JSON.stringify({ type: 'assistant/message', seq: 5, pad: noise + tailSentinel });
  const fullTail = zlib.zstdCompressSync(Buffer.from(lineA + partial, 'utf8'));
  let torn = null;
  for (const frac of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    const candidate = fullTail.subarray(0, Math.floor(fullTail.length * frac));
    let out;
    try { out = zlib.zstdDecompressSync(candidate, { finishFlush: zlib.constants.ZSTD_e_flush }).toString('utf8'); } catch (_) { continue; }
    if (out.includes(lineA) && !out.includes(tailSentinel)) { torn = candidate; break; }
  }
  assert.ok(torn, 'a torn tail whose complete prefix is recoverable must exist');

  const buffer = Buffer.concat([header, goodTurn, corrupt, torn]);

  // Anti-vacuous in both directions: the scanner sees the corrupt frame as a
  // complete frame (its corruption is invisible to framing), and a partial
  // recovery of the torn tail alone reaches the record past the boundary — so
  // a decoder that kept using the last scanned frame as tailStart would
  // resurrect it.
  assert.equal(scanZstdFrames(buffer).length, 3);
  const tailAlone = zlib.zstdDecompressSync(torn, { finishFlush: zlib.constants.ZSTD_e_flush }).toString('utf8');
  assert.ok(tailAlone.includes(lineA), 'the torn tail alone must be partially recoverable');

  const text = decodeSessionText('/tmp/session.jsonl.zstd', buffer);
  assert.ok(text.includes('{"type":"session","id":"s1"}'), 'the header frame must survive');
  assert.ok(text.includes('{"type":"assistant/message","seq":2}'), 'the good turn before the corrupt frame must survive');
  assert.ok(!text.includes('"seq":3'), 'the corrupt frame must be dropped');
  assert.ok(!text.includes('"seq":4'), 'the recoverable record past the corruption boundary must be dropped');
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

test('readDshSessionTitle folds and preserves the latest persisted title', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-title-'));
  const file = path.join(root, 'session.jsonl');
  try {
    const persistedTitle = `Renamed title ${'x'.repeat(200)}`;
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'session/title', seq: 1, data: { title: '  First\n title  ' } }),
      JSON.stringify({ type: 'user/message', seq: 2, data: { content: 'private prompt' } }),
      JSON.stringify({ type: 'session/title', seq: 3, data: { title: persistedTitle } }),
      ''
    ].join('\n'));

    const state = readDshSessionTitle(file);
    assert.equal(state.title, persistedTitle);
    assert.equal(state.offset, state.size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readDshSessionTitle never derives a title from conversation text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-title-private-'));
  const file = path.join(root, 'session.jsonl');
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'Private prompt' }] } }),
      JSON.stringify({ type: 'session/title-llm-request', seq: 2, data: { messages: [{ text: 'Private prompt' }] } }),
      ''
    ].join('\n'));

    assert.equal(readDshSessionTitle(file).title, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readDshSessionTitle reuses the append boundary after checking content continuity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-title-append-'));
  const file = path.join(root, 'session.jsonl');
  const realReadSync = fs.readSync;
  try {
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session/title', seq: 1, data: { title: 'Initial' } })}\n`);
    const first = readDshSessionTitle(file);
    const appended = `${JSON.stringify({ type: 'session/title', seq: 2, data: { title: 'Updated' } })}\n`;
    fs.appendFileSync(file, appended);

    const reads = [];
    fs.readSync = (fd, buffer, offset, length, position) => {
      reads.push({ length, position });
      return realReadSync(fd, buffer, offset, length, position);
    };
    const second = readDshSessionTitle(file, first);

    assert.equal(second.title, 'Updated');
    assert.equal(reads.filter(({ length, position }) => (
      length === Buffer.byteLength(appended) && position === first.offset
    )).length, 1);
  } finally {
    fs.readSync = realReadSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readDshSessionTitle folds appended zstd frames without re-decoding the prefix', { skip: !hasZstd }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-title-zstd-'));
  const file = path.join(root, 'session.jsonl.zstd');
  try {
    const firstFrame = zlib.zstdCompressSync(Buffer.from(
      `${JSON.stringify({ type: 'session/title', seq: 1, data: { title: 'Initial' } })}\n`,
      'utf8'
    ));
    fs.writeFileSync(file, firstFrame);
    const first = readDshSessionTitle(file);
    assert.equal(first.title, 'Initial');
    assert.equal(first.offset, firstFrame.length);

    const secondFrame = zlib.zstdCompressSync(Buffer.from(
      `${JSON.stringify({ type: 'session/title', seq: 2, data: { title: 'Updated' } })}\n`,
      'utf8'
    ));
    fs.appendFileSync(file, secondFrame);
    const second = readDshSessionTitle(file, first);
    assert.equal(second.title, 'Updated');
    assert.equal(second.offset, firstFrame.length + secondFrame.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readDshSessionTitle resets latest-wins state after a same-size rewrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-title-rewrite-'));
  const file = path.join(root, 'session.jsonl');
  try {
    const event = (title) => `${JSON.stringify({ type: 'session/title', data: { title } })}\n`;
    fs.writeFileSync(file, event('First title'));
    const first = readDshSessionTitle(file);
    fs.writeFileSync(file, event('Other title'));
    const nextMtime = new Date(first.mtimeMs + 1000);
    fs.utimesSync(file, nextMtime, nextMtime);

    const second = readDshSessionTitle(file, first);
    assert.equal(second.title, 'Other title');
    assert.equal(second.offset, second.size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readDshSessionTitle refolds a larger in-place rewrite instead of treating it as an append', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-title-larger-rewrite-'));
  const file = path.join(root, 'session.jsonl');
  try {
    const event = (title, paddingBytes) => [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'session/title', data: { title } }),
      JSON.stringify({ type: 'assistant/message', data: { content: 'x'.repeat(paddingBytes) } }),
      '',
      's'.repeat(64 * 1024)
    ].join('\n');
    fs.writeFileSync(file, event('Title A', 160 * 1024));
    const first = readDshSessionTitle(file);
    // Keep the old file's final 64 KiB identical: a tail-only check would still
    // misclassify this as an append and skip the new title near the front.
    fs.writeFileSync(file, event('Title B', 192 * 1024));
    const nextMtime = new Date(first.mtimeMs + 1000);
    fs.utimesSync(file, nextMtime, nextMtime);
    assert.ok(fs.statSync(file).size > first.size);

    const second = readDshSessionTitle(file, first);
    assert.equal(second.title, 'Title B');
    assert.equal(second.offset, second.size - (64 * 1024));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

// A v3 harness re-encodes a session into `session.v3.jsonl.zstd` rather than
// rotating the unversioned file, so a fixed name list stopped seeing every
// session written after the upgrade — no aggregate usage and no openable
// session detail. The version segment is matched generically, so the next
// rename is a segment rather than a code path.
test('dshSessionFiles accepts a versioned transcript name and rejects near-misses', () => {
  assert.equal(isDshSessionLogName('session.jsonl'), true);
  assert.equal(isDshSessionLogName('session.jsonl.zstd'), true);
  assert.equal(isDshSessionLogName('session.v3.jsonl.zstd'), true);
  assert.equal(isDshSessionLogName('session.v12.jsonl'), true);
  assert.equal(isDshSessionLogName('session.jsonl.lock'), false);
  assert.equal(isDshSessionLogName('audit.jsonl'), false);
  assert.equal(isDshSessionLogName('session.v3.jsonl.zstd.tmp'), false);
  assert.equal(isDshSessionLogName('session.3.jsonl.zstd'), false);
  assert.ok(dshSessionLogRank('session.v3.jsonl.zstd') > dshSessionLogRank('session.jsonl.zstd'));
  assert.ok(dshSessionLogRank('session.v12.jsonl') > dshSessionLogRank('session.v3.jsonl.zstd'));
});

test('dshSessionFiles lists a session live versioned transcript before its pre-upgrade copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-files-v3-'));
  const dir = path.join(root, 'projA', 'session-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), Buffer.alloc(0));
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.alloc(0));

  // Order matters: every caller that stops at the first match (session detail)
  // must land on the file the harness is still writing.
  assert.deepEqual(dshSessionFiles(root), [
    path.join(dir, 'session.v3.jsonl.zstd'),
    path.join(dir, 'session.jsonl.zstd')
  ]);
});

test('indexDshSessionHeaders prefers the versioned transcript of a session', { skip: !hasZstd }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-index-v3-'));
  const dir = path.join(root, 'projA', 'session-1');
  fs.mkdirSync(dir, { recursive: true });
  const versioned = path.join(dir, 'session.v3.jsonl.zstd');
  fs.writeFileSync(versioned, zlib.zstdCompressSync(Buffer.from(
    `${JSON.stringify({ type: 'session', id: 'session-1', createdAt: 1750000000000 })}\n`,
    'utf8'
  )));
  // The pre-upgrade copy has no createdAt: a stale re-encode must not shadow it.
  fs.writeFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'session', id: 'session-1' })}\n`);

  const index = indexDshSessionHeaders({ sessionsRoot: root });
  assert.equal(index.get('session-1').filePath, versioned, 'the live transcript must win over the stale copy');
  assert.equal(index.get('session-1').createdAt, 1750000000000);
});
