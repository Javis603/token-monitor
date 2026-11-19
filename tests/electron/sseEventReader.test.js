'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createSseBlockReader, parseSseBlock } = require('../../src/electron/sseEventReader');

// The loop main.js used before: the reference the reader has to agree with.
function referenceEvents(reads) {
  let buffer = '';
  const events = [];
  for (const text of reads) {
    buffer += text;
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const parsed = parseSseBlock(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      if (parsed) events.push(parsed);
    }
  }
  return events;
}

function readerEvents(reads) {
  const reader = createSseBlockReader();
  const events = [];
  for (const text of reads) {
    for (const block of reader.push(text)) {
      const parsed = parseSseBlock(block);
      if (parsed) events.push(parsed);
    }
  }
  return events;
}

const STREAM = [
  ': connected\n\n',
  'event: snapshot\ndata: {"type":"stats","stats":{"n":1}}\n\n',
  'event: freshness\ndata: {"reason":"ingest"}\n\n',
  '\n\n',
  'data: {"multi":\ndata: "line"}\n\n',
  'event: stats\ndata: {"type":"stats","stats":{"n":2,"text":"a\\n\\nb"}}\n\n',
  'event: stats\ndata: {"unfinished":'
].join('');

test('the reader yields the events the old string loop did, wherever the reads split', () => {
  const expected = referenceEvents([STREAM]);
  assert.equal(expected.length, 4);
  assert.deepEqual(readerEvents([STREAM]), expected);
  for (let cut = 0; cut <= STREAM.length; cut += 1) {
    assert.deepEqual(readerEvents([STREAM.slice(0, cut), STREAM.slice(cut)]), expected, `one cut at ${cut}`);
  }
  assert.deepEqual(readerEvents([...STREAM]), expected, 'one character per read');

  let seed = 7;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let trial = 0; trial < 200; trial += 1) {
    const reads = [];
    for (let start = 0; start < STREAM.length;) {
      const size = 1 + Math.floor(random() * 12);
      reads.push(STREAM.slice(start, start + size));
      start += size;
    }
    if (trial % 5 === 0) reads.splice(1, 0, '');
    assert.deepEqual(readerEvents(reads), expected, `trial ${trial}`);
  }
});

test('a blank line split across two reads ends the event, and an unfinished one waits', () => {
  const reader = createSseBlockReader();
  assert.deepEqual(reader.push('event: a\ndata: 1\n'), []);
  assert.deepEqual(reader.push('\nevent: b\ndata: 2'), ['event: a\ndata: 1']);
  assert.deepEqual(reader.push(''), []);
  assert.deepEqual(reader.push('\n'), []);
  assert.deepEqual(reader.push('\n'), ['event: b\ndata: 2']);
  assert.deepEqual(reader.push('\n'), [], 'a stray newline after a finished event starts nothing');
});

test('a block parses to its event name and joined data, or to nothing', () => {
  assert.deepEqual(parseSseBlock('event: stats\ndata: {"a":1}'), { event: 'stats', data: { a: 1 } });
  assert.deepEqual(parseSseBlock('data: [1,\ndata: 2]'), { event: 'message', data: [1, 2] });
  assert.equal(parseSseBlock(': keep-alive'), null);
  assert.equal(parseSseBlock('event: stats'), null);
  assert.equal(parseSseBlock('data: {broken'), null);
});

test('the Hub stream reads through the block reader', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const stream = main.match(/async function startStatsStream\(options = \{\}\) \{([\s\S]*?)\n\}\n\nfunction/);
  assert.ok(stream, 'startStatsStream exists');
  assert.match(stream[1], /const blocks = createSseBlockReader\(\);/);
  assert.match(stream[1], /for \(const block of blocks\.push\(decoder\.decode\(value, \{ stream: true \}\)\)\) \{\s*const parsed = parseSseBlock\(block\);/);
  assert.doesNotMatch(stream[1], /buffer/);
});
