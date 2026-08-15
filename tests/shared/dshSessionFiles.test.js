'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');

const {
  decodeSessionText,
  dshSessionFiles,
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

test('decodeSessionText reads raw .jsonl without decompression', () => {
  const text = decodeSessionText('/tmp/session.jsonl', Buffer.from('{"type":"session"}\n', 'utf8'));
  assert.equal(text, '{"type":"session"}\n');
});
