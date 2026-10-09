'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const preferences = require('../../src/electron/renderer/homeModulePreferences');
const { limitFillPercent } = require('../../src/electron/renderer/limits/displayMode');
const { createLimitWindowsView } = require('../../src/electron/renderer/limits/windowsView');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function resolveHomeRows(providers, settings = {}) {
  const presentation = require('../../src/electron/renderer/limits/providerPresentation');
  const windowLabels = require('../../src/shared/limits/windowLabels');
  const view = createLimitWindowsView({
    presentation,
    ...windowLabels,
    accountIdentity: require('../../src/electron/renderer/accountIdentity'),
    settings: () => settings,
    t: (key) => key
  });
  const ids = [...new Set(providers.map((provider) => provider.provider))];
  const app = read('src/electron/renderer/app.js');
  const start = app.indexOf('function homeLimitRows()');
  const end = app.indexOf('function homeLimitWindowLabel(', start);
  return vm.runInNewContext(`${app.slice(start, end)}; homeLimitRows();`, {
    state: { stats: { limits: { providers } }, settings: { homeLimitAccountCount: 20, ...settings } },
    enabledLimitProviderSet: () => new Set(ids),
    hiddenHomeLimitProviderSet: () => new Set(),
    LIMIT_PROVIDERS: ids.map((id) => ({ id, label: id })),
    limitProviderOrderApi: require('../../src/electron/renderer/limits/providerOrder'),
    limitUsageItemsApi: require('../../src/shared/limits/usageItems'),
    homeOverviewApi: require('../../src/electron/renderer/homeOverview'),
    limitProviderPresentationApi: presentation,
    limitWindowsView: view,
    limitAccountTitle: view.limitAccountTitle,
    ...windowLabels,
    clientColors: {}
  });
}

test('Home resolves real plan labels without treating MiMo products as plans', () => {
  const rows = resolveHomeRows([
    { provider: 'mimo', status: 'ok', accountLabel: 'Desktop Membership', planLabel: '', windows: [{ kind: 'weekly', remainingPercent: 40 }] },
    { provider: 'mimo', status: 'ok', accountLabel: 'Console', planLabel: 'Pay-as-you-go', windows: [{ kind: 'weekly', remainingPercent: 50 }] }
  ]);
  assert.equal(rows.find((row) => row.name === 'Desktop Membership').plan, '');
  assert.equal(rows.find((row) => row.name === 'Console').plan, 'Pay-as-you-go');
  assert.equal(resolveHomeRows([
    { provider: 'mimo', status: 'ok', accountLabel: 'Desktop Membership', planLabel: 'Pro', windows: [{ kind: 'weekly', remainingPercent: 40 }] }
  ])[0].plan, 'Pro');
});

test('Home uses account-row plan policies for grouped titles and adapter identities', () => {
  const window = { kind: 'weekly', remainingPercent: 40 };
  const rows = resolveHomeRows([
    ...['Coding Plan', 'Agent Plan Pro'].map((accountLabel) => ({ provider: 'volcengine', status: 'ok', accountLabel, windows: [window] })),
    ...['Work profile', 'Personal profile'].map((accountLabel) => ({ provider: 'opencode', status: 'ok', accountLabel, windows: [window] })),
    ...['newapi-account', 'sub2api'].map((adapterId) => ({ provider: 'thirdparty', status: 'ok', adapterId, planLabel: 'Account', windows: [window] }))
  ]);
  for (const name of ['Coding Plan', 'Agent Plan Pro', 'Work profile', 'Personal profile']) {
    assert.equal(rows.find((row) => row.name === name).plan, '');
  }
  const adapters = rows.filter((row) => row.providerId === 'thirdparty');
  assert.equal(adapters[0].plan, 'New API · Account');
  assert.equal(adapters[1].plan, 'Sub2API · Account');
  for (const [provider, accountLabel] of [['volcengine', 'Coding Plan'], ['opencode', 'Work profile']]) {
    const solo = resolveHomeRows([{ provider, status: 'ok', accountLabel, windows: [window] }])[0];
    assert.equal(solo.name, provider);
    assert.equal(solo.plan, accountLabel, 'a solo provider title still needs its plan/profile label');
  }
});

test('Home shares Limits status and stale-plan semantics for retained quota windows', () => {
  const window = { kind: 'weekly', remainingPercent: 40 };
  for (const [status, stale, expected] of [
    ['unauthorized', false, 'Sign in again'],
    ['unavailable', false, 'Unavailable'],
    ['unavailable', true, 'Plus'],
    ['ok', false, 'Plus']
  ]) {
    assert.equal(resolveHomeRows([
      { provider: 'codex', status, stale, accountLabel: 'Plus', windows: [window] }
    ])[0].plan, expected);
  }
  assert.equal(resolveHomeRows([
    { provider: 'zed', status: 'ok', planLabel: 'Zed Student', windows: [window] }
  ])[0].plan, 'Student');
});

test('Home grouped legacy OpenCode profiles retain explicit plan labels', () => {
  for (const planLabel of ['Zen', 'Go', ' Zen ']) {
    const rows = resolveHomeRows([
      { provider: 'opencode', status: 'ok', accountLabel: 'Work profile', planLabel, windows: [{ kind: 'weekly', remainingPercent: 40 }] },
      { provider: 'opencode', status: 'ok', accountLabel: 'Personal profile', windows: [{ kind: 'weekly', remainingPercent: 60 }] }
    ]);
    assert.equal(rows[0].name, 'Work profile');
    assert.equal(rows[0].plan, planLabel.trim());
    assert.equal(rows[1].plan, '');
    for (const homeLimitDisplayMode of ['text', 'bars']) {
      const metric = renderHomeWindow(rows[0].windows[0], { homeLimitDisplayMode }, rows[0].plan);
      assert.equal(metric.accountHead.children[2].textContent, planLabel.trim());
    }
  }
});

test('Home legacy OpenCode groups retain recovery status for non-stale errors', () => {
  const emptyError = resolveHomeRows([
    { provider: 'opencode', status: 'unauthorized', accountLabel: 'Legacy failed', windows: [] },
    { provider: 'opencode', status: 'ok', accountLabel: 'Personal profile', windows: [{ kind: 'weekly', remainingPercent: 60 }] }
  ]);
  assert.equal(emptyError.length, 1, 'normal failed probes without quotas stay absent from Home');
  assert.equal(emptyError[0].name, 'Personal profile');
  for (const [status, recovery] of [['unauthorized', 'Sign in again'], ['unavailable', 'Unavailable']]) {
    for (const stale of [true, false]) {
      for (const planLabel of ['', 'Zen']) {
        const windows = [{ kind: 'weekly', remainingPercent: 40 }];
        const rows = resolveHomeRows([
          { provider: 'opencode', status, stale, accountName: '', accountLabel: 'Legacy failed', planLabel, windows },
          { provider: 'opencode', status: 'ok', accountLabel: 'Personal profile', windows }
        ]);
        const plan = stale ? planLabel : recovery;
        assert.equal(rows[0].plan, plan);
        for (const homeLimitDisplayMode of ['text', 'bars']) {
          const head = renderHomeWindow(windows[0], { homeLimitDisplayMode }, rows[0].plan).accountHead;
          if (plan) assert.equal(head.children[2].textContent, plan);
          else assert.equal(head.children.length, 2);
        }
      }
    }
  }
});

test('Home Cursor plans never expose email identities with masking enabled or disabled', () => {
  const window = { kind: 'monthly', remainingPercent: 40 };
  for (const homeLimitDisplayMode of ['text', 'bars']) {
    for (const maskLimitAccountEmails of [true, false]) {
      const settings = { homeLimitDisplayMode, maskLimitAccountEmails };
      const rows = resolveHomeRows(['alice@example.com', 'bob@example.com'].map((email) => ({
        provider: 'cursor', status: 'ok', accountEmail: email, accountLabel: email, planLabel: '', windows: [window]
      })), settings);
      assert.equal(rows[0].plan, '');
      assert.equal(rows[1].plan, '');
      assert.equal(rows[0].name, maskLimitAccountEmails ? 'a***e@example.com' : 'alice@example.com');
      const metric = renderHomeWindow(window, settings, rows[0].plan);
      assert.equal(metric.accountHead.children.length, 2, 'no email-bearing plan node or hover title');
    }
  }
  for (const [accountLabel, planLabel, expected] of [
    ['alice@example.com', 'Pro', 'Pro'],
    ['Pro', '', 'Pro'],
    ['legacy@example.com', '', '']
  ]) {
    assert.equal(resolveHomeRows([
      { provider: 'cursor', status: 'ok', accountLabel, planLabel, windows: [window] }
    ], { maskLimitAccountEmails: true })[0].plan, expected);
  }
});

test('Home OpenRouter credits-only success does not repeat grouped profile names as plans', async () => {
  const { fetchOpenRouterLimits } = require('../../src/shared/providers/openrouter/limits');
  const providers = await fetchOpenRouterLimits({
    openrouterProfiles: { Work: { apiKey: 'test-work' }, Personal: { apiKey: 'test-personal' } }
  }, {
    env: {},
    fetch: async (url) => url.endsWith('/key')
      ? { ok: false, status: 503 }
      : { ok: true, json: async () => ({ data: { total_credits: 100, total_usage: 20 } }) }
  });
  for (const provider of providers) {
    assert.equal(provider.status, 'ok');
    assert.equal(provider.planLabel, '');
    assert.equal(provider.windows[0].metric, 'credits');
  }
  const rows = resolveHomeRows(providers);
  assert.deepEqual(rows.map((row) => [row.name, row.plan]), [['Work', ''], ['Personal', '']]);
  for (const homeLimitDisplayMode of ['text', 'bars']) {
    const head = renderHomeWindow(rows[0].windows[0], { homeLimitDisplayMode }, rows[0].plan).accountHead;
    assert.equal(head.children.length, 2);
  }
  const solo = resolveHomeRows([providers[0]])[0];
  assert.equal(solo.name, 'openrouter');
  assert.equal(solo.plan, 'Work');
});

function renderHomeWindows(windows, settings = {}, plan = '', providerId = '', locale = 'en') {
  class Element {
    constructor() {
      this.children = [];
      this.style = { setProperty(name, value) { this[name] = value; } };
      this.attributes = {};
      this.classList = {
        values: new Set(),
        add(name) { this.values.add(name); },
        contains(name) { return this.values.has(name); }
      };
    }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const document = { createElement: () => new Element() };
  const module = new Element();
  const body = new Element();
  const app = read('src/electron/renderer/app.js');
  const start = app.indexOf('function homeLimitWindowLabel(');
  const end = app.indexOf('function renderHomeModelModule(', start);
  const context = {
    document,
    state: { settings },
    homeModulePreferencesApi: preferences,
    homeModuleShell: () => ({ module, body }),
    homeLimitRows: () => [{ name: providerId || 'Claude', providerId, plan, color: '#d97757', windows }],
    applyHomeListMark() {},
    iconKindFor: () => 'claude',
    formatHomeLimitWindowValue: () => 'value',
    isCreditsWindow: (window) => window.metric === 'credits',
    limitFillPercent,
    optionalFiniteNumber: (value) => value == null || !Number.isFinite(Number(value)) ? null : Number(value),
    limitWindowsView: createLimitWindowsView({
      document,
      colorWithAlpha: (color, alpha) => `${color}/${alpha}`,
      applyBarScale: (fill, scale) => fill.style.setProperty('--bar-scale', String(scale))
    }),
    t: (key, params) => require('../../src/electron/renderer/i18n').translate(locale, key, params),
    formatLimitBoundary: () => 'Reset 4h',
    limitProviderPresentationApi: require('../../src/electron/renderer/limits/providerPresentation')
  };
  vm.runInNewContext(`${app.slice(start, end)}; renderHomeLimitModule();`, context);
  return body.children[0].children[1].children.map((metric) => {
    metric.accountHead = body.children[0].children[0];
    return metric;
  });
}

function renderHomeWindow(window, settings = {}, plan = '') {
  return renderHomeWindows([window], settings, plan)[0];
}

test('Home Antigravity uses both periods after a model group is removed or hidden', () => {
  const { limitUsageItemId } = require('../../src/shared/limits/usageItems');
  const windows = [
    { kind: 'session', label: 'Gemini 5-hour', usedPercent: 25, resetDescription: '4h' },
    { kind: 'weekly', label: 'Gemini weekly', usedPercent: 90, resetDescription: '6d' },
    { kind: 'session', label: 'Claude/GPT 5-hour', usedPercent: 40 },
    { kind: 'weekly', label: 'Claude/GPT weekly', usedPercent: 30 }
  ];
  const hiddenGroup = windows.slice(2).map((window) => limitUsageItemId(window, 'antigravity'));
  for (const homeLimitDisplayMode of ['text', 'bars']) {
    for (const locale of Object.keys(require('../../src/electron/renderer/i18n').MESSAGES)) {
      for (const hidden of [false, true]) {
        const settings = { homeLimitDisplayMode, limitProviderHiddenItems: hidden ? { antigravity: hiddenGroup } : {} };
        const rows = resolveHomeRows([{ provider: 'antigravity', status: 'ok', windows: hidden ? windows : windows.slice(0, 2) }], settings);
        assert.deepEqual(rows[0].windows.map((window) => window.label), ['Gemini 5-hour', 'Gemini weekly']);
        const metrics = renderHomeWindows(rows[0].windows, settings, '', 'antigravity', locale);
        assert.deepEqual(metrics.map((metric) => metric.children[0].children[0].textContent), ['Gemini 5-hour', 'Gemini Weekly']);
        const { translate } = require('../../src/electron/renderer/i18n');
        assert.deepEqual(metrics.map((metric) => metric.children.at(-1).textContent), [
          translate(locale, 'home.reset', { value: '4h' }),
          translate(locale, 'home.reset', { value: '6d' })
        ], 'reset text stays translated without repeating the period');
      }
    }
  }
  const dualRows = resolveHomeRows([{ provider: 'antigravity', status: 'ok', windows }]);
  assert.deepEqual(dualRows[0].windows.map((window) => window.label), ['Gemini weekly', 'Claude/GPT 5-hour']);
  const dualMetrics = renderHomeWindows(dualRows[0].windows, {}, '', 'antigravity');
  assert.equal(dualMetrics[0].children[0].children[0].textContent, 'Gemini');
  assert.equal(dualMetrics[0].children.at(-1).textContent, 'Weekly · Reset 6d');
});

test('Home Antigravity preserves lone-window labels and omits missing or hidden usage', () => {
  const { limitUsageItemId } = require('../../src/shared/limits/usageItems');
  const session = { kind: 'session', label: 'Gemini 5-hour', remainingPercent: 75 };
  const weekly = { kind: 'weekly', label: 'Gemini weekly', remainingPercent: 50 };
  for (const window of [session, weekly]) {
    const other = window === session ? weekly : session;
    const missing = { ...other, remainingPercent: null, usedPercent: null };
    for (const homeLimitDisplayMode of ['text', 'bars']) {
      for (const [windows, settings] of [
        [[window], {}],
        [[missing, window], {}],
        [[other, window], { limitProviderHiddenItems: { antigravity: [limitUsageItemId(other, 'antigravity')] } }]
      ]) {
        const rows = resolveHomeRows([{ provider: 'antigravity', status: 'ok', windows }], settings);
        assert.equal(rows[0].windows.length, 1);
        const metrics = renderHomeWindows(rows[0].windows, { ...settings, homeLimitDisplayMode }, '', 'antigravity');
        assert.equal(metrics[0].children[0].children[0].textContent, window === session ? 'Gemini 5-hour' : 'Gemini Weekly');
        assert.equal(metrics[0].children.length, homeLimitDisplayMode === 'bars' ? 2 : 1, 'period does not depend on reset data');
      }
    }
  }
  for (const windows of [undefined, [], [{ kind: 'session', label: 'Gemini 5-hour' }]]) {
    assert.deepEqual(resolveHomeRows([{ provider: 'antigravity', status: 'unavailable', windows }]), []);
  }
  const settings = { limitProviderHiddenItems: { antigravity: [session, weekly].map((window) => limitUsageItemId(window, 'antigravity')) } };
  assert.deepEqual(resolveHomeRows([{ provider: 'antigravity', status: 'ok', windows: [session, weekly] }], settings), []);
});

test('Home shows the plan on the account heading in both modes and omits unknown plans', () => {
  for (const homeLimitDisplayMode of ['text', 'bars']) {
    const known = renderHomeWindow({ remainingPercent: 88 }, { homeLimitDisplayMode }, 'Pro More');
    assert.equal(known.accountHead.children[2].className, 'home-limit-plan');
    assert.equal(known.accountHead.children[2].textContent, 'Pro More');
    assert.equal(known.accountHead.children[2].title, 'Pro More');
    const unknown = renderHomeWindow({ remainingPercent: 88 }, { homeLimitDisplayMode });
    assert.equal(unknown.accountHead.children.length, 2);
  }
});

test('Home low-limit highlighting is independent of display mode and remains opt-in', () => {
  for (const homeLimitDisplayMode of ['text', 'bars']) {
    for (const [remainingPercent, expected] of [[50, ''], [49, 'home-limit-value-low'], [20, 'home-limit-value-low'], [19, 'home-limit-value-critical'], [0, 'home-limit-value-critical']]) {
      for (const showHomeLimitBars of [true, false]) {
        const metric = renderHomeWindow({ remainingPercent }, { homeLimitDisplayMode, showHomeLimitBars });
        const value = metric.children[0].children[1];
        for (const className of ['home-limit-value-low', 'home-limit-value-critical']) {
          assert.equal(value.classList.contains(className), showHomeLimitBars && expected === className);
        }
      }
    }
  }
});

test('Home text and bar modes preserve text and reset information', () => {
  const window = { remainingPercent: 88, showMeter: true, resetsAt: '2026-10-06T12:00:00Z' };
  for (const mode of [undefined, 'text', 'invalid']) {
    const metric = renderHomeWindow(window, { homeLimitDisplayMode: mode });
    assert.deepEqual(metric.children.map((child) => child.className), ['home-limit-window-line', 'home-limit-reset']);
  }
  const metric = renderHomeWindow(window, { homeLimitDisplayMode: 'bars' });
  assert.deepEqual(metric.children.map((child) => child.className), ['home-limit-window-line', 'limit-meter', 'home-limit-reset']);
  assert.equal(metric.children[1].children[0].style['--bar-scale'], '0.88');
  assert.equal(metric.children[1].children[0].style.background, '#d97757');
  assert.equal(metric.children[1].attributes['aria-hidden'], 'true');
  assert.equal(metric.children[2].textContent, 'Reset 4h');
});

test('Home meters flip percentage usage but retain remaining money and fixed values', () => {
  for (const [window, expected] of [
    [{ remainingPercent: 88 }, '0.12'],
    [{ remainingPercent: 40, metric: 'credits', remaining: 4 }, '0.4'],
    [{ remainingPercent: 40, value: '$4' }, '0.4'],
    [{ remainingPercent: 0 }, '1'],
    [{ remainingPercent: 100 }, '0']
  ]) {
    const metric = renderHomeWindow(window, { homeLimitDisplayMode: 'bars', showLimitUsed: true });
    assert.equal(metric.children[1].children[0].style['--bar-scale'], expected);
  }
});

test('Home bars do not invent percentages for unknown, unlimited or non-meter windows', () => {
  for (const window of [
    { remainingPercent: null }, { remainingPercent: NaN },
    { remainingPercent: null, metric: 'credits', remaining: 4 },
    { remainingPercent: null, detail: 'unlimited' },
    { remainingPercent: null, planStatus: 'expired', showMeter: false },
    { remainingPercent: 80, showMeter: false }
  ]) {
    assert.equal(renderHomeWindow(window, { homeLimitDisplayMode: 'bars' }).children.length, 1);
  }
  const empty = renderHomeWindow({ remainingPercent: 0 }, { homeLimitDisplayMode: 'bars' });
  assert.equal(empty.children[1].children[0].style['--bar-scale'], '0');
});

test('Home display mode persists separately from low-limit highlighting and is translated', () => {
  const main = read('src/electron/main.js');
  const app = read('src/electron/renderer/app.js');
  assert.match(main, /homeLimitDisplayMode: 'text'/);
  assert.match(main, /merged\.homeLimitDisplayMode = normalizeHomeLimitDisplayMode\(merged\.homeLimitDisplayMode\)/);
  assert.match(main, /homeLimitDisplayMode: normalizeHomeLimitDisplayMode\(patch\.homeLimitDisplayMode \?\? settings\.homeLimitDisplayMode\)/);
  assert.match(app, /saveSettings\(\{ homeLimitDisplayMode: displayInput\.value \}\)/);
  assert.equal(preferences.normalizeHomeLimitDisplayMode('bars'), 'bars');
  assert.equal(preferences.normalizeHomeLimitDisplayMode('invalid'), 'text');
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  for (const messages of Object.values(MESSAGES)) {
    for (const suffix of ['', '.text', '.bars']) assert.ok(messages[`settings.home.limitDisplayMode${suffix}`]);
  }
});

test('Home low-limit indicators are opt-in and persist through the settings boundary', () => {
  const main = read('src/electron/main.js');
  const app = read('src/electron/renderer/app.js');

  assert.match(main, /showHomeLimitBars:\s*false/);
  assert.match(main, /merged\.showHomeLimitBars = parseBoolean\(merged\.showHomeLimitBars, false\)/);
  assert.match(main, /showHomeLimitBars:\s*parseBoolean\(patch\.showHomeLimitBars \?\? settings\.showHomeLimitBars, false\)/);
  assert.match(app, /statusInput\.checked = state\.settings\?\.showHomeLimitBars === true/);
  assert.match(app, /saveSettings\(\{ showHomeLimitBars: statusInput\.checked \}\)/);
});

test('Home highlights only low and critical remaining limits', () => {
  const app = read('src/electron/renderer/app.js');
  const css = read('src/electron/renderer/styles.css');

  // The meter is built by the shared Limits view, which the edge dock uses too.
  const view = read('src/electron/renderer/limits/windowsView.js');
  assert.match(view, /function limitMeterNode\(color, percent, tone = 1\)/);
  assert.match(view, /const meter = limitMeterNode\(color, fillPercent, tone\)/);
  assert.match(app, /state\.settings\?\.showHomeLimitBars === true && window\.remainingPercent != null/);
  assert.match(app, /remainingPercent < 20/);
  assert.match(app, /value\.classList\.add\('home-limit-value-critical'\)/);
  assert.match(app, /remainingPercent < 50/);
  assert.match(app, /value\.classList\.add\('home-limit-value-low'\)/);
  assert.match(app, /line\.append\(label, value\)/);
  assert.doesNotMatch(app, /'home-limit-meter'/);
  assert.match(css, /\.home-limit-value-low\s*\{[^}]*--home-limit-accent/s);
  assert.match(css, /\.home-limit-value-critical\s*\{[^}]*color:\s*var\(--red\)/s);
  assert.doesNotMatch(css, /\.home-limit-value-critical\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.home-limit-value-critical::before\s*\{[^}]*width:\s*4px;[^}]*height:\s*4px;/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.limit-meter-fill,[\s\S]*?\.tab-indicator\s*\{[^}]*transition:\s*none;/);
});

test('Home low-limit indicator setting is translated in every locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    assert.ok(messages['settings.home.showLimitBars'], `${locale} should translate the Home limit bar setting`);
  }
});

test('Home multi-account provider names are opt-in and persist through the settings boundary', () => {
  const main = read('src/electron/main.js');
  const app = read('src/electron/renderer/app.js');
  const css = read('src/electron/renderer/styles.css');

  assert.match(main, /showHomeLimitProviderNames:\s*false/);
  assert.match(main, /merged\.showHomeLimitProviderNames = parseBoolean\(merged\.showHomeLimitProviderNames, false\)/);
  assert.match(main, /showHomeLimitProviderNames:\s*parseBoolean\(patch\.showHomeLimitProviderNames \?\? settings\.showHomeLimitProviderNames, false\)/);
  // A provider's row count is its account count — except MiMo, whose two
  // products of one account are two rows. Names resolve over the logical-account
  // grouping the Limits page groups by, so one account's lanes never earn an
  // account name and are told apart by their product word alone.
  assert.match(app, /const accountCount = id === 'mimo'\s*\? mimoAccountGroups\(providerEntries\)\.length\s*: providerEntries\.length;/);
  assert.match(app, /limitAccountTitle\(id, provider, index, providerEntries\)/);
  assert.match(app, /state\.settings\?\.showHomeLimitProviderNames === true \|\| state\.settings\?\.showToolIcons === false/);
  assert.match(app, /`\$\{providerTitle\} · \$\{accountTitle\}`/);
  assert.match(app, /const providerNamesRequired = state\.settings\?\.showToolIcons === false/);
  assert.match(app, /providerNamesInput\.checked = providerNamesRequired \|\| state\.settings\?\.showHomeLimitProviderNames === true/);
  assert.match(app, /providerNamesInput\.disabled = providerNamesRequired/);
  assert.match(app, /settings\.home\.providerNamesRequiredWithoutIcons/);
  assert.match(app, /requiredReasonText\.className = 'home-limit-provider-names-reason'/);
  assert.match(app, /providerNamesInput\.setAttribute\('aria-describedby', requiredReasonText\.id\)/);
  assert.match(css, /\.home-limit-provider-names-copy\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.home-limit-provider-names-reason\s*\{[^}]*font-size:\s*0\.625rem/s);
  assert.match(app, /saveSettings\(\{ showHomeLimitProviderNames: providerNamesInput\.checked \}\)/);
  assert.match(app, /renderHomeIfVisible\(\)/);
  assert.match(app, /els\.toolIconsInput\.addEventListener\('change', async \(\) => \{\s*state\.settings\.showToolIcons = els\.toolIconsInput\.checked;\s*renderHomeIfVisible\(\);\s*await saveAppearanceFromControls\(\);\s*\}\);/);
});

test('Home provider name setting is translated in every locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  const expected = {
    en: 'Show provider names for multiple accounts',
    'zh-TW': '多帳號顯示提供者名稱',
    'zh-CN': '多账号显示提供商名称',
    ko: '여러 계정에 제공업체 이름 표시',
    ja: '複数アカウントでプロバイダー名を表示'
  };
  for (const [locale, label] of Object.entries(expected)) {
    assert.equal(MESSAGES[locale]['settings.home.showLimitProviderNames'], label);
    assert.ok(MESSAGES[locale]['settings.home.providerNamesRequiredWithoutIcons']);
  }
});

test('Home account display count defaults to three and is configurable', () => {
  const main = read('src/electron/main.js');
  const app = read('src/electron/renderer/app.js');
  const html = read('src/electron/renderer/index.html');

  assert.match(main, /HOME_LIMIT_ACCOUNT_COUNT_DEFAULT = 3/);
  assert.match(main, /homeLimitAccountCount: HOME_LIMIT_ACCOUNT_COUNT_DEFAULT/);
  assert.match(main, /merged\.homeLimitAccountCount = normalizeHomeLimitAccountCount\(merged\.homeLimitAccountCount\)/);
  assert.match(main, /homeLimitAccountCount: normalizeHomeLimitAccountCount\(patch\.homeLimitAccountCount \?\? settings\.homeLimitAccountCount\)/);
  assert.match(app, /limit: state\.settings\?\.homeLimitAccountCount \?\? 3/);
  const renderSettings = app.slice(app.indexOf('function renderHomeLimitProviderList'), app.indexOf('function renderHomeSettingsList'));
  assert.match(renderSettings, /countInput\.type = 'number'/);
  assert.match(renderSettings, /countInput\.min = '1'/);
  assert.match(renderSettings, /countInput\.max = '12'/);
  assert.match(renderSettings, /saveSettings\(\{ homeLimitAccountCount: Number\(countInput\.value\) \}\)/);
  assert.doesNotMatch(html, /homeLimitAccountCountInput|settings\.limits\.homeAccountCount/);
});

test('Home account display count setting is translated in every locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    assert.ok(messages['settings.home.limitAccountCount'], `${locale} should translate the Home account count setting`);
  }
});
