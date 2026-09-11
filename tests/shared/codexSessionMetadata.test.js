'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const metadata = require('../../src/shared/providers/codex/sessionMetadata');
const maybe = sqlite ? test : test.skip;
const tmpDirs = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb(rows, schema = 'full') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meta-'));
  tmpDirs.push(root);
  const file = path.join(root, 'state_5.sqlite');
  const db = new sqlite.DatabaseSync(file);
  if (schema === 'minimal') {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)');
    const insert = db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)');
    for (const row of rows) insert.run(row.id, row.title || '');
  } else {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, preview TEXT, first_user_message TEXT, title TEXT, model TEXT, thread_source TEXT, source TEXT)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(
      row.id, row.name || '', row.preview || '', row.firstUserMessage || '', row.title || '',
      row.model || '', row.threadSource || '', row.source || ''
    );
  }
  db.close();
  return file;
}

maybe('reads persisted display titles and classifies guardian reviews without exposing their prompts', () => {
  const file = makeDb([
    { id: 'named', name: '繼續目前工作', preview: 'ignored preview' },
    {
      id: 'fallback',
      preview: '[@image.png](file:///private/a.png) Fix the compact session list Use the available Lody MCP tools when relevant; ignore this suffix.'
    },
    { id: 'review-model', model: 'codex-auto-review', preview: 'private review prompt' },
    { id: 'review-user', model: 'codex-auto-review', threadSource: 'user', source: '{"subagent":{"other":"guardian"}}' },
    { id: 'review-source', threadSource: 'guardian_review', title: 'private guardian title' },
    { id: 'review-json-source', threadSource: 'subagent', source: '{"subagent":{"other":"guardian"}}' }
  ]);

  const result = metadata.readSessionMeta([
    'named', 'fallback', 'review-model', 'review-user', 'review-source', 'review-json-source'
  ], {
    dbPaths: [file],
    sqlite
  });

  assert.deepEqual(result.get('named'), { title: '繼續目前工作' });
  assert.equal(result.has('fallback'), false);
  assert.equal(result.has('review-model'), false);
  assert.equal(result.has('review-user'), false);
  assert.deepEqual(result.get('review-source'), { sessionKind: 'background-review' });
  assert.deepEqual(result.get('review-json-source'), { sessionKind: 'background-review' });
});

maybe('tolerates older thread schemas and uses title as the final fallback', () => {
  const file = makeDb([{ id: 'old', title: 'Older Codex thread' }], 'minimal');
  assert.deepEqual(metadata.readSessionMeta(['old'], { dbPaths: [file], sqlite }).get('old'), {
    title: 'Older Codex thread'
  });
});

maybe('maps Tokscale rollout ids and merged rollout ids back to Codex thread UUIDs', () => {
  const first = '01a08a9f-4c18-7b81-9f7d-072365428426';
  const second = '01a08aa3-1ce6-7312-bfe8-94a766d11890';
  const file = makeDb([
    { id: first, name: 'First thread' },
    { id: second, name: 'Second thread' }
  ]);
  const prefixed = `rollout-2026-09-10T20-09-00-${first}`;
  const merged = `${prefixed}_rollout-2026-09-10T18-21-00-${second}`;

  const result = metadata.readSessionMeta([prefixed, merged], { dbPaths: [file], sqlite });

  assert.deepEqual(result.get(prefixed), { title: 'First thread' });
  assert.deepEqual(result.get(merged), { title: 'First thread' });
  assert.deepEqual(metadata.threadIdCandidates(merged), [merged, first, second]);
});

test('discovers the newest state database first and honors CODEX_HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  tmpDirs.push(root);
  fs.writeFileSync(path.join(root, 'state_2.sqlite'), '');
  fs.writeFileSync(path.join(root, 'state_5.sqlite'), '');
  fs.mkdirSync(path.join(root, 'sqlite'));
  fs.writeFileSync(path.join(root, 'sqlite', 'state_4.sqlite'), '');

  assert.deepEqual(metadata.discoverDbPaths({ env: { CODEX_HOME: root } }), [
    path.join(root, 'state_5.sqlite'),
    path.join(root, 'state_2.sqlite'),
    path.join(root, 'sqlite', 'state_4.sqlite')
  ]);
});

test('title cleaning is Unicode-safe and bounded', () => {
  const cleaned = metadata.cleanSessionTitle('🧪'.repeat(metadata.TITLE_MAX_CODE_POINTS + 20));
  assert.equal(Array.from(cleaned).length, metadata.TITLE_MAX_CODE_POINTS);
  assert.match(cleaned, /…$/);
});
