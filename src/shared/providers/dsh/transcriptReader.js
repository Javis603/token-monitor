'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const ZSTD_MAGIC = 0xFD2FB528;

// Find a frame's byte range without retaining its compressed payload. Each block
// header gives its payload length, so even a huge frame needs only small reads.
function frameRange(fd, start, size) {
  let position = start;
  function read(length) {
    if (position + length > size) return null;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
      if (!count) return null;
      offset += count;
    }
    position += length;
    return buffer;
  }
  const magic = read(4);
  if (!magic || magic.readUInt32LE() !== ZSTD_MAGIC) return null;
  const descriptor = read(1)?.[0];
  if (descriptor === undefined) return { end: size, complete: false };
  if (descriptor & 0x18) return null;
  const singleSegment = descriptor & 0x20;
  const dictionaryFlag = descriptor & 3;
  const sizeFlag = descriptor >>> 6;
  const headerBytes = (singleSegment ? 0 : 1)
    + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
    + (sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag);
  if (!read(headerBytes)) return { end: size, complete: false };
  for (;;) {
    const header = read(3);
    if (!header) return { end: size, complete: false };
    const block = header.readUIntLE(0, 3);
    const type = (block >>> 1) & 3;
    if (type === 3) return null;
    position += type === 1 ? 1 : block >>> 3;
    if (position > size) return { end: size, complete: false };
    if (block & 1) break;
  }
  if ((descriptor & 4) && !read(4)) return { end: size, complete: false };
  return { end: position, complete: true };
}

function lineCollector() {
  let parts = [];
  let bytes = 0;
  return {
    *push(chunk) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        bytes += end - start;
        if (bytes > MAX_LINE_BYTES) {
          throw Object.assign(new Error('Session detail record exceeds 16 MiB'), { code: 'SESSION_DETAIL_LINE_TOO_LARGE' });
        }
        parts.push(chunk.subarray(start, end));
        if (newline < 0) break;
        yield Buffer.concat(parts, bytes).toString('utf8');
        parts = [];
        bytes = 0;
        start = newline + 1;
      }
    },
    finish() { return bytes ? Buffer.concat(parts, bytes).toString('utf8') : ''; }
  };
}

// Keep only fields used by the detail parser, not tool output, attachments,
// embedded stream chunks or other raw transcript content.
function detailRecord(line, headerOnly) {
  let record;
  try { record = JSON.parse(line); } catch (_) { return headerOnly && line.trim() ? { type: '' } : null; }
  if (headerOnly) return record || { type: '' };
  const { type, seq, time, data } = record || {};
  if (type === 'session') return { type, id: record.id, seedLength: record.seedLength, isSeeded: record.isSeeded };
  if (type === 'session/end-seed') return { type, seq, data: { inherited: data?.inherited } };
  if (type === 'user/message') return { type, seq, time, data: {
    source: data?.source,
    content: Array.isArray(data?.content) ? data.content.map(block => ({ type: block?.type, ...(block?.type === 'text' ? { text: block.text } : {}) })) : []
  } };
  if (!['assistant/message', 'assistant/attempt', 'compaction/summary'].includes(type)) return null;
  let streamUsage;
  if (Array.isArray(data?.stream)) {
    for (let index = data.stream.length - 1; index >= 0; index -= 1) {
      const usage = data.stream[index]?.chunk?.usage;
      if (usage && typeof usage === 'object') { streamUsage = usage; break; }
    }
  }
  return { type, seq, time, data: {
    usage: data?.usage,
    stream: streamUsage ? [{ chunk: { usage: streamUsage } }] : [],
    message: { id: data?.message?.id, source: data?.message?.source,
      content: Array.isArray(data?.message?.content)
        ? data.message.content.filter(block => block?.type === 'tool-call').map(block => ({ type: block.type, name: block.name })) : [] }
  } };
}

async function* readDshTranscriptRecords(filePath, { headerOnly = false } = {}) {
  const fd = fs.openSync(filePath, 'r');
  const lines = lineCollector();
  try {
    const size = fs.fstatSync(fd).size;
    const compressed = filePath.endsWith('.jsonl.zstd');
    let position = 0;
    while (position < size) {
      const range = compressed ? frameRange(fd, position, size) : { end: size, complete: true };
      if (!range) return;
      const input = Readable.from((function* () {
        let offset = position;
        while (offset < range.end) {
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, range.end - offset));
          const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
          if (!count) throw Object.assign(new Error('Transcript changed while reading'), { code: 'EIO' });
          offset += count;
          yield buffer.subarray(0, count);
        }
      })(), { objectMode: false, highWaterMark: CHUNK_BYTES });
      const decoder = compressed ? zlib.createZstdDecompress({ chunkSize: CHUNK_BYTES,
        finishFlush: range.complete ? zlib.constants.ZSTD_e_end : zlib.constants.ZSTD_e_flush }) : null;
      let inputError;
      input.on('error', error => { inputError = error; decoder?.destroy(error); });
      const output = decoder ? input.pipe(decoder) : input;
      const pending = [];
      let firstRecord;
      try {
        for await (const chunk of output) {
          if (headerOnly && firstRecord) continue;
          for (const line of lines.push(chunk)) {
            const record = detailRecord(line, headerOnly);
            if (!record) continue;
            if (headerOnly) {
              if (!compressed) { yield record; return; }
              firstRecord = record;
              break;
            }
            if (compressed) pending.push(record);
            else yield record;
          }
        }
      } catch (error) {
        if (inputError || !compressed || error.code === 'SESSION_DETAIL_LINE_TOO_LARGE') throw inputError || error;
        // A corrupt complete frame invalidates its own records and everything
        // after it. Previously verified frames remain the trusted prefix.
        return;
      } finally {
        input.destroy();
        decoder?.destroy();
      }
      if (firstRecord) { yield firstRecord; return; }
      yield* pending;
      position = range.end;
    }
    const record = detailRecord(lines.finish(), headerOnly);
    if (record) yield record;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readDshTranscriptRecords };
