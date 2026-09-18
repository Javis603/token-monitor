'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  TITLE_MAX_CODE_POINTS,
  TITLE_READ_CHUNK_BYTES,
  cleanTitle,
  readSessionTitle
} = require('../../src/shared/providers/claude/sessionMetadata');

function fixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-claude-title-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { dir, file };
}

test('Claude session metadata reads the persisted AI title without exposing prompts', (t) => {

test('readSessionTurnEnded follows the newest stop_reason, and tool_use is not an end', (t) => {
  // Claude stamps every assistant record with why it stopped. `tool_use` means
  // it paused to run tools and is still mid-turn; anything else means nothing
  // further is being generated. Treating tool_use as an end would mark almost
  // every working session as finished, which is the opposite mistake.
  const { readSessionTurnEnded } = require('../../src/shared/providers/claude/sessionMetadata');
  const assistant = (stop) => JSON.stringify({ type: 'assistant', message: { id: `msg_${stop}`, stop_reason: stop } });

  const ended = fixture([assistant('tool_use'), assistant('end_turn')]);
  t.after(() => fs.rmSync(ended.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(ended.file, { cache: new Map() }), true);

  // The newest record wins: a tool_use after an end_turn is working again.
  const working = fixture([assistant('end_turn'), assistant('tool_use')]);
  t.after(() => fs.rmSync(working.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(working.file, { cache: new Map() }), false);

  // max_tokens and stop_sequence are ends too: generation stopped.
  const truncated = fixture([assistant('max_tokens')]);
  t.after(() => fs.rmSync(truncated.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(truncated.file, { cache: new Map() }), true);

  // A transcript that never recorded one reports false rather than guessing.
  const silent = fixture([JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
  t.after(() => fs.rmSync(silent.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(silent.file, { cache: new Map() }), false);
  assert.equal(readSessionTurnEnded('', { cache: new Map() }), false);

  // The title still resolves from the same shared index, so asking for both
  // costs one pass rather than two.
  const both = fixture([
    JSON.stringify({ type: 'ai-title', aiTitle: 'Shared pass' }),
    assistant('end_turn')
  ]);
  t.after(() => fs.rmSync(both.dir, { recursive: true, force: true }));
  const cache = new Map();
  assert.equal(readSessionTurnEnded(both.file, { cache }), true);
  assert.equal(readSessionTitle(both.file, { cache }), 'Shared pass');
});
  const { dir, file } = fixture([
    JSON.stringify({ type: 'user', message: { content: 'private prompt' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: '  Improve   session list  ' }),
    JSON.stringify({ type: 'assistant', message: { content: 'private answer' } })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(readSessionTitle(file), 'Improve session list');
});

test('Claude session metadata stays empty when no AI title was persisted', (t) => {
  const { dir, file } = fixture([
    JSON.stringify({ type: 'user', message: { content: 'do not use this as a title' } })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(readSessionTitle(file), '');
});

test('Claude session metadata prefers a persisted custom title', (t) => {
  const { dir, file } = fixture([
    JSON.stringify({ type: 'ai-title', aiTitle: 'Generated title' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My own title' })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(readSessionTitle(file), 'My own title');
});

test('Claude session metadata invalidates a cached miss when the transcript grows', (t) => {
  const { dir, file } = fixture([JSON.stringify({ type: 'user' })]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new Map();

  assert.equal(readSessionTitle(file, { cache }), '');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Arrived later' })}\n`);
  assert.equal(readSessionTitle(file, { cache }), 'Arrived later');
});

test('Claude session metadata finds a custom title anywhere in a long transcript', (t) => {
  const padding = `${JSON.stringify({ type: 'user', padding: 'x'.repeat(TITLE_READ_CHUNK_BYTES * 2) })}\n`;
  const { dir, file } = fixture([]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(file, `${padding}${JSON.stringify({ type: 'custom-title', customTitle: 'Middle title' })}\n${padding}`);
  assert.equal(readSessionTitle(file, { cache: new Map() }), 'Middle title');
});

test('Claude session metadata keeps a discovered custom title and reads only appended bytes', (t) => {
  const longTitle = 'x'.repeat(TITLE_MAX_CODE_POINTS + 20);
  const padding = `${JSON.stringify({ type: 'user', padding: 'x'.repeat(TITLE_READ_CHUNK_BYTES * 2) })}\n`;
  const { dir, file } = fixture([
    JSON.stringify({ type: 'custom-title', customTitle: longTitle })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new Map();
  let bytesRead = 0;
  const measuredFs = {
    ...fs,
    readSync(...args) {
      const count = fs.readSync(...args);
      bytesRead += count;
      return count;
    }
  };

  assert.equal(Array.from(cleanTitle(longTitle)).length, TITLE_MAX_CODE_POINTS);
  assert.equal(readSessionTitle(file, { cache, fs: measuredFs }), cleanTitle(longTitle));

  fs.appendFileSync(file, padding);
  const appendedBytes = Buffer.byteLength(padding);
  bytesRead = 0;
  assert.equal(readSessionTitle(file, { cache, fs: measuredFs }), cleanTitle(longTitle));
  assert.equal(bytesRead, appendedBytes);
});

test('Claude session metadata indexes title records appended before a large write', (t) => {
  const { dir, file } = fixture([JSON.stringify({ type: 'ai-title', aiTitle: 'Generated title' })]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new Map();

  assert.equal(readSessionTitle(file, { cache }), 'Generated title');
  fs.appendFileSync(file, [
    JSON.stringify({ type: 'custom-title', customTitle: 'Renamed title' }),
    JSON.stringify({ type: 'user', padding: 'x'.repeat(TITLE_READ_CHUNK_BYTES * 2) })
  ].join('\n') + '\n');

  assert.equal(readSessionTitle(file, { cache }), 'Renamed title');
});
