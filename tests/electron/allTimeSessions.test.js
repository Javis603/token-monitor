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
  assert.equal((app.match(/allTimeSessions\.invalidate\(\);\s*state\.stats = allTimeSessions\.attach\(/g) || []).length, 2, 'push and refresh');
  assert.doesNotMatch(app, /state\.stats = (payload\.data\.stats|nextStats);/);
  assert.match(app, /function render\(\) \{[\s\S]*?if \(!state\.stats\) return;\s*allTimeSessions\.ensure\(\);/);
  assert.match(app, /allTimeSessions\.ensure\(\);\s*renderSessionUsageArchiveStatus\(\);/, 'Settings pulls for the archived count');
});

test('a title-bearing pull that lands after privacy is enabled is projected using the current policy', async () => {
  const { withoutSessionTitleStats } = require('../../src/shared/sessionTitlePrivacy');
  let hidden = false;
  let resolvePull;
  const input = stats();
  let adopted;
  const loader = createAllTimeSessionsLoader({
    fetchSessions: () => new Promise((resolve) => { resolvePull = resolve; }),
    currentSnapshot: () => input.snapshot,
    needed: () => true,
    projectStats: (value) => hidden ? withoutSessionTitleStats(value) : value,
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
  hidden = false;
  assert.equal(loader.attach(input).periods.allTime.sessions['codex:s'].title, 'Private title');
});
