'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const { resolveSessionMetadata } = require('../../src/shared/providers/cursor/sessionMetadata');

let sqlite;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

test('Cursor joins desktop header names by conversation id and sees later renames', { skip: !sqlite }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-titles-'));
  const dbPath = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  // Windows cannot remove the temp dir while the handle is open, so one
  // teardown closes before unlinking; separate t.after hooks would run the
  // removal first.
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)');
  const put = db.prepare('INSERT OR REPLACE INTO composerHeaders (composerId, value) VALUES (?, ?)');
  put.run('session-1', JSON.stringify({ name: '  Model   inquiry  ' }));
  put.run('session-2', '{malformed');
  put.run('session-3', JSON.stringify({ name: 'Unrelated' }));

  const cache = new Map();
  const deps = { platform: 'darwin', sqlite, cursorTitleCache: cache };
  const read = () => resolveSessionMetadata(new Set(['session-1', 'session-2', 'missing']), { home, deps });
  assert.deepEqual([...read()], [['session-1', { title: 'Model inquiry' }]]);

  const periods = { today: { sessions: {
    'cursor:session-1': { client: 'cursor', sessionId: 'session-1' },
    'cursor:missing': { client: 'cursor', sessionId: 'missing' }
  } } };
  const metadataCache = new Map();
  const sharedDeps = { ...deps, metadataCache, resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set(), retryMisses: true };
  applySessionMetadata(periods, home, sharedDeps);
  assert.equal(periods.today.sessions['cursor:session-1'].title, 'Model inquiry');
  assert.equal(periods.today.sessions['cursor:missing'].title, undefined);

  put.run('session-1', JSON.stringify({ name: 'Renamed conversation with a longer title' }));
  applySessionMetadata(periods, home, sharedDeps);
  assert.equal(periods.today.sessions['cursor:session-1'].title, 'Renamed conversation with a longer title');
});
