'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const test = require('node:test');
const { readDshSessionDetail, parseDshDetailEvents } = require('../../src/shared/providers/dsh/sessionDetail');
const { decodeSessionText } = require('../../src/shared/providers/dsh/sessionFiles');
const { readDshTranscriptRecords } = require('../../src/shared/providers/dsh/transcriptReader');
const { readSessionDetailForPlatform, resolveSessionDetailForPlatform } = require('../../src/shared/sessionDetailResolver');

const header = JSON.stringify({ type: 'session', id: 'large', isSeeded: false });
const turn = JSON.stringify({ type: 'assistant/message', seq: 2, time: 1000, data: {
  usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 5 }, message: { id: 'reply', content: [] }
} });
function fixture(t, compressed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'proj', 'large');
  fs.mkdirSync(dir, { recursive: true });
  return { file: path.join(dir, compressed ? 'session.v3.jsonl.zstd' : 'session.jsonl'), root };
}
async function detail(file) {
  return readDshSessionDetail({ sessionId: 'large', sessionCost: 1, deps: { findDshSessionFile: () => file } });
}

for (const compressed of [false, true]) {
  test(`reads ${compressed ? 'Zstd' : 'plain'} transcripts over 512 MiB decoded without whole-file reads`, async (t) => {
    const { file, root } = fixture(t, compressed);
    const output = Buffer.from(JSON.stringify({ type: 'tool/output', data: { output: 'x'.repeat(1024 * 1024) } }) + '\n');
    const encoded = compressed ? zlib.zstdCompressSync(output) : output;
    const encode = text => compressed ? zlib.zstdCompressSync(Buffer.from(text)) : Buffer.from(text);
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, encode(header + '\n'));
      for (let i = 0; i < 513; i += 1) fs.writeSync(fd, encoded);
      fs.writeSync(fd, encode(turn));
    } finally { fs.closeSync(fd); }
    assert.ok(output.length * 513 > require('node:buffer').constants.MAX_STRING_LENGTH);
    const readFileSync = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (filePath, ...args) => {
      assert.notEqual(filePath, file, 'selected transcript must never be read in full');
      return readFileSync(filePath, ...args);
    });
    const result = await readDshSessionDetail({ sessionId: 'large', sessionsRoot: root, sessionCost: 1 });
    assert.equal(result.found, true);
    assert.equal(result.totals.totalTokens, 110);
    assert.equal(result.totals.turnCount, 1);
    assert.equal(result.totals.costUsd, 1);
  });

  test(`${compressed ? 'Zstd' : 'plain'} preserves UTF-8 boundaries, short reads, CRLF and final record`, async (t) => {
    const { file } = fixture(t, compressed);
    const prompt = JSON.stringify({ type: 'user/message', seq: 1, time: 500, data: {
      source: { kind: 'user' }, content: [{ type: 'text', text: '繁體中文🙂' }]
    } });
    const text = header + '\r\n' + ' '.repeat(65530) + prompt + '\r\n' + turn;
    fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(Buffer.from(text)) : text);
    const readSync = fs.readSync;
    t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, Math.min(length, 257), position));
    const result = await detail(file);
    assert.equal(result.found, true);
    assert.equal(result.exchanges[0].promptPreview, '繁體中文🙂');
    assert.equal(result.totals.totalTokens, 110);
  });

  test(`${compressed ? 'Zstd' : 'plain'} rejects oversized records without partial details`, async (t) => {
    const { file } = fixture(t, compressed);
    const text = header + '\n' + turn + '\n' + 'x'.repeat(16 * 1024 * 1024 + 1);
    fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(Buffer.from(text)) : text);
    const result = await detail(file);
    assert.equal(result.error, 'line-too-large');
    assert.deepEqual(result.exchanges, []);
  });
}

test('one Zstd frame may expand beyond the V8 string limit', async (t) => {
  const { file } = fixture(t, true);
  const compressor = zlib.createZstdCompress();
  const output = fs.createWriteStream(file);
  const { pipeline } = require('node:stream/promises');
  const { Readable } = require('node:stream');
  const padding = JSON.stringify({ type: 'tool/output', data: 'x'.repeat(1024 * 1024) }) + '\n';
  await pipeline(Readable.from((function* () {
    yield header + '\n';
    for (let i = 0; i < 513; i += 1) yield padding;
    yield turn;
  })()), compressor, output);
  const result = await detail(file);
  assert.equal(result.found, true);
  assert.equal(result.totals.totalTokens, 110);
});

test('stops before a checksum-corrupt frame, never recovering later frames', async (t) => {
  const { file } = fixture(t, true);
  const good = zlib.zstdCompressSync(Buffer.from(header + '\n' + turn + '\n'));
  const bad = zlib.zstdCompressSync(Buffer.from(turn.replace('100', '999') + '\n'));
  bad[4] |= 4;
  fs.writeFileSync(file, Buffer.concat([good, bad, Buffer.from([0xde, 0xad, 0xbe, 0xef]), good]));
  const expected = parseDshDetailEvents(decodeSessionText(file, fs.readFileSync(file)));
  const result = await detail(file);
  assert.equal(result.found, true);
  assert.equal(result.totals.totalTokens, 110);
  assert.equal(expected.length, 1);
});

test('recovers complete records from a torn multi-block trailing frame', async (t) => {
  const { file } = fixture(t, true);
  const noise = crypto.randomBytes(200 * 1024).toString('base64');
  const full = zlib.zstdCompressSync(Buffer.from(turn + '\n' + JSON.stringify({ type: 'tool/output', data: noise })));
  const torn = full.subarray(0, Math.floor(full.length / 2));
  const prefix = zlib.zstdDecompressSync(torn, { finishFlush: zlib.constants.ZSTD_e_flush }).toString('utf8');
  assert.ok(prefix.includes(turn));
  fs.writeFileSync(file, Buffer.concat([zlib.zstdCompressSync(Buffer.from(header + '\n')), torn]));
  assert.equal((await detail(file)).totals.totalTokens, 110);
});

test('discards irrelevant output and attachment bytes from retained records', async (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, header + '\n' + JSON.stringify({ type: 'tool/output', data: 'SECRET' }) + '\n'
    + JSON.stringify({ type: 'user/message', time: 500, data: { source: { kind: 'user' }, content: [{ type: 'image', bytes: 'SECRET' }] } }) + '\n' + turn);
  const records = [];
  for await (const record of readDshTranscriptRecords(file)) records.push(record);
  assert.equal(records.length, 3);
  assert.equal(JSON.stringify(records).includes('SECRET'), false);
});

test('closes file descriptors after early discovery, failure and cancellation', async (t) => {
  const { file } = fixture(t, true);
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(header + '\n' + turn)));
  const openSync = fs.openSync;
  const closeSync = fs.closeSync;
  const opened = new Set();
  t.mock.method(fs, 'openSync', (...args) => { const fd = openSync(...args); opened.add(fd); return fd; });
  t.mock.method(fs, 'closeSync', fd => { assert.ok(opened.delete(fd)); return closeSync(fd); });
  for await (const _record of readDshTranscriptRecords(file, { headerOnly: true })) break;
  assert.equal(opened.size, 0);
  for await (const _record of readDshTranscriptRecords(file)) break;
  assert.equal(opened.size, 0);
  t.mock.method(fs, 'readSync', () => { throw Object.assign(new Error('read failed'), { code: 'EIO' }); });
  assert.equal((await detail(file)).error, 'read-failed');
  assert.equal(opened.size, 0);
});

test('keeps ENOENT missing, and stops WSL fallback on actual DSH read errors', async (t) => {
  const { file } = fixture(t);
  assert.equal(Object.hasOwn(await detail(file), 'error'), false);
  for (const failure of ['read-failed', 'line-too-large']) {
    let enumerated = false;
    const result = await resolveSessionDetailForPlatform({ client: 'dsh', sessionId: 'large' }, {
      platform: 'win32', homedir: () => '/native', readDshSessionDetail: async () => ({ found: false, error: failure }),
      wslUsageHomes: () => { enumerated = true; return ['/wsl']; }
    });
    assert.equal(result.error, failure);
    assert.equal(enumerated, false);
  }
});

test('the production worker awaits compressed DSH detail', async (t) => {
  const { file, root } = fixture(t, true);
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(header + '\n' + turn)));
  const result = await readSessionDetailForPlatform({ client: 'dsh', sessionId: 'large', sessionsRoot: root });
  assert.equal(result.found, true);
  assert.equal(result.totals.totalTokens, 110);
});

test('compressed lineage, attempt, summary and replay accounting matches the original parser', async (t) => {
  const { file } = fixture(t, true);
  const records = [
    { type: 'user/message', seq: 0, time: 500, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'before header' }] } },
    { type: 'session', id: 'large', isSeeded: true },
    JSON.parse(turn),
    { type: 'session/end-seed', seq: 3, data: { inherited: true } },
    { ...JSON.parse(turn), seq: 4 },
    { type: 'session/end-seed', seq: 5, data: { inherited: true } },
    { type: 'user/message', seq: 6, time: 1500, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'child prompt' }] } },
    { type: 'assistant/attempt', seq: 7, time: 1600, data: { stream: [
      { chunk: { usage: { inputTokens: 2, outputTokens: 1 } } }, { chunk: { usage: 'invalid' } }
    ] } },
    { ...JSON.parse(turn), seq: 8, time: 1700 },
    { ...JSON.parse(turn), seq: 8, time: 1700 },
    { type: 'compaction/summary', seq: 9, time: 1800, data: { usage: { inputTokens: 4, outputTokens: 2 } } }
  ];
  const text = records.map(record => JSON.stringify(record)).join('\n');
  // Split records and UTF-8 arbitrarily across frame boundaries.
  const bytes = Buffer.from(text);
  fs.writeFileSync(file, Buffer.concat([
    zlib.zstdCompressSync(bytes.subarray(0, 127)), zlib.zstdCompressSync(bytes.subarray(127, 544)),
    zlib.zstdCompressSync(bytes.subarray(544))
  ]));
  const expected = parseDshDetailEvents(text);
  const result = await detail(file);
  assert.equal(result.found, true);
  assert.equal(result.totals.totalTokens, 119);
  assert.equal(result.totals.turnCount, 1);
  assert.deepEqual(result.exchanges.flatMap(exchange => exchange.turns).map(row => row.type), ['assistant-attempt', 'reply', 'compaction-summary']);
  assert.equal(expected.filter(record => record.kind === 'turn').reduce((total, row) => total + row.tokens.total, 0), 119);
});

test('an asynchronous filesystem error discards usage and closes the file', async (t) => {
  const { file } = fixture(t, true);
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(header + '\n' + turn)));
  const readSync = fs.readSync;
  const closeSync = fs.closeSync;
  let closed = false;
  t.mock.method(fs, 'readSync', (fd, buffer, ...args) => {
    if (buffer.length > 16) throw Object.assign(new Error('disk read failed'), { code: 'EIO' });
    return readSync(fd, buffer, ...args);
  });
  t.mock.method(fs, 'closeSync', fd => { closed = true; return closeSync(fd); });
  const result = await detail(file);
  assert.equal(result.error, 'read-failed');
  assert.deepEqual(result.exchanges, []);
  assert.equal(closed, true);
});
