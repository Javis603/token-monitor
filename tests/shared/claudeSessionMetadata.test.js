'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  TITLE_MAX_CODE_POINTS,
  TITLE_SCAN_BYTES,
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

test('Claude session metadata reads a title from the bounded tail window', (t) => {
  const prefix = `${JSON.stringify({ type: 'user', padding: 'x'.repeat(TITLE_SCAN_BYTES * 2) })}\n`;
  const { dir, file } = fixture([]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(file, `${prefix}${JSON.stringify({ type: 'ai-title', aiTitle: 'Tail title' })}\n`);
  assert.equal(readSessionTitle(file, { cache: new Map() }), 'Tail title');
});

test('Claude session metadata caps both title length and total bytes read', (t) => {
  const longTitle = 'x'.repeat(TITLE_MAX_CODE_POINTS + 20);
  const padding = `${JSON.stringify({ type: 'user', padding: 'x'.repeat(TITLE_SCAN_BYTES) })}\n`;
  const { dir, file } = fixture([
    JSON.stringify({ type: 'ai-title', aiTitle: longTitle })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(Array.from(cleanTitle(longTitle)).length, TITLE_MAX_CODE_POINTS);
  fs.writeFileSync(file, `${padding}${JSON.stringify({ type: 'ai-title', aiTitle: 'Outside both windows' })}\n${padding}${padding}`);
  assert.equal(readSessionTitle(file, { cache: new Map() }), '');
});
