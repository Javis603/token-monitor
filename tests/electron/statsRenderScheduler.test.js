'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createStatsRenderScheduler
} = require('../../src/electron/renderer/statsRenderScheduler');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

test('hidden stats updates coalesce into one render when visibility returns', () => {
  let hidden = true;
  let renders = 0;
  const scheduler = createStatsRenderScheduler({
    isHidden: () => hidden,
    render: () => { renders += 1; }
  });

  scheduler.request();
  scheduler.request();
  assert.equal(renders, 0);

  scheduler.flush();
  assert.equal(renders, 0);
  hidden = false;
  scheduler.flush();
  scheduler.flush();
  assert.equal(renders, 1);
});

test('visible stats updates continue rendering every push', () => {
  let renders = 0;
  const scheduler = createStatsRenderScheduler({
    isHidden: () => false,
    render: () => { renders += 1; }
  });

  scheduler.request();
  scheduler.request();
  assert.equal(renders, 2);
});

test('hidden payloads keep the latest state and tray updates before visible rendering resumes', () => {
  let hidden = true;
  let latestStats = null;
  const renderedStats = [];
  const trayStats = [];
  const scheduler = createStatsRenderScheduler({
    isHidden: () => hidden,
    render: () => renderedStats.push(latestStats)
  });
  const pushStats = (stats) => {
    latestStats = stats;
    scheduler.request();
    trayStats.push(stats);
  };

  pushStats({ revision: 1 });
  pushStats({ revision: 2 });
  assert.deepEqual(latestStats, { revision: 2 });
  assert.deepEqual(renderedStats, []);
  assert.deepEqual(trayStats, [{ revision: 1 }, { revision: 2 }]);

  hidden = false;
  scheduler.flush();
  assert.deepEqual(renderedStats, [{ revision: 2 }]);

  pushStats({ revision: 3 });
  assert.deepEqual(renderedStats, [{ revision: 2 }, { revision: 3 }]);
  assert.deepEqual(trayStats, [{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
});

test('renderer wires visibility scheduling without deferring tray icon updates', () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const statsPush = app.match(/window\.tokenMonitor\.onStatsPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  const schedulerIndex = html.indexOf('<script src="statsRenderScheduler.js"></script>');
  const appIndex = html.indexOf('<script src="app.js"></script>');
  const visibilityListenerStart = app.indexOf("document.addEventListener('visibilitychange'");
  const visibilityListenerEnd = app.indexOf('window.tokenMonitor.onStatsPush', visibilityListenerStart);
  const visibilityListener = visibilityListenerStart >= 0 && visibilityListenerEnd > visibilityListenerStart
    ? app.slice(visibilityListenerStart, visibilityListenerEnd)
    : '';

  assert.notEqual(schedulerIndex, -1);
  assert.notEqual(appIndex, -1);
  assert.ok(schedulerIndex < appIndex);
  assert.notEqual(visibilityListenerStart, -1);
  assert.notEqual(visibilityListenerEnd, -1);
  assert.match(visibilityListener, /cancelTokenRateBoost\(\)/);
  assert.match(visibilityListener, /!document\.hidden[\s\S]*hubBuildStatusRefreshDue\(\)[\s\S]*refreshHubBuildStatus\(\)/);
  assert.match(visibilityListener, /statsRenderScheduler\.flush\(\)/);
  assert.match(
    statsPush,
    /state\.stats = overlayAllTimeSessions\(payload\.data\.stats\);[\s\S]*statsRenderScheduler\.request\(\);[\s\S]*maybeUpdateBarsIcon\(\);/
  );
});

test('all stats refreshes use visibility-aware rendering', () => {
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const refreshStats = app.slice(
    app.indexOf('async function refreshStats(options = {})'),
    app.indexOf('async function refreshStatusViewManually()')
  );
  const statsRender = app.slice(
    app.indexOf('function renderStatsUpdate()'),
    app.indexOf('const statsRenderScheduler =')
  );

  assert.match(refreshStats, /getStats\(options\)[\s\S]*statsRenderScheduler\.request\(\);/);
  assert.doesNotMatch(statsRender, /renderMimoStatus\(\);/);
});
