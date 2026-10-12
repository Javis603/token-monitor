'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const { scanZstdFrames } = require('../dsh/sessionFiles');

const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 4096;

function isCompressedCodexTranscript(file) {
  return String(file).endsWith('.jsonl.zst');
}

// Node's synchronous decoder stops after one frame. Consume every frame, with
// one total output budget and a bounded decoder window, rather than silently
// reading only the first frame or accepting a corrupt/partial transcript.
function readCompressedCodexTranscript(file, { fs: fsApi = fs } = {}) {
  let fd;
  try {
    fd = fsApi.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fsApi.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_COMPRESSED_BYTES) {
      throw new Error('Compressed Codex transcript exceeds the input budget or is empty');
    }
    const input = Buffer.alloc(stat.size);
    let read = 0;
    while (read < input.length) {
      const count = fsApi.readSync(fd, input, read, input.length - read, read);
      if (!count) throw new Error('Incomplete compressed Codex transcript read');
      read += count;
    }
    const frames = scanZstdFrames(input, MAX_FRAMES);
    if (!frames.length || frames.at(-1).end !== input.length) throw new Error('Incomplete, corrupt or excessive Zstandard frames');
    const chunks = [];
    let length = 0;
    for (const frame of frames) {
      if (length >= MAX_DECODED_BYTES) throw new Error('Codex transcript exceeds the decode budget');
      const decoded = zlib.zstdDecompressSync(input.subarray(frame.start, frame.end), {
        maxOutputLength: MAX_DECODED_BYTES - length,
        params: { [zlib.constants.ZSTD_d_windowLogMax]: 26 }
      });
      chunks.push(decoded);
      length += decoded.length;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  } finally {
    if (fd !== undefined) fsApi.closeSync(fd);
  }
}

module.exports = { MAX_COMPRESSED_BYTES, MAX_DECODED_BYTES, isCompressedCodexTranscript, readCompressedCodexTranscript };
