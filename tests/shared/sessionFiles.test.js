'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveSessionFile } = require('../../src/shared/sessionFiles');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-home-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

test('resolves a claude session file by walking projects', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.claude', 'projects', '-some-project');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'abc-123.jsonl');
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('claude', 'abc-123', home), file);
  } finally { cleanup(home); }
});

test('resolves a claude session file from the alternate transcripts root', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.claude', 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'alternate-123.jsonl');
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('claude', 'alternate-123', home), file);
  } finally { cleanup(home); }
});

test('resolves a codex rollout via the dated path', () => {
  const home = tmpHome();
  try {
    const id = 'rollout-2026-05-30T11-44-50-019e76fc-0d58';
    const dir = path.join(home, '.codex', 'sessions', '2026', '05', '30');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('codex', id, home), file);
  } finally { cleanup(home); }
});

test('resolves a codex session via the walk fallback when the id is not a dated rollout', () => {
  const home = tmpHome();
  try {
    const id = 'legacy-session-xyz';
    const dir = path.join(home, '.codex', 'sessions', 'archive');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    assert.equal(resolveSessionFile('codex', id, home), file);
  } finally { cleanup(home); }
});

test('returns empty string when not found or unknown client', () => {
  const home = tmpHome();
  try {
    assert.equal(resolveSessionFile('claude', 'missing', home), '');
    assert.equal(resolveSessionFile('hermes', 'whatever', home), '');
  } finally { cleanup(home); }
});
