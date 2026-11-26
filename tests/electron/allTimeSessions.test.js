'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createAllTimeSessionsLoader,
  withAllTimeSessions
} = require('../../src/electron/renderer/allTimeSessions');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(options = {}) {
  const calls = [];
  const loaded = [];
  const errors = [];
  let needed = options.needed ?? true;
  let current = { id: 1, source: 0 };
  const loader = createAllTimeSessionsLoader({
    fetchSessions: (id) => new Promise((resolve, reject) => calls.push({ id, resolve, reject })),
    currentSnapshot: () => current,
    needed: () => needed,
    onLoaded: () => loaded.push(loader.attach(stats(current))),
    onError: (error) => errors.push(error)
  });
  return {
    loader,
    calls,
    loaded,
    errors,
    setNeeded: (value) => { needed = value; },
    // A new snapshot is adopted: the renderer's stats change, then invalidate.
    adopt: (snapshot) => { current = snapshot; loader.invalidate(); }
  };
}

function stats(snapshot = { id: 1, source: 0 }) {
  return { periods: { today: { sessions: {} }, allTime: { totalTokens: 9 } }, limits: {}, snapshot };
}

test('attaching copies the pulled list onto new stats without touching them', () => {
  const input = stats();
  assert.equal(withAllTimeSessions(input, null), input, 'nothing pulled yet');
  const sessions = { 'claude:a': { totalTokens: 9 } };
  const result = withAllTimeSessions(input, sessions);
  assert.equal(result.periods.allTime.sessions, sessions);
  assert.equal(result.periods.allTime.totalTokens, 9);
  assert.equal(result.periods.today, input.periods.today);
  assert.equal(result.limits, input.limits);
  assert.equal(Object.hasOwn(input.periods.allTime, 'sessions'), false);
  const noAllTime = { periods: { today: {} } };
  assert.equal(withAllTimeSessions(noAllTime, sessions), noAllTime);
  assert.equal(withAllTimeSessions(null, sessions), null);
});

test('a pull starts only when the list is stale and something shows it', async () => {
  const { loader, calls, loaded, setNeeded, adopt } = harness({ needed: false });
  loader.ensure();
  await settle();
  assert.equal(calls.length, 0, 'not needed');

  setNeeded(true);
  loader.ensure();
  await settle();
  assert.equal(calls.length, 1);
  calls[0].resolve({ 'claude:a': { totalTokens: 9 } });
  await settle();
  assert.equal(loaded.length, 1);
  assert.equal(loader.loaded(), true);
  assert.deepEqual(loaded[0].periods.allTime.sessions, { 'claude:a': { totalTokens: 9 } });

  loader.ensure();
  await settle();
  assert.equal(calls.length, 1, 'fresh until new stats arrive');
  adopt({ id: 2, source: 0 });
  loader.ensure();
  await settle();
  assert.deepEqual(calls.map((call) => call.id), [1, 2], 'each pull names the snapshot on screen');
});

test('stats that arrive during a pull are read by one more pull, not by parallel ones', async () => {
  const { loader, calls, adopt } = harness();
  loader.ensure();
  await settle();
  adopt({ id: 2, source: 0 });
  loader.ensure();
  adopt({ id: 3, source: 0 });
  loader.ensure();
  await settle();
  assert.equal(calls.length, 1, 'one pull in flight');

  calls[0].resolve({ old: {} });
  await settle();
  assert.equal(calls.length, 2, 'the newer stats are pulled once');
  assert.equal(calls[1].id, 3);
  calls[1].resolve({ fresh: {} });
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(loader.attach(stats({ id: 3, source: 0 })).periods.allTime.sessions), ['fresh']);
});

test('a list never crosses to another source, even when it lands after the switch', async () => {
  const { loader, calls, loaded, adopt } = harness();
  loader.ensure();
  await settle();
  calls[0].resolve({ 'hub-a': {} });
  await settle();
  assert.ok(loader.attach(stats({ id: 2, source: 0 })).periods.allTime.sessions, 'same source: kept until the next pull');
  const otherHub = stats({ id: 5, source: 1 });
  assert.equal(loader.attach(otherHub), otherHub, 'another source gets nothing attached');

  adopt({ id: 2, source: 0 });
  loader.ensure();
  await settle();
  adopt({ id: 5, source: 1 });
  calls[1].resolve({ 'hub-a-late': {} });
  await settle();
  assert.equal(loaded.length, 1, 'the late list from the old source is dropped');
  assert.equal(loader.loaded(), false);
  assert.equal(calls.length, 3, 'and the new source is pulled instead');
  assert.equal(calls[2].id, 5);
  calls[2].resolve({ 'hub-b': {} });
  await settle();
  assert.deepEqual(Object.keys(loader.attach(otherHub).periods.allTime.sessions), ['hub-b']);
});

test('nothing is pulled before the renderer holds a stamped snapshot', async () => {
  const calls = [];
  const loader = createAllTimeSessionsLoader({
    fetchSessions: (id) => { calls.push(id); return {}; },
    currentSnapshot: () => undefined,
    needed: () => true,
    onLoaded: () => {}
  });
  loader.ensure();
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(loader.loaded(), false);
});

test('a hidden list is only marked stale, and pulled once it shows again', async () => {
  const { loader, calls, setNeeded } = harness();
  loader.ensure();
  await settle();
  calls[0].resolve({});
  await settle();

  setNeeded(false);
  loader.invalidate();
  loader.ensure();
  await settle();
  assert.equal(calls.length, 1);

  setNeeded(true);
  loader.ensure();
  await settle();
  assert.equal(calls.length, 2);
});

test('a failed or empty pull waits for the next stats instead of retrying', async () => {
  const { loader, calls, errors, loaded } = harness();
  loader.ensure();
  await settle();
  calls[0].reject(new Error('main busy'));
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(calls.length, 1, 'no retry loop');
  assert.equal(loader.loaded(), false);

  loader.invalidate();
  loader.ensure();
  await settle();
  calls[1].resolve(null);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(loaded.length, 0, 'main had no stats yet');
  assert.equal(loader.loaded(), false);
});

test('the renderer attaches the pulled list to every stats it adopts and pulls from render', () => {
  const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(rendererDir, '..', 'preload.js'), 'utf8');

  assert.ok(html.indexOf('<script src="allTimeSessions.js">') < html.indexOf('<script src="app.js">'));
  assert.match(preload, /getAllTimeSessions: \(snapshotId\) => ipcRenderer\.invoke\('stats:allTimeSessions', snapshotId\)/);
  assert.match(app, /fetchSessions: \(snapshotId\) => window\.tokenMonitor\.getAllTimeSessions\(snapshotId\),\s*currentSnapshot: \(\) => state\.stats\?\.snapshot,/);
  assert.equal((app.match(/allTimeSessions\.invalidate\(\);\s*state\.stats = sessionStatsForDisplay\(allTimeSessions\.attach\(/g) || []).length, 2, 'push and refresh');
  assert.doesNotMatch(app, /state\.stats = (payload\.data\.stats|nextStats);/);
  assert.match(app, /function render\([^)]*\) \{\s*renderAppContent\(/);
  assert.match(app, /function renderAppContent\([^)]*\) \{[\s\S]*?if \(!state\.stats\) return;\s*allTimeSessions\.ensure\(\);/);
  const neededBody = app.slice(app.indexOf('function allTimeSessionsNeeded()'), app.indexOf('const allTimeSessions ='));
  assert.doesNotMatch(neededBody, /isSettingsPanelOpen|isSettingsSurfaceVisible/, 'an open Settings panel does not pull the list');
  assert.doesNotMatch(app, /allTimeSessions\.ensure\(\);\s*renderSessionUsageArchiveStatus\(\);/);
});

test('a title-bearing pull that lands after titles are hidden is projected using the current policy', async () => {
  const { withoutSessionTitles } = require('../../src/electron/sessionTitleDisplay');
  let hidden = false;
  let resolvePull;
  const input = stats();
  let adopted;
  let projections = 0;
  const loader = createAllTimeSessionsLoader({
    fetchSessions: () => new Promise((resolve) => { resolvePull = resolve; }),
    currentSnapshot: () => input.snapshot,
    needed: () => true,
    projectSessions: (value) => { projections += 1; return hidden ? withoutSessionTitles(value) : value; },
    projectionKey: () => hidden,
    onLoaded: () => { adopted = loader.attach(input); }
  });
  loader.ensure();
  await settle();
  hidden = true;
  resolvePull({ 'codex:s': { title: 'Private title', totalTokens: 9 } });
  await settle();
  assert.equal(adopted.periods.allTime.sessions['codex:s'].title, undefined);
  assert.equal(adopted.periods.allTime.sessions['codex:s'].totalTokens, 9);
  assert.equal(Object.hasOwn(input.periods.allTime, 'sessions'), false);
  const projectedSessions = adopted.periods.allTime.sessions;
  for (let tick = 0; tick < 5; tick += 1) {
    assert.strictEqual(loader.attach(stats({ id: tick + 2, source: 0 })).periods.allTime.sessions, projectedSessions);
  }
  assert.equal(projections, 1, 'successive pushes reuse the projected map');
  hidden = false;
  assert.equal(loader.attach(input).periods.allTime.sessions['codex:s'].title, 'Private title');
  assert.equal(projections, 2);
});


test('re-enabling re-pulls a titleless list for the same snapshot', async () => {
  const { loader, calls, loaded } = harness();
  loader.ensure();
  await settle();
  calls[0].resolve({ 'codex:s': { totalTokens: 9 } });
  await settle();
  assert.equal(loaded[0].periods.allTime.sessions['codex:s'].title, undefined);
  loader.invalidate();
  loader.ensure();
  await settle();
  assert.equal(calls[1].id, calls[0].id);
  calls[1].resolve({ 'codex:s': { title: 'Recovered title', totalTokens: 9 } });
  await settle();
  assert.equal(loaded[1].periods.allTime.sessions['codex:s'].title, 'Recovered title');
});

// Settings shows only a count of this machine's archived sessions. Pulling the
// whole all-time list for it on every push while the panel was open cloned
// megabytes per push and stalled scrolling there, so main counts it instead.
function archivedCountHarness({ visible = true } = {}) {
  const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const source = app.slice(app.indexOf('const archivedSessionCountState ='), app.indexOf('const HUB_DRAFT_FIELDS'));
  const requests = [];
  const env = {
    state: { settings: {}, stats: { snapshot: { id: 1, source: 0 } } },
    els: { sessionUsageArchiveStatus: { textContent: '' } },
    visible,
    t: (key, values) => (values ? `${key}:${values.count}` : key),
    console: { log() {} },
    window: { tokenMonitor: { getArchivedSessionCount: () => new Promise((resolve, reject) => requests.push({ id: env.state.stats.snapshot.id, resolve, reject })) } }
  };
  const api = Function('env', `const { state, els, t, console, window } = env;
    const isSettingsSurfaceVisible = () => env.visible;
    ${source}; return { renderSessionUsageArchiveStatus, archivedSessionCountCleared };`)(env);
  return { ...api, env, requests };
}

test('Settings asks main for the archived count once per snapshot', async () => {
  const h = archivedCountHarness();
  h.renderSessionUsageArchiveStatus();
  h.renderSessionUsageArchiveStatus();
  await settle();
  assert.deepEqual(h.requests.map(r => r.id), [1], 'one request per snapshot, not per render');
  assert.equal(h.env.els.sessionUsageArchiveStatus.textContent, '');

  h.env.state.stats = { snapshot: { id: 2, source: 0 } };
  h.renderSessionUsageArchiveStatus();
  await settle();
  assert.equal(h.requests.length, 1, 'a newer snapshot waits for the request in flight');
  h.requests[0].resolve(3);
  await settle();
  assert.equal(h.env.els.sessionUsageArchiveStatus.textContent, 'settings.collection.sessionArchiveActiveCount:3');
  assert.deepEqual(h.requests.map(r => r.id), [1, 2], 'then asks again for the snapshot now shown');

  h.requests[1].reject(new Error('gone'));
  await settle();
  h.renderSessionUsageArchiveStatus();
  await settle();
  assert.equal(h.requests.length, 2, 'a failed count waits for the next stats');
  assert.equal(h.env.els.sessionUsageArchiveStatus.textContent, 'settings.collection.sessionArchiveActiveCount:3');

  h.env.state.stats = { snapshot: { id: 3, source: 0 } };
  h.renderSessionUsageArchiveStatus();
  await settle();
  h.requests[2].resolve(0);
  await settle();
  assert.equal(h.env.els.sessionUsageArchiveStatus.textContent, 'settings.collection.sessionArchiveEmpty');

  h.env.state.stats = { snapshot: { id: 4, source: 0 } };
  h.renderSessionUsageArchiveStatus();
  await settle();
  h.requests[3].resolve(null);
  await settle();
  assert.equal(h.env.els.sessionUsageArchiveStatus.textContent, '', 'no local count blanks the previous one');
});

test('a successful Clear shows zero and drops a count asked for before it', async () => {
  const h = archivedCountHarness();
  h.renderSessionUsageArchiveStatus();
  await settle();
  h.requests[0].resolve(5);
  await settle();
  h.env.state.stats = { snapshot: { id: 2, source: 0 } };
  h.renderSessionUsageArchiveStatus();
  await settle();
  h.archivedSessionCountCleared();
  assert.equal(h.env.els.sessionUsageArchiveStatus.textContent, 'settings.collection.sessionArchiveEmpty');
  h.requests[1].resolve(5);
  await settle();
  assert.equal(h.env.els.sessionUsageArchiveStatus.textContent, 'settings.collection.sessionArchiveEmpty', 'the pre-clear count is dropped');
});

test('a hidden Settings panel does not ask for the archived count', async () => {
  const h = archivedCountHarness({ visible: false });
  h.renderSessionUsageArchiveStatus();
  await settle();
  assert.equal(h.requests.length, 0);
});

test('main answers the archived count from the local record, not a composed snapshot', () => {
  const electronDir = path.join(__dirname, '..', '..', 'src', 'electron');
  const main = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(electronDir, 'preload.js'), 'utf8');
  assert.match(preload, /getArchivedSessionCount: \(\) => ipcRenderer\.invoke\('stats:archivedSessionCount'\)/);
  assert.match(main, /createLocalArchivedSessionCounter\(\(\) => lastCollectedDevice \|\| anchorSeedDevice\)/);
  assert.match(main, /ipcMain\.handle\('stats:archivedSessionCount', \(\) => \(\s*settings\?\.hubMode !== 'icloud' && !canRefreshUsageRuntime\(mode, isExternalAgentActive\)\s*\? null\s*: localArchivedSessionCount\(\)\s*\)\)/);
  assert.match(fs.readFileSync(path.join(electronDir, 'renderer', 'app.js'), 'utf8'), /clearSessionUsageArchive\(\);[\s\S]{0,300}archivedSessionCountCleared\(\);\s*await refreshStats\(\);/);
  assert.match(main, /sessionUsageArchiveStore\.clear\(\);[\s\S]{0,120}localArchivedSessionCount\.archiveCleared\(\);\s*return \{ ok: true \};/);
});

test('a later explicit ensure retries a failed snapshot without an immediate loop', async () => {
  let calls = 0;
  const current = { id: 1, source: 1 };
  const loader = createAllTimeSessionsLoader({
    currentSnapshot: () => current,
    needed: () => true,
    onLoaded() {},
    fetchSessions: async () => {
      if (++calls === 1) throw new Error('temporary failure');
      return {};
    }
  });
  loader.ensure();
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(loader.current(), false);
  loader.ensure();
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(loader.current(), true);
});
