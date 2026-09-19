'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const { projectIdentity } = require('../../src/shared/sessionMetadata');
const devin = require('../../src/shared/providers/devin/sessionMetadata');

const maybe = sqlite ? test : test.skip;

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDbFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-meta-'));
  tmpDirs.push(tmp);
  const dbDir = path.join(tmp, '.local', 'share', 'devin', 'cli');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'sessions.db');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    working_directory TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_mode TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    title TEXT
  )`);
  const stmt = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)');
  stmt.run('session-1', '/Users/test/project', 'cli', 'swe-2', 'agent', 1789536453, 1789562154, 'Test Audit Task');
  stmt.run('session-2', '', 'cli', 'swe-2', 'agent', 1789500000000, 1789500001000, '');
  db.close();
  return { home: tmp, dbPath };
}

maybe('resolves titles, timestamps and project identity from devin sessions.db', () => {
  const { home } = makeDbFixture();
  const result = devin.resolveSessionMetadata(new Set(['session-1', 'session-2', 'unknown-session']), {
    home,
    projectIdentity,
    resolveProjects: true
  });
  assert.equal(result.size, 2);

  const s1 = result.get('session-1');
  assert.equal(s1.title, 'Test Audit Task');
  assert.equal(s1.startedAt, new Date(1789536453 * 1000).toISOString());
  assert.equal(s1.lastUsedAt, new Date(1789562154 * 1000).toISOString());
  const identity = projectIdentity('/Users/test/project');
  assert.equal(s1.projectId, identity.projectId);
  assert.equal(s1.projectLabel, identity.projectLabel);

  const s2 = result.get('session-2');
  assert.equal(s2.title, undefined);
  assert.equal(s2.startedAt, new Date(1789500000000).toISOString());
  assert.equal(s2.lastUsedAt, new Date(1789500001000).toISOString());
});

test('handles missing or invalid database gracefully', () => {
  const result = devin.resolveSessionMetadata(new Set(['any-id']), {
    home: '/nonexistent/home',
    projectIdentity,
    resolveProjects: true
  });
  assert.equal(result.size, 0);
});

test('isoFromEpoch handles seconds and milliseconds', () => {
  assert.equal(devin.isoFromEpoch(0), '');
  assert.equal(devin.isoFromEpoch(null), '');
  assert.equal(devin.isoFromEpoch('invalid'), '');
  assert.equal(devin.isoFromEpoch(1789536453), new Date(1789536453 * 1000).toISOString());
  assert.equal(devin.isoFromEpoch(1789536453000), new Date(1789536453000).toISOString());
});
