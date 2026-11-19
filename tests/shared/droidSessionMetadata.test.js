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

function makeHome({ current = null, legacy = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-meta-'));
  tmpDirs.push(home);
  if (current !== null) {
    fs.mkdirSync(path.join(home, '.factory', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(home, '.factory', 'cache', 'session-discovery-index.json'), current);
  }
  if (legacy !== null) {
    fs.mkdirSync(path.join(home, '.factory'), { recursive: true });
    fs.writeFileSync(path.join(home, '.factory', 'sessions-index.json'), legacy);
  }
  return home;
}

test('resolves titles, timestamps and project identity from the current discovery index', () => {
  const home = makeHome({ current: JSON.stringify({
    version: 6,
    entries: {
      'with-cwd': {
        id: 'with-cwd',
        title: '  hi  ',
        cwd: '/Users/remix',
        createdTimeMs: 1789187684564.6,
        modifiedTimeMs: 1789187723900.258,
        messageCount: 4
      },
      bare: { id: 'bare', createdTimeMs: 1000 }
    }
  }) });
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
  assert.equal(bare.lastUsedAt, new Date(1000).toISOString());
  assert.equal(bare.projectId, undefined);
  assert.equal(bare.title, undefined);
  assert.ok(!result.has('unknown'));
});

test('legacy index supplies mtime without inventing a startedAt', () => {
  const home = makeHome({ legacy: JSON.stringify({
    version: 2,
    entries: [{ sessionId: 'legacy', title: 'old', cwd: '/Users/remix', mtime: 1000 }]
  }) });
  const result = droid.resolveSessionMetadata(new Set(['legacy']), {
    home,
    projectIdentity,
    resolveProjects: true
  });
  assert.equal(result.get('legacy').startedAt, undefined);
  assert.equal(result.get('legacy').lastUsedAt, new Date(1000).toISOString());
});

test('current discovery metadata wins when the legacy index contains the same session', () => {
  const home = makeHome({
    current: JSON.stringify({
      version: 6,
      entries: {
        shared: { id: 'shared', title: 'current', createdTimeMs: 500, modifiedTimeMs: 1000 }
      }
    }),
    legacy: JSON.stringify({
      version: 2,
      entries: [{ sessionId: 'shared', title: 'legacy', cwd: '/Users/remix', mtime: 2000 }]
    })
  });
  const result = droid.resolveSessionMetadata(new Set(['shared']), {
    home,
    projectIdentity,
    resolveProjects: true
  });
  const meta = result.get('shared');
  assert.equal(meta.title, 'current');
  assert.equal(meta.startedAt, new Date(500).toISOString());
  assert.equal(meta.lastUsedAt, new Date(1000).toISOString());
  assert.equal(meta.projectId, projectIdentity('/Users/remix').projectId);
});

test('skips project identity when resolveProjects is disabled', () => {
  const home = makeHome({ current: JSON.stringify({
    entries: { s: { id: 's', cwd: '/Users/remix', title: 'named', modifiedTimeMs: 1000 } }
  }) });
  const result = droid.resolveSessionMetadata(new Set(['s']), {
    home,
    projectIdentity,
    resolveProjects: false
  });
  assert.equal(result.get('s').projectId, undefined);
  assert.equal(result.get('s').startedAt, undefined);
  assert.equal(result.get('s').lastUsedAt, new Date(1000).toISOString());
});

test('ignores finite timestamps outside the Date range', () => {
  const home = makeHome({ current: JSON.stringify({
    entries: {
      'out-of-range': { id: 'out-of-range', title: 'still usable', createdTimeMs: 1e20, modifiedTimeMs: 1e300 }
    }
  }) });
  const result = droid.resolveSessionMetadata(new Set(['out-of-range']), {
    home,
    projectIdentity,
    resolveProjects: true
  });
  assert.deepEqual(result.get('out-of-range'), { title: 'still usable' });
});

test('malformed or missing indexes resolve to an empty map', () => {
  assert.deepEqual(droid.resolveSessionMetadata(new Set(['a']), {
    home: makeHome({ current: '{not json' }), projectIdentity, resolveProjects: true
  }), new Map());
  assert.deepEqual(droid.resolveSessionMetadata(new Set(['a']), {
    home: makeHome({ current: JSON.stringify({ entries: 'nope' }) }), projectIdentity, resolveProjects: true
  }), new Map());
  assert.deepEqual(droid.resolveSessionMetadata(new Set(['a']), {
    home: makeHome(), projectIdentity, resolveProjects: true
  }), new Map());
});
