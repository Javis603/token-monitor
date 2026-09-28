'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applySessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
const grok = require('../../src/shared/providers/grok/sessionMetadata');

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// grok nests sessions under a url-encoded workspace directory; the name is only
// a place to start, because `info.cwd` is the authoritative project path.
function writeSession(home, workspace, sessionId, summary) {
  const dir = path.join(home, '.grok', 'sessions', workspace, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary));
  return sessionId;
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-meta-'));
  tmpDirs.push(home);
  return home;
}

function context(home, overrides = {}) {
  return {
    deps: {},
    home,
    isoFromDate: (value) => (Number.isNaN(value.getTime()) ? '' : value.toISOString()),
    now: Date.now(),
    resolveProjects: true,
    projectIdentity,
    ...overrides
  };
}

test('names a session from summary.json, which tokscale never emits', () => {
  const home = makeHome();
  const id = writeSession(home, 'D%3A%5Cwork', 'sess-1', {
    info: { id: 'sess-1', cwd: 'D:\\work' },
    created_at: '2026-09-28T12:35:29.829384700Z',
    updated_at: '2026-09-28T12:56:30.856000000Z',
    last_active_at: '2026-09-28T12:51:40.045452400Z',
    generated_title: 'Review MiniMax card mapping'
  });
  const meta = grok.resolveSessionMetadata(new Set([id]), context(home)).get(id);
  assert.equal(meta.startedAt, '2026-09-28T12:35:29.829Z');
  assert.equal(meta.title, 'Review MiniMax card mapping');
  assert.equal(meta.projectLabel, 'work');
});

test('a session with no activity timestamps falls back to creation time, so the dock keeps it', () => {
  const home = makeHome();
  const id = writeSession(home, 'D%3A%5Cwork', 'sess-titled', {
    info: { id: 'sess-titled', cwd: 'D:\\work' },
    created_at: '2026-09-28T12:35:29.829384700Z',
    generated_title: 'Only a title'
  });
  // tokscale emits a session with every timestamp blank; before the resolver
  // this row was dropped by the dock's `Date.parse` guard and the card showed
  // no sessions at all. A title alone is not enough — the row has to carry a
  // parseable time or the dock still discards it.
  const periods = { month: { sessions: {
    [`grok:${id}`]: { client: 'grok', sessionId: id, totalTokens: 10, costUsd: 0, startedAt: '', lastUsedAt: '', title: '', projectId: '', projectLabel: '' }
  } } };
  applySessionMetadata(periods, home);
  const session = periods.month.sessions[`grok:${id}`];
  assert.equal(session.title, 'Only a title');
  assert.equal(session.startedAt, '2026-09-28T12:35:29.829Z');
  assert.ok(Number.isFinite(Date.parse(session.lastUsedAt || session.startedAt || '')));
});

test('last_used_at wins over updated_at, which background work moves forward', () => {
  const home = makeHome();
  // A session abandoned a week ago: `updated_at` was rewritten by a recap, so
  // taking the later of the two would light a green running mark on it.
  const id = writeSession(home, 'D%3A%5Cwork', 'sess-stale', {
    info: { id: 'sess-stale', cwd: 'D:\\work' },
    created_at: '2026-08-19T07:53:22.948065400Z',
    updated_at: '2026-08-27T09:00:00.000000000Z',
    last_active_at: '2026-08-19T07:54:23.084040300Z',
    generated_title: 'Old session'
  });
  const meta = grok.resolveSessionMetadata(new Set([id]), context(home)).get(id);
  assert.equal(meta.lastUsedAt, '2026-08-19T07:54:23.084Z');
});

test('updated_at is the fallback only where no activity was recorded', () => {
  const home = makeHome();
  const id = writeSession(home, 'D%3A%5Cwork', 'sess-noactivity', {
    info: { id: 'sess-noactivity', cwd: 'D:\\work' },
    created_at: '2026-08-19T07:53:22.948065400Z',
    updated_at: '2026-08-19T08:00:00.000000000Z'
  });
  const meta = grok.resolveSessionMetadata(new Set([id]), context(home)).get(id);
  assert.equal(meta.lastUsedAt, '2026-08-19T08:00:00.000Z');
});

test('a long generated title is truncated to the shared cap', () => {
  const home = makeHome();
  const id = writeSession(home, 'D%3A%5Cwork', 'sess-long', {
    info: { id: 'sess-long', cwd: 'D:\\work' },
    generated_title: 'x'.repeat(173)
  });
  const meta = grok.resolveSessionMetadata(new Set([id]), context(home)).get(id);
  assert.equal(Array.from(meta.title).length, grok.TITLE_MAX_CODE_POINTS);
  assert.ok(meta.title.endsWith('…'));
  assert.equal(Array.from('x'.repeat(173)).length, 173);
});

test('a whitespace-only or missing title leaves no name behind', () => {
  const home = makeHome();
  const blank = writeSession(home, 'D%3A%5Cwork', 'sess-blank', {
    info: { id: 'sess-blank', cwd: 'D:\\work' },
    created_at: '2026-09-28T12:35:29.829384700Z',
    generated_title: '   \n  '
  });
  // The row survives on its timestamps; it simply carries no title, so the dock
  // falls back to labelling the row by its id rather than showing blanks.
  const blankMeta = grok.resolveSessionMetadata(new Set([blank]), context(home)).get(blank);
  assert.equal(blankMeta.title, undefined);
  assert.equal(blankMeta.lastUsedAt, '2026-09-28T12:35:29.829Z');
  const bare = writeSession(home, 'D%3A%5Cwork', 'sess-bare', {
    info: { id: 'sess-bare', cwd: 'D:\\work' }, created_at: '2026-09-28T12:35:29.829384700Z'
  });
  assert.equal(grok.resolveSessionMetadata(new Set([bare]), context(home)).get(bare).title, undefined);
});

test('a scoped home ignores the host GROK_HOME', () => {
  const home = makeHome();
  const decoy = makeHome();
  const id = writeSession(home, 'D%3A%5Cwork', 'sess-distro', {
    info: { id: 'sess-distro', cwd: 'D:\\distro' }, generated_title: 'Inside the distro'
  });
  writeSession(decoy, 'D%3A%5Chost', 'sess-host', {
    info: { id: 'sess-host', cwd: 'D:\\host' }, generated_title: 'On the host'
  });
  const scoped = context(home, { deps: { scopedHome: true, env: { GROK_HOME: path.join(decoy, '.grok') } } });
  const resolved = grok.resolveSessionMetadata(new Set([id, 'sess-host']), scoped);
  // The host's store must not answer a WSL distro's session, and vice versa.
  assert.equal(resolved.get(id).title, 'Inside the distro');
  assert.equal(resolved.has('sess-host'), false);
});

test('GROK_HOME redirects the lookup when the home is not scoped', () => {
  const home = makeHome();
  const custom = makeHome();
  const id = writeSession(custom, 'D%3A%5Cwork', 'sess-custom', {
    info: { id: 'sess-custom', cwd: 'D:\\work' }, generated_title: 'From GROK_HOME'
  });
  const resolved = grok.resolveSessionMetadata(
    new Set([id]),
    context(home, { deps: { env: { GROK_HOME: path.join(custom, '.grok') } } })
  );
  assert.equal(resolved.get(id).title, 'From GROK_HOME');
});

test('an unparseable or malformed summary is skipped, not thrown', () => {
  const home = makeHome();
  const dir = path.join(home, '.grok', 'sessions', 'D%3A%5Cwork', 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), '{ not json');
  writeSession(home, 'D%3A%5Cwork', 'good', {
    info: { id: 'good', cwd: 'D:\\work' }, generated_title: 'Readable'
  });
  const resolved = grok.resolveSessionMetadata(new Set(['broken', 'good']), context(home));
  assert.equal(resolved.has('broken'), false);
  assert.equal(resolved.get('good').title, 'Readable');
});

test('a session id tokscale reports but grok has no directory for is simply absent', () => {
  const home = makeHome();
  assert.equal(grok.resolveSessionMetadata(new Set('missing-id'), context(home)).size, 0);
  // And a home with no grok root at all is not an error.
  assert.equal(grok.resolveSessionMetadata(new Set(['x']), context(path.join(home, 'nope'))).size, 0);
});

test('projects are withheld when the collector has them switched off', () => {
  const home = makeHome();
  const id = writeSession(home, 'D%3A%5Cwork', 'sess-noproject', {
    info: { id: 'sess-noproject', cwd: 'D:\\work' }, generated_title: 'No project please'
  });
  const meta = grok.resolveSessionMetadata(
    new Set([id]),
    context(home, { resolveProjects: false })
  ).get(id);
  assert.equal(meta.title, 'No project please');
  assert.equal(meta.projectId, undefined);
  assert.equal(meta.projectLabel, undefined);
});
