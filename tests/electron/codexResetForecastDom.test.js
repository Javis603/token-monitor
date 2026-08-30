'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/electron/preload.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/electron/renderer/styles.css'), 'utf8');

test('Codex reset forecast is opt-in at both persistence and provider UI boundaries', () => {
  assert.match(main, /codexResetForecastEnabled: false/);
  assert.match(app, /key: 'codexResetForecastEnabled',[\s\S]*?defaultValue: false/);
  assert.match(main, /settings\?\.codexResetForecastEnabled !== true/);
  assert.equal((main.match(/codexResetForecastEnabled = parseBoolean/g) || []).length, 1);
  assert.match(main, /codexResetForecastEnabled: parseBoolean\(patch\.codexResetForecastEnabled \?\? settings\.codexResetForecastEnabled, false\)/);
});

test('Codex reset forecast stays local to the renderer and uses a narrow IPC bridge', () => {
  assert.match(preload, /getCodexResetForecast: \(options\) => ipcRenderer\.invoke\('codexResetForecast:get', options\)/);
  assert.match(app, /window\.tokenMonitor\.getCodexResetForecast/);
  assert.match(app, /openExternal\?\.\('https:\/\/codex-resets\.com\/'\)/);
  assert.doesNotMatch(app, /openExternal\?\.\(forecast\./);
  assert.match(main, /parsed\.hostname === 'codex-resets\.com' && \(parsed\.pathname === '' \|\| parsed\.pathname === '\/'\)/);
});

test('single and multi-account Codex rows render one forecast entry', () => {
  assert.match(app, /if \(id === 'codex' && !options\.accountRow\) appendCodexResetForecast\(row\);/);
  const group = app.slice(app.indexOf('function renderCodexAccountGroup'), app.indexOf('function renderClaudeAccountGroup'));
  assert.equal((group.match(/appendCodexResetForecast\(row\)/g) || []).length, 1);
  assert.ok(group.indexOf('row.append(head, accountList)') < group.indexOf('appendCodexResetForecast(row)'), 'multi-account forecast follows the accounts');
  assert.match(styles, /\.codex-reset-forecast \{/);
  assert.match(styles, /\.limit-row:has\(> \.codex-reset-forecast\)\s*\{[^}]*padding-bottom: 7px;/s);
  assert.doesNotMatch(styles, /\.codex-reset-forecast\s*\{[^}]*border-top:/s);
  assert.match(styles, /\.limit-account-row \+ \.limit-account-row::before,\s*\.limit-row-group > \.codex-reset-forecast::before\s*\{[^}]*linear-gradient/s);
});

test('forecast details use the shared accessible tooltip without repeating third-party copy in the row', () => {
  const renderer = app.slice(app.indexOf('function codexResetForecastTooltip'), app.indexOf('function appendCodexResetForecast'));
  assert.match(renderer, /limitDetailInfoNode\([\s\S]*?'codex-reset-forecast-info-wrap'/);
  assert.match(renderer, /limits\.codexResetForecast\.lastReset/);
  assert.match(renderer, /limits\.codexResetForecast\.sourceSignal/);
  assert.match(renderer, /if \(forecast\?\.error\)[\s\S]*?limits\.codexResetForecast\.lastAttempt/);
  assert.doesNotMatch(renderer, /limits\.codexResetForecast\.checked/);
  assert.match(renderer, /limits\.codexResetForecast\.expiresLabel/);
  assert.match(renderer, /\[expiresAt, expiresIn\]\.filter\(Boolean\)\.join\(' · '\)/);
  assert.match(renderer, /forecast\?\.error/);
  assert.match(renderer, /limits\.codexResetForecast\.connectionFailed/);
  assert.match(renderer, /limits\.codexResetForecast\.connectionHelp/);
  assert.match(renderer, /limits\.codexResetForecast\.disclaimer/);
  assert.match(renderer, /codex-reset-forecast-disclaimer/);
  assert.doesNotMatch(renderer, /limits\.codexResetForecast\.source['"]/);
  assert.doesNotMatch(renderer, /limits\.codexResetForecast\.thirdParty/);
  assert.doesNotMatch(renderer, /sourceText/);
  assert.match(renderer, /const chance = forecast\.chancePercent;/);
  assert.doesNotMatch(renderer, /Number\(forecast\.chancePercent\)/);
  assert.match(renderer, /limits\.codexResetForecast\.expectedReset/);
  assert.match(renderer, /: \(expiresAt \|\| ''\)/);
  assert.doesNotMatch(renderer, /limits\.codexResetForecast\.expires['"]/);
  assert.doesNotMatch(renderer, /forecast\.predictedAt \|\| forecast\.expiresAt/);
  assert.match(styles, /\.codex-reset-forecast-info-wrap \.limit-detail-tooltip\s*\{[^}]*right: auto;[^}]*left: -1px;/s);
  assert.match(renderer, /positionCodexResetForecastTooltip\(info\)/);
  assert.match(renderer, /info\.addEventListener\('pointerenter', position\)/);
  assert.match(renderer, /info\.addEventListener\('focusin', position\)/);
  assert.match(styles, /\.codex-reset-forecast-info-wrap \.limit-detail-tooltip\.is-below\s*\{/);
  assert.match(styles, /max-width: min\(230px, calc\(100vw - 48px\)\)/);
  assert.match(styles, /\.codex-reset-forecast-info-wrap \.limit-detail-tooltip\s*\{[^}]*font-size: 10px;[^}]*font-weight: 400;[^}]*line-height: 1\.2;/s);
  assert.match(styles, /\.codex-reset-forecast-disclaimer\s*\{[^}]*font-size: 8px;[^}]*white-space: normal;/s);
});

test('forecast date uses a compact relative calendar label for nearby dates', () => {
  const start = app.indexOf('function codexResetForecastDate');
  const end = app.indexOf('\nfunction codexResetForecastTimeUntil', start);
  const formatDate = vm.runInNewContext(`(${app.slice(start, end)})`, {
    Date,
    Intl,
    Number,
    Object,
    currentLocale: () => 'zh-TW',
    expiryDateLabel: () => 'absolute'
  });
  assert.equal(formatDate('2026-08-31T07:00:00.000Z', {
    nowMs: Date.parse('2026-08-30T04:00:00.000Z'),
    locale: 'zh-TW',
    timeZone: 'Asia/Hong_Kong'
  }), '明天 15:00');
});

test('forecast tooltip supplements the exact expiry with an approximate countdown', () => {
  const start = app.indexOf('function codexResetForecastTimeUntil');
  const end = app.indexOf('\nfunction codexResetForecastAge', start);
  const timeUntil = vm.runInNewContext(`(${app.slice(start, end)})`, {
    Date,
    Intl,
    Math,
    Number,
    currentLocale: () => 'zh-TW',
    t: (_key, values) => `約 ${values.duration}`
  });
  assert.equal(timeUntil('2026-08-31T07:00:00.000Z', {
    nowMs: Date.parse('2026-08-30T08:00:00.000Z'),
    locale: 'zh-TW'
  }), '約 23 小時');
  assert.equal(timeUntil('2026-08-30T07:59:00.000Z', {
    nowMs: Date.parse('2026-08-30T08:00:00.000Z'),
    locale: 'zh-TW'
  }), '');
});

test('forecast tooltip safely stays absent before the first response arrives', () => {
  const start = app.indexOf('function codexResetForecastTooltip');
  const end = app.indexOf('\nfunction renderCodexResetForecast', start);
  let detailHelperCalled = false;
  const tooltip = vm.runInNewContext(`(${app.slice(start, end)})`, {
    t: (key) => key,
    codexResetForecastDate: () => '',
    codexResetForecastTimeUntil: () => '',
    codexResetForecastAge: () => '',
    codexResetForecastSourceAuthor: () => '',
    limitDetailInfoNode: () => {
      detailHelperCalled = true;
      return null;
    },
    document: {},
    positionCodexResetForecastTooltip: () => {}
  });
  assert.equal(tooltip(null), null);
  assert.equal(detailHelperCalled, false);
  const renderer = app.slice(app.indexOf('function renderCodexResetForecast'), app.indexOf('function appendCodexResetForecast'));
  assert.match(renderer, /const forecastInfo = codexResetForecastTooltip\(forecast\);\s*if \(forecastInfo\) title\.append\(forecastInfo\);/);
});

test('renderer hides an active forecast at its expiry boundary', () => {
  const start = app.indexOf('function codexResetForecastExpired');
  const end = app.indexOf('\nfunction clearCodexResetForecastRetryTimer', start);
  const expired = vm.runInNewContext(`(${app.slice(start, end)})`, { Date, Number });
  const forecast = { status: 'active', expiresAt: '2026-08-30T04:01:00.000Z' };

  assert.equal(expired(forecast, Date.parse('2026-08-30T04:00:59.999Z')), false);
  assert.equal(expired(forecast, Date.parse('2026-08-30T04:01:00.000Z')), true);
  assert.equal(expired({ status: 'inactive', expiresAt: forecast.expiresAt }, Date.parse('2026-08-30T04:01:00.000Z')), false);

  const renderer = app.slice(app.indexOf('function renderCodexResetForecast'), app.indexOf('function appendCodexResetForecast'));
  assert.match(renderer, /forecast\?\.status === 'active' && !expired/);
  assert.match(renderer, /forecast\?\.status === 'inactive' \|\| expired/);
});

test('forecast source author is displayed as an X handle without duplicating @', () => {
  const start = app.indexOf('function codexResetForecastSourceAuthor');
  const end = app.indexOf('\nfunction codexResetForecastPercent', start);
  const sourceAuthor = vm.runInNewContext(`(${app.slice(start, end)})`, { String });
  assert.equal(sourceAuthor('thsottiaux'), '@thsottiaux');
  assert.equal(sourceAuthor('@thsottiaux'), '@thsottiaux');
  assert.equal(sourceAuthor('  @@thsottiaux  '), '@thsottiaux');
  assert.equal(sourceAuthor(''), '');
});

test('forecast percentage display preserves fractional percent semantics', () => {
  const start = app.indexOf('function codexResetForecastPercent');
  const end = app.indexOf('\nfunction positionCodexResetForecastTooltip', start);
  const formatPercent = vm.runInNewContext(`(${app.slice(start, end)})`, { Intl });
  assert.equal(formatPercent(0.5, 'en-US'), '0.5');
  assert.equal(formatPercent(75, 'en-US'), '75');
  assert.equal(formatPercent(75.125, 'en-US'), '75.13');
});

test('forecast requests use the widget outbound transport', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.match(main, /createCodexResetForecastClient\(\{\s*fetchImpl: electronLimitsFetch\(\)\s*\}\)/);
});

test('forecast refresh cadence follows the cache policy returned by the main process', () => {
  const renderer = app.slice(app.indexOf('function maybeFetchCodexResetForecast'), app.indexOf('\nfunction renderLimitProviderRow'));
  assert.match(renderer, /const retryAfterMs = Number\(state\.codexResetForecast\?\.retryAfterMs\);/);
  assert.match(renderer, /state\.codexResetForecast\?\.error \? 30 \* 1000 : 15 \* 60 \* 1000/);
  assert.match(renderer, /const checkedAtMs = Date\.parse\(state\.codexResetForecast\?\.checkedAt \|\| ''\);/);
  assert.match(renderer, /const remainingMs = Math\.max\(0, baseMs \+ refreshMs - nowMs\);/);
  assert.doesNotMatch(renderer, /const age =/);
  assert.match(renderer, /setTimeout\(\(\) => \{[\s\S]*?state\.breakdown === 'limits' && visibleStatsSurface\(\) === 'main'/);
});

test('first forecast response follows the active surface and schedules only on main', async () => {
  const start = app.indexOf('function codexResetForecastExpired');
  const end = app.indexOf('\nfunction renderLimitProviderRow', start);
  const source = app.slice(start, end);

  async function settleForecast(result, surface = 'main') {
    const scheduled = [];
    let renderCount = 0;
    let schedulerRequests = 0;
    const state = {
      settings: { codexResetForecastEnabled: true },
      breakdown: 'limits',
      codexResetForecast: null,
      codexResetForecastBusy: false,
      codexResetForecastRequestedAt: 0,
      codexResetForecastRetryTimer: null
    };
    const api = vm.runInNewContext(`(() => { ${source}; return { maybeFetchCodexResetForecast }; })()`, {
      Date: class FixedDate extends Date {
        static now() { return 1_000_000; }
      },
      Number,
      clearTimeout: () => {},
      renderLimits: () => { renderCount += 1; },
      setTimeout: (_callback, delay) => {
        scheduled.push(delay);
        return scheduled.length;
      },
      state,
      statsRenderScheduler: {
        request: () => { schedulerRequests += 1; }
      },
      visibleStatsSurface: () => surface,
      window: {
        tokenMonitor: {
          getCodexResetForecast: async () => result
        }
      }
    });

    api.maybeFetchCodexResetForecast();
    await new Promise(setImmediate);
    return { renderCount, scheduled, schedulerRequests };
  }

  assert.deepEqual(await settleForecast({
    status: 'unavailable',
    error: 'offline',
    retryAfterMs: 30_000
  }), { renderCount: 1, scheduled: [30_000], schedulerRequests: 0 });
  assert.deepEqual(await settleForecast({
    status: 'active',
    chancePercent: 75,
    retryAfterMs: 15 * 60 * 1000
  }), { renderCount: 1, scheduled: [15 * 60 * 1000], schedulerRequests: 0 });

  const hidden = await settleForecast({ status: 'unavailable', error: 'offline', retryAfterMs: 30_000 }, null);
  assert.deepEqual(hidden, { renderCount: 0, scheduled: [], schedulerRequests: 1 });
  for (const surface of ['settings', 'bubble']) {
    const inactive = await settleForecast({ status: 'active', retryAfterMs: 15 * 60 * 1000 }, surface);
    assert.deepEqual(inactive, { renderCount: 0, scheduled: [], schedulerRequests: 0 });
  }
});

test('forecast deadline stays anchored to response settlement across latency and an early cache hit', async () => {
  const start = app.indexOf('function codexResetForecastExpired');
  const end = app.indexOf('\nfunction renderLimitProviderRow', start);
  const source = app.slice(start, end);
  const scheduled = [];
  let nowMs = 1_000_000;
  let calls = 0;
  let renderCount = 0;
  const cached = {
    status: 'active',
    chancePercent: 75,
    checkedAt: new Date(1_001_000).toISOString(),
    expiresAt: new Date(1_060_000).toISOString(),
    retryAfterMs: 59_000
  };
  const state = {
    settings: { codexResetForecastEnabled: true },
    breakdown: 'limits',
    codexResetForecast: null,
    codexResetForecastBusy: false,
    codexResetForecastRequestedAt: 0,
    codexResetForecastRetryTimer: null
  };
  class MutableDate extends Date {
    constructor(value) {
      super(value === undefined ? nowMs : value);
    }

    static now() {
      return nowMs;
    }
  }
  const api = vm.runInNewContext(`(() => { ${source}; return { maybeFetchCodexResetForecast, refreshCodexResetForecast }; })()`, {
    Date: MutableDate,
    Math,
    Number,
    clearTimeout: () => {},
    renderLimits: () => { renderCount += 1; },
    setTimeout: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    state,
    statsRenderScheduler: { request: () => {} },
    visibleStatsSurface: () => 'main',
    window: {
      tokenMonitor: {
        getCodexResetForecast: async () => {
          calls += 1;
          if (calls === 1) {
            nowMs += 1000;
            return cached;
          }
          if (calls === 2) return cached;
          return {
            status: 'inactive',
            checkedAt: new Date(nowMs).toISOString(),
            retryAfterMs: 15 * 60 * 1000
          };
        }
      }
    }
  });

  api.maybeFetchCodexResetForecast();
  await new Promise(setImmediate);
  assert.equal(scheduled.at(-1).delay, 59_000);

  nowMs = 1_059_000;
  await api.refreshCodexResetForecast();
  assert.equal(calls, 2);
  assert.equal(scheduled.at(-1).delay, 1000);

  nowMs = 1_060_000;
  scheduled.at(-1).callback();
  await new Promise(setImmediate);
  assert.equal(calls, 3);
  assert.equal(state.codexResetForecast.status, 'inactive');
  assert.ok(renderCount >= 4, 'expiry renders no-signal before and after the refresh settles');
});
