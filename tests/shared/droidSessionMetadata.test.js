'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { projectIdentity } = require('../../src/shared/sessionMetadata');
const droid = require('../../src/shared/providers/droid/sessionMetadata');

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeHome(index) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-meta-'));
  tmpDirs.push(home);
  if (index !== null) {
    fs.mkdirSync(path.join(home, '.factory'), { recursive: true });
    fs.writeFileSync(path.join(home, '.factory', 'sessions-index.json'), index);
  }
  return home;
}

test('resolves titles, timestamps and project identity from the session index', () => {
  const home = makeHome(JSON.stringify({
    version: 6,
    entries: [
      { sessionId: 'with-cwd', title: '  hi  ', cwd: '/Users/remix', createdAt: 1789187684564.6, mtime: 1789187723900.258 },
      { sessionId: 'bare', createdAt: 1000 }
    ]
  }));
  const result = droid.resolveSessionMetadata(new Set(['with-cwd', 'bare', 'unknown']), {
    home,
    projectIdentity,
    resolveProjects: true
  });
  assert.equal(result.size, 2);
  const named = result.get('with-cwd');
  assert.equal(named.title, 'hi');
  assert.equal(named.startedAt, new Date(1789187684564.6).toISOString());
  assert.equal(named.lastUsedAt, new Date(1789187723900.258).toISOString());
  const identity = projectIdentity('/Users/remix');
  assert.equal(named.projectId, identity.projectId);
  assert.equal(named.projectLabel, identity.projectLabel);
  const bare = result.get('bare');
  assert.equal(bare.startedAt, new Date(1000).toISOString());
  assert.equal(bare.lastUsedAt, bare.startedAt);
  assert.equal(bare.projectId, undefined);
  assert.equal(bare.title, undefined);
  assert.ok(!result.has('unknown'));
});

test('skips project identity when resolveProjects is disabled', () => {
  const home = makeHome(JSON.stringify({
    entries: [{ sessionId: 's', cwd: '/Users/remix', createdAt: 1000 }]
  }));
  const result = droid.resolveSessionMetadata(new Set(['s']), {
    home,
    projectIdentity,
    resolveProjects: false
  });
  assert.equal(result.get('s').projectId, undefined);
  assert.equal(result.get('s').startedAt, new Date(1000).toISOString());
});

test('malformed or missing indexes resolve to an empty map', () => {
  assert.deepEqual(droid.resolveSessionMetadata(new Set(['a']), {
    home: makeHome('{not json'), projectIdentity, resolveProjects: true
  }), new Map());
  assert.deepEqual(droid.resolveSessionMetadata(new Set(['a']), {
    home: makeHome(JSON.stringify({ entries: 'nope' })), projectIdentity, resolveProjects: true
  }), new Map());
  assert.deepEqual(droid.resolveSessionMetadata(new Set(['a']), {
    home: makeHome(null), projectIdentity, resolveProjects: true
  }), new Map());
});
