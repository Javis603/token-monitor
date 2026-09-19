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
// The Codex forecast row is one of the Limits rows, so the view builds it and
// the page only holds the fetch/cache machinery behind it. Guards that slice a
// builder read the view; the ones about state read the page.
const view = fs.readFileSync(path.join(root, 'src/electron/renderer/limitWindowsView.js'), 'utf8');
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
  assert.match(view, /openExternal\('https:\/\/codex-resets\.com\/'\)/);
  assert.doesNotMatch(view, /openExternal\((?:forecast|info\.dataset)/);
  assert.match(main, /parsed\.hostname === 'codex-resets\.com' && \(parsed\.pathname === '' \|\| parsed\.pathname === '\/'\)/);
});

test('single and multi-account Codex rows render one forecast entry', () => {
  // One per row, and one per group — the group's policy says so, so the Edge
  // Dock card's Codex group gets it without being handed an option. Both
  // surfaces render these two functions, so the count cannot differ between them.
  assert.match(view, /if \(id === 'codex' && !options\.accountRow\) appendCodexResetForecast\(row\);/);
  assert.match(view, /LIMIT_GROUP_POLICIES = \{[\s\S]*?codex: \(\) => \(\{ forecastOnGroup: true \}\)/);
  assert.equal((view.match(/appendCodexResetForecast\(/g) || []).length, 3, 'once per row, once per group, once as the declaration');
  assert.match(styles, /\.codex-reset-forecast \{/);
  assert.match(styles, /\.limit-row:has\(> \.codex-reset-forecast\)\s*\{[^}]*padding-bottom: 7px;/s);
  assert.doesNotMatch(styles, /\.codex-reset-forecast\s*\{[^}]*border-top:/s);
  // Unscoped, because the forecast has exactly two parents — a solo row and a
  // group — and it is appended to neither as an account row, so one selector
  // reaches every shape it is drawn in. Scoping it to the group is what made the
  // rule appear under several accounts and go missing under one; the dock card,
  // which is built on this same row, then showed only the missing half. The
  // card's half of that is asserted in edgeDock.test.js.
  assert.match(styles, /\.limit-account-row \+ \.limit-account-row::before,\s*\.codex-reset-forecast::before\s*\{[^}]*linear-gradient/s);
  assert.doesNotMatch(styles, /\.limit-row-group > \.codex-reset-forecast/);
});

test('forecast details use the shared accessible tooltip without repeating third-party copy in the row', () => {
  const renderer = view.slice(view.indexOf('function codexResetForecastTooltip'), view.indexOf('function appendCodexResetForecast'));
  assert.match(renderer, /limitDetailInfoNode\([\s\S]*?'codex-reset-forecast-info-wrap'/);
  assert.match(renderer, /limits\.codexResetForecast\.lastReset/);
  assert.match(renderer, /limits\.codexResetForecast\.resetType/);
  assert.match(renderer, /forecast\?\.status === 'scheduled' \? forecast\?\.scheduledResetType : forecast\?\.latestResetType/);
  assert.match(renderer, /limits\.codexResetForecast\.scheduledFor/);
  assert.match(renderer, /limits\.codexResetForecast\.sourceAnnouncement/);
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
  assert.equal((renderer.match(/limits\.codexResetForecast\.expected/g) || []).length, 2);
  assert.doesNotMatch(renderer, /limits\.codexResetForecast\.expectedReset/);
  assert.match(renderer, /: \(expiresAt \|\| ''\)/);
  assert.doesNotMatch(renderer, /limits\.codexResetForecast\.expires['"]/);
  assert.doesNotMatch(renderer, /forecast\.predictedAt \|\| forecast\.expiresAt/);
  // Positioning is the shared top-layer mechanism, not a per-row one: the row
  // goes through limitDetailInfoNode, which anchors a popover to its own trigger
  // and flips it when the window has no room below. A tooltip that positioned
  // itself would be the one clipped by the panel it scrolls in.
  assert.match(view, /function limitDetailInfoNode[\s\S]*?attachLimitDetailTooltip\(infoWrap, tooltip\);/);
  assert.match(view, /tooltip\.classList\.toggle\('is-below', wrap\.getBoundingClientRect\(\)\.top < tooltip\.offsetHeight \+ 8\)/);
  assert.match(styles, /\.limit-detail-tooltip\s*\{[^}]*position: fixed;/s);
  assert.match(styles, /\.limit-detail-tooltip:\s*popover-open\s*\{/);
  // What stays per-caller is which side it hangs from and how tightly it sets.
  assert.match(styles, /\.codex-reset-forecast-info-wrap \.limit-detail-tooltip\s*\{[^}]*left: calc\(anchor\(left\) - 1px\);/s);
  assert.match(styles, /max-width: min\(230px, calc\(100vw - 48px\)\)/);
  assert.match(styles, /\.codex-reset-forecast-info-wrap \.limit-detail-tooltip\s*\{[^}]*font-size: 10px;[^}]*font-weight: 400;[^}]*line-height: 1\.2;/s);
  assert.match(styles, /\.codex-reset-forecast-disclaimer\s*\{[^}]*font-size: 8px;[^}]*white-space: normal;/s);
});

test('forecast date uses a compact relative calendar label for nearby dates', () => {
  const start = view.indexOf('function codexResetForecastDate');
  const end = view.indexOf('\n  function codexResetForecastTimeUntil', start);
  const formatDate = vm.runInNewContext(`(${view.slice(start, end)})`, {
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
  const start = view.indexOf('function codexResetForecastTimeUntil');
  const end = view.indexOf('\n  function codexResetForecastAge', start);
  const timeUntil = vm.runInNewContext(`(${view.slice(start, end)})`, {
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
  const start = view.indexOf('function codexResetForecastTooltip');
  const end = view.indexOf('\n  function renderCodexResetForecast', start);
  let detailHelperCalled = false;
  const tooltip = vm.runInNewContext(`(${view.slice(start, end)})`, {
    t: (key) => key,
    codexResetForecastDate: () => '',
    codexResetForecastTimeUntil: () => '',
    codexResetForecastAge: () => '',
    codexResetForecastSourceAuthor: () => '',
    codexResetForecastType: () => '',
    limitDetailInfoNode: () => {
      detailHelperCalled = true;
      return null;
    },
    document: {},
    openExternal: () => {}
  });
  assert.equal(tooltip(null), null);
  assert.equal(detailHelperCalled, false);
  const renderer = view.slice(view.indexOf('function renderCodexResetForecast'), view.indexOf('function appendCodexResetForecast'));
  assert.match(renderer, /const forecastInfo = codexResetForecastTooltip\(forecast\);\s*if \(forecastInfo\) title\.append\(forecastInfo\);/);
});

test('renderer hides an active forecast at its expiry boundary', () => {
  const start = view.indexOf('function codexResetForecastExpired');
  const end = view.indexOf('\n  function renderLimitProviderRow', start);
  const expired = vm.runInNewContext(`(${view.slice(start, end)})`, { Date, Number });
  const forecast = { status: 'active', expiresAt: '2026-08-30T04:01:00.000Z' };

  assert.equal(expired(forecast, Date.parse('2026-08-30T04:00:59.999Z')), false);
  assert.equal(expired(forecast, Date.parse('2026-08-30T04:01:00.000Z')), true);
  assert.equal(expired({ status: 'inactive', expiresAt: forecast.expiresAt }, Date.parse('2026-08-30T04:01:00.000Z')), false);

  const renderer = view.slice(view.indexOf('function renderCodexResetForecast'), view.indexOf('function appendCodexResetForecast'));
  assert.match(renderer, /forecast\?\.status === 'active' && !expired/);
  assert.match(renderer, /forecast\?\.status === 'inactive' \|\| expired/);
  assert.match(renderer, /forecast\?\.status === 'scheduled'/);
  assert.match(renderer, /limits\.codexResetForecast\.scheduled/);
  assert.match(renderer, /limits\.codexResetForecast\.expected/);
  assert.match(renderer, /limits\.codexResetForecast\.schedulePending/);
});

test('scheduled reset labels exist in every locale', () => {
  const i18n = fs.readFileSync(path.join(root, 'src/electron/renderer/i18n.js'), 'utf8');
  for (const key of [
    'limits.codexResetForecast.scheduled',
    'limits.codexResetForecast.scheduledFor',
    'limits.codexResetForecast.schedulePending',
    'limits.codexResetForecast.expected',
    'limits.codexResetForecast.sourceAnnouncement'
  ]) {
    assert.equal(i18n.split(`'${key}':`).length - 1, 5, `${key} should exist in all five locales`);
  }
  assert.match(i18n, /'limits\.codexResetForecast\.scheduled': '已排程'/);
  assert.doesNotMatch(i18n, /'limits\.codexResetForecast\.scheduled': '重置已排程'/);
});

test('forecast source author is displayed as an X handle without duplicating @', () => {
  const start = view.indexOf('function codexResetForecastSourceAuthor');
  const end = view.indexOf('\n  function codexResetForecastPercent', start);
  const sourceAuthor = vm.runInNewContext(`(${view.slice(start, end)})`, { String });
  assert.equal(sourceAuthor('thsottiaux'), '@thsottiaux');
  assert.equal(sourceAuthor('@thsottiaux'), '@thsottiaux');
  assert.equal(sourceAuthor('  @@thsottiaux  '), '@thsottiaux');
  assert.equal(sourceAuthor(''), '');
});

test('forecast percentage display preserves fractional percent semantics', () => {
  const start = view.indexOf('function codexResetForecastPercent');
  const end = view.indexOf('\n  function codexResetForecastType', start);
  const formatPercent = vm.runInNewContext(`(${view.slice(start, end)})`, { Intl });
  assert.equal(formatPercent(0.5, 'en-US'), '0.5');
  assert.equal(formatPercent(75, 'en-US'), '75');
  assert.equal(formatPercent(75.125, 'en-US'), '75.13');
});

test('forecast reset type uses localized labels only for supported API values', () => {
  const start = view.indexOf('function codexResetForecastType');
  const end = view.indexOf('\n  function codexResetForecastTooltip', start);
  const typeLabel = vm.runInNewContext(`(${view.slice(start, end)})`, {
    String,
    t: (key) => key
  });

  assert.equal(typeLabel('banked'), 'limits.codexResetForecast.resetType.banked');
  assert.equal(typeLabel('regular'), 'limits.codexResetForecast.resetType.regular');
  assert.equal(typeLabel('surprise'), '');
});

test('forecast requests use the widget outbound transport', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  assert.match(main, /createCodexResetForecastClient\(\{\s*fetchImpl: electronLimitsFetch\(\)\s*\}\)/);
});

test('forecast refresh cadence follows the cache policy returned by the main process', () => {
  const renderer = app.slice(app.indexOf('function clearCodexResetForecastRetryTimer'), app.indexOf('\nfunction captureLimitResetMotion'));
  assert.match(renderer, /const retryAfterMs = Number\(state\.codexResetForecast\?\.retryAfterMs\);/);
  assert.match(renderer, /state\.codexResetForecast\?\.error \? 30 \* 1000 : 15 \* 60 \* 1000/);
  assert.match(renderer, /const checkedAtMs = Date\.parse\(state\.codexResetForecast\?\.checkedAt \|\| ''\);/);
  assert.match(renderer, /const remainingMs = Math\.max\(0, baseMs \+ refreshMs - nowMs\);/);
  assert.doesNotMatch(renderer, /const age =/);
  assert.match(renderer, /setTimeout\(\(\) => \{[\s\S]*?state\.breakdown === 'limits' && visibleStatsSurface\(\) === 'main'/);
});

test('first forecast response follows the active surface and schedules only on main', async () => {
  const start = app.indexOf('function clearCodexResetForecastRetryTimer');
  const end = app.indexOf('\nfunction captureLimitResetMotion', start);
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
  const start = app.indexOf('function clearCodexResetForecastRetryTimer');
  const end = app.indexOf('\nfunction captureLimitResetMotion', start);
  // The page's fetch machinery calls the view's expiry predicate, so the
  // sandbox needs both.
  const expiryBody = view.slice(view.indexOf('function codexResetForecastExpired'), view.indexOf('\n  function renderLimitProviderRow', view.indexOf('function codexResetForecastExpired')));
  const source = `${expiryBody}\n${app.slice(start, end)}`;
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
