'use strict';

// The edge dock card and the Limits page are the same rows, built by the same
// module. That only holds while the dock keeps supplying everything the builder
// reads — it takes its whole world through `deps`, so a dependency the dock
// forgets is a TypeError at paint time on a surface no unit test opens.
//
// So this renders the shared view with the dock's own wiring and checks that the
// rows the card used to be missing — spend lines, balances, info tooltips — are
// actually there.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const balanceDisplay = require('../../src/shared/limits/balanceDisplay');
const currencyApi = require('../../src/shared/currency');
const subscriptionApi = require('../../src/shared/subscriptionDisplay');
const subscriptionText = require('../../src/shared/subscriptionText');
const limitDisplayMode = require('../../src/electron/renderer/limits/displayMode');
const limitPresentationApi = require('../../src/electron/renderer/limits/providerPresentation');
const limitResetMotionApi = require('../../src/electron/renderer/limits/resetMotion');
const limitWindowLabels = require('../../src/shared/limits/windowLabels');
const limitWindowTextApi = require('../../src/shared/limits/windowText');
const accountIdentityApi = require('../../src/electron/renderer/accountIdentity');
const i18n = require('../../src/electron/renderer/i18n');
const { createLimitWindowsView } = require('../../src/electron/renderer/limits/windowsView');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
const { parseStepfunUsage } = require('../../src/shared/providers/stepfun/limits');
const { parseFactoryLegacyUsage, parseFactoryTokenRateLimits } = require('../../src/shared/providers/factory/limits');
const { normalizeLimitProvider } = require('../../src/shared/limits/core');

const root = path.join(__dirname, '../..');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.textContent = '';
    this.classNames = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classNames.add(name)),
      contains: (name) => this.classNames.has(name),
      toggle: (name, enabled) => {
        if (enabled) this.classNames.add(name);
        else this.classNames.delete(name);
      }
    };
  }

  get className() { return [...this.classNames].join(' '); }
  set className(value) { this.classNames = new Set(String(value).split(' ').filter(Boolean)); }
  append(...children) {
    for (const child of children.filter(Boolean)) {
      if (child instanceof FakeElement) child.parent = this;
      this.children.push(child);
    }
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  replaceChildren(...children) { this.children = [...children]; }
  querySelector(selector) { return this.find(selector.replace('.', '')); }

  // Depth-first walk, so an assertion can ask what the card actually drew
  // without knowing which provider branch nested it where.
  *walk() {
    yield this;
    for (const child of this.children) if (child instanceof FakeElement) yield* child.walk();
  }

  find(className) {
    return [...this.walk()].find((node) => node.classNames.has(className)) || null;
  }

  textOf(className) {
    return [...this.walk()].filter((node) => node.classNames.has(className)).map((node) => node.textContent);
  }

  // Text nodes are plain objects rather than elements, so the walk skips them;
  // the head's meta line is built from one, so collect them here.
  get text() {
    const parts = [];
    const visit = (node) => {
      if (node.textContent) parts.push(node.textContent);
      for (const child of node.children || []) visit(child);
    };
    visit(this);
    return parts.join(' ');
  }
}

// The call's own text, brace-balanced: the wiring nests objects and functions,
// so the first `});` in it closes the tooltip host rather than the call.
function balancedCall(source, opening) {
  const start = source.indexOf(opening);
  let depth = 0;
  for (let index = start + opening.length - 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

// The dock's own wiring, read off dock.js rather than restated: what is being
// checked is that THAT list is complete. A test may override one dependency to
// watch what the builder asks it (the account control is the one that reports
// back), and gets the real one for everything it does not name.
function dockView(appearance = {}, overrides = {}) {
  const settings = { showLimitUsed: false, claudePrepaidBalanceEnabled: true, ...appearance };
  return createLimitWindowsView({
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (value) => ({ textContent: String(value), children: [] })
    },
    t: (key, params) => i18n.translate('en', key, params),
    settings: () => settings,
    currentLocale: () => 'en-US',
    presentation: limitPresentationApi,
    motion: limitResetMotionApi,
    tooltip: { hasOpened: () => false, markOpened() {}, release() {} },
    formatCompact: (value) => `${value}`,
    compactTokenThreshold: () => 1e3,
    formatMoney: balanceDisplay.formatMoney,
    formatCompactMoney: (value, currency) => balanceDisplay.formatCompactMoney(
      value, currency, settings.compactTokenUnits, 'en-US'
    ),
    formatPercent: (value) => (Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : '--'),
    formatDuration: limitPresentationApi.limitDurationText,
    formatLimitBoundary: limitPresentationApi.limitBoundaryText,
    limitFillPercent: limitDisplayMode.limitFillPercent,
    limitModeSuffix: limitDisplayMode.limitModeSuffix,
    optionalFiniteNumber: (value) => {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    },
    colorWithAlpha: (color, alpha) => `rgba(0, 0, 0, ${alpha})${color}`,
    applyBarScale: (fill, scale) => fill.style.setProperty('--bar-scale', String(scale)),
    creditsAmount: balanceDisplay.creditsAmount,
    creditsMeterPercent: balanceDisplay.creditsMeterPercent,
    isCreditsWindow: balanceDisplay.isCreditsWindow,
    spendWindow: balanceDisplay.spendWindow,
    limitWindowLabel: limitWindowLabels.limitWindowLabel,
    limitWindowText: limitWindowTextApi.limitWindowText,
    accountIdentity: accountIdentityApi,
    // Mirrored from the dock's own wiring: the device context rides the cell
    // being rendered, since this page holds no settings and no device list.
    provenanceContext: () => appearance.provenanceContext || {},
    accountControl: { render: (options) => options.titleNode },
    codexAccounts: { matchesActive: () => false, switchTarget: () => null, canSwitchSystemAccount: () => false },
    hasMark: () => true,
    formatAgo: (ms) => `${Math.round(ms / 60000)}m ago`,
    openExternal: () => {},
    // The subscription side, mirrored from the dock's own wiring: the records
    // ride the pushed appearance, the accounts and the month's cost ride the
    // cell being rendered.
    subscriptionApi,
    subscriptionText,
    currencyApi,
    formatCost: (value) => `$${Number(value).toFixed(2)}`,
    subscriptions: () => appearance.subscriptions || [],
    subscriptionAccounts: () => appearance.accounts || [],
    monthClientCosts: () => appearance.monthClientCosts || {},
    resetForecast: () => ({ busy: false, forecast: appearance.forecast || null }),
    ...overrides
  });
}

test('the dock hands the shared view every dependency it destructures', () => {
  const view = fs.readFileSync(path.join(root, 'src/electron/renderer/limits/windowsView.js'), 'utf8');
  const dock = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const required = view
    .slice(view.indexOf('const {'), view.indexOf('} = deps;'))
    .replace('const {', '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    // A dependency with a default is one the host may legitimately omit.
    .filter((line) => line && !line.includes('='))
    .map((entry) => entry.split(':')[0].replace(',', '').trim())
    .filter(Boolean);
  const wiring = balancedCall(dock, 'createLimitWindowsView({');

  assert.ok(required.length > 10, 'the dependency list should have been parsed');
  for (const name of required) {
    assert.match(wiring, new RegExp(`(^|[\\s{,])${name}\\s*[,:]`, 'm'), `the dock must supply ${name}`);
  }
  // `document` is read off deps separately rather than destructured with the rest.
  assert.match(wiring, /^\s*document,$/m);
});

test('session gauges reuse the detail tooltip builder without an info icon', () => {
  const view = dockView();
  const gauge = new FakeElement('span');
  gauge.className = 'edge-dock-session-cache';
  const { setSessionTooltip } = require('../../src/electron/renderer/sessionRows');
  setSessionTooltip(gauge, { contextTokens: 123000, contextWindow: 200000 }, { minutes: 28 }, (key, params) => i18n.translate('en', key, params), view);
  const tooltip = gauge.find('limit-detail-tooltip');
  assert.ok(tooltip);
  assert.equal(tooltip.text, '123K / 200K Cache ~28m left');
  assert.equal(gauge.find('limit-detail-tooltip-trigger'), null);
  const eventCount = gauge.children.length;
  setSessionTooltip(gauge, null, { minutes: 27 }, (key, params) => i18n.translate('en', key, params), view);
  assert.equal(gauge.children.length, eventCount);
  assert.equal(gauge.find('limit-detail-tooltip'), tooltip);
  assert.equal(tooltip.text, 'Cache ~27m left');
});

// The dependency list above is only half the wiring: the view also reads
// preferences off its settings accessor, and the dock's accessor is the
// appearance projection the main process pushes. A preference the projection
// forgets is not a TypeError — `settings()?.x` reads as undefined and the card
// quietly renders the other answer — so it has to be checked by name. Both
// omissions this guards against (`showLimitSource`, `codexResetForecastEnabled`)
// shipped as exactly that: a card that stayed silent where the page spoke.
test('every preference the shared view reads reaches the dock through the appearance projection', () => {
  const view = fs.readFileSync(path.join(root, 'src/electron/renderer/limits/windowsView.js'), 'utf8');
  const dock = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
  const projection = main.slice(
    main.indexOf('function edgeDockAppearance('),
    main.indexOf('\n}\n', main.indexOf('function edgeDockAppearance('))
  );

  const preferenceKeys = [...new Set([...view.matchAll(/settings\(\)\?\.(\w+)/g)].map((match) => match[1]))];
  assert.ok(preferenceKeys.length >= 5, 'the settings reads should have been parsed');
  for (const key of preferenceKeys) {
    assert.match(projection, new RegExp(`^\\s*${key}:`, 'm'), `edgeDockAppearance must carry ${key}`);
  }
  // And the projection is what the view actually gets: the dock's settings
  // accessor is the pushed appearance, not a second copy.
  assert.match(dock, /settings: appearance,/);
  assert.match(dock, /function appearance\(\) \{\s*return state\.payload\?\.appearance \|\| \{\};/);
  // A key the projection carries but nothing pushes is the same bug one hop
  // further out, so the push has to be the projection itself.
  assert.match(main, /controller\.setAppearance\(edgeDockAppearance\(/);
  const controller = fs.readFileSync(path.join(root, 'src/electron/edgeDock/controller.js'), 'utf8');
  assert.match(controller, /const base = \{ surface, side, platform, osRelease: os\.release\(\), appearance,/);
});

test('a DeepSeek card shows the spend row the projection used to drop', () => {
  const card = dockView().renderProviderWindows({
    provider: 'deepseek',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 4.2, currency: 'USD', showMeter: false }],
    balance: { amount: 4.2, currency: 'USD', todaySpend: 0.12, monthSpend: 1.4 }
  }, '#4D6BFE');

  assert.ok(card.find('limit-spend'), 'the card should carry the spend row');
  assert.match(card.text, /Today/);
  assert.match(card.text, /Month/);
  assert.match(card.text, /\$4\.20/);
});

test('a TypeSafe card shows the next credit expiry without calling it a reset', () => {
  const card = dockView().renderProviderWindows({
    provider: 'typesafe',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 5, currency: 'USD',
      resetsAt: '2099-01-02T00:00:00Z', boundaryKind: 'expiry' }],
    balance: { amount: 5, currency: 'USD', tranches: [
      { amount: 2, currency: 'USD', expiresAt: '2099-01-02T00:00:00Z' },
      { amount: 3, currency: 'USD', expiresAt: '2099-02-02T00:00:00Z' }
    ] }
  }, '#59A4D0');

  assert.match(card.text, /Expires \d+d \d+h/);
  assert.match(card.text, /\$2\.00/);
  assert.doesNotMatch(card.text, /Reset/);
  assert.equal(card.find('limit-window').classNames.has('limit-window-no-reset'), false);
});

test('StepFun draws rolling windows and Token Plan credit as actual meters', () => {
  const reset = String(Math.floor(Date.now() / 1000) + 86400);
  const coding = dockView().renderProviderWindows({ provider: 'stepfun', windows: parseStepfunUsage({
    status: 1, five_hour_usage_left_rate: 0.8, weekly_usage_left_rate: 0.6,
    five_hour_usage_reset_time: reset, weekly_usage_reset_time: reset
  }) }, '#000000');
  assert.deepEqual([...coding.walk()].filter((node) => node.classNames.has('limit-window-text')).map((node) => node.children[0].textContent), ['5-hour', 'Weekly']);
  assert.equal(coding.textOf('limit-meter').length, 2);

  const credit = dockView().renderProviderWindows({ provider: 'stepfun', windows: parseStepfunUsage({
    status: 1, plan_family: 2, five_hour_usage_reset_time: '0', weekly_usage_reset_time: '0',
    plan_credit_rate_limit: { subscription_credit_left_rate: 0.73, subscription_credit_reset_time: reset }
  }) }, '#000000');
  assert.deepEqual([...credit.walk()].filter((node) => node.classNames.has('limit-window-text')).map((node) => node.children[0].textContent), ['Credit']);
  assert.equal(credit.textOf('limit-meter').length, 1);
  assert.ok(credit.find('limit-window').classNames.has('limit-window-wide'));
  assert.match(credit.text, /73% left/);
});

test('a TypeSafe card does not repeat the full balance beside its expiry', () => {
  const card = dockView().renderProviderWindows({
    provider: 'typesafe',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 5, currency: 'USD',
      resetsAt: '2099-01-02T00:00:00Z', boundaryKind: 'expiry' }],
    balance: { amount: 5, currency: 'USD', tranches: [
      { amount: 5, currency: 'USD', expiresAt: '2099-01-02T00:00:00Z' }
    ] }
  }, '#59A4D0');

  assert.match(card.text, /Expires \d+d \d+h/);
  assert.equal(card.text.match(/\$5\.00/g)?.length, 1);
});

test('a TypeSafe card omits expiry when the billing response has no valid grants', () => {
  const card = dockView().renderProviderWindows({
    provider: 'typesafe',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 5, currency: 'USD' }],
    balance: { amount: 5, currency: 'USD' }
  }, '#59A4D0');

  assert.doesNotMatch(card.text, /expiry|Reset/);
  assert.equal(card.find('limit-window').classNames.has('limit-window-no-reset'), true);
});

test('an OpenRouter card carries the balance meter and its detail tooltip', () => {
  const card = dockView().renderProviderWindows({
    provider: 'openrouter',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Credits', remaining: 12.5, currency: 'USD' }],
    balance: { amount: 12.5, currency: 'USD', todaySpend: 0.5, weekSpend: 2, monthSpend: 6, allTimeSpend: 40 }
  }, '#6566F1');

  const tooltip = card.find('limit-detail-tooltip');
  assert.ok(tooltip, 'the card should carry the ⓘ tooltip, not only the page');
  assert.match(card.find('limit-detail-tooltip-trigger').textContent, /i/);
  assert.match(tooltip.text, /All time/);
});

test('a Devin card keeps Daily, Weekly, and the extra usage balance', () => {
  const card = dockView().renderProviderWindows({
    provider: 'devin',
    windows: [
      { kind: 'daily', label: 'Daily', remainingPercent: 100, resetsAt: '2026-09-24T00:00:00.000Z' },
      { kind: 'weekly', label: 'Weekly', remainingPercent: 100, resetsAt: '2026-09-28T00:00:00.000Z' },
      { kind: 'billing', metric: 'credits', label: 'Extra usage balance', remaining: 10, currency: 'USD', showMeter: false }
    ],
    balance: { amount: 10, currency: 'USD' }
  }, '#46B482');

  const windows = [...card.walk()].filter((node) => node.classNames.has('limit-window'));
  assert.deepEqual(
    windows.map((node) => node.children[0].children[0].textContent),
    ['Daily', 'Weekly', 'Extra usage balance']
  );
  assert.match(windows[2].text, /\$10\.00/);
  assert.equal(windows[2].classNames.has('limit-window-wide'), true);
  assert.equal(windows[2].classNames.has('limit-window-no-reset'), true);
});

test('a Factory card draws both pools and the extra usage balance', () => {
  // The collector's real output: normalizeLimitProvider() sorts windows by
  // kind, interleaving the Standard and Core pools, and turns the balance
  // into a credits window.
  const now = Date.parse('2026-09-10T12:00:00Z');
  const parsed = parseFactoryTokenRateLimits({
    usesTokenRateLimitsBilling: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 12.5, secondsRemaining: 1800 },
        weekly: { usedPercent: 25, windowEnd: '2026-09-14T12:00:00Z' },
        monthly: { usedPercent: 40, windowEnd: 1788192000000 }
      },
      core: {
        fiveHour: { usedPercent: 5, secondsRemaining: 900 },
        weekly: { usedPercent: 10 },
        monthly: { usedPercent: 0, secondsRemaining: 86400 }
      }
    },
    extraUsageBalanceCents: 1234
  }, now);
  const card = dockView().renderProviderWindows(
    normalizeLimitProvider({ provider: 'factory', status: 'ok', ...parsed }),
    '#FF6F00'
  );

  const windows = [...card.walk()].filter((node) => node.classNames.has('limit-window'));
  assert.deepEqual(
    windows.map((node) => node.children[0].children[0].textContent),
    ['5-hour', 'Weekly', 'Monthly', 'Core 5-hour', 'Core Weekly', 'Core Monthly', 'Balance']
  );
  assert.deepEqual(
    windows.map((node) => node.classNames.has('limit-window-wide')),
    [false, false, true, false, false, true, true]
  );
  assert.match(windows[6].text, /\$12\.34/);
  assert.equal(windows[6].classNames.has('limit-window-no-reset'), true);
});

test('a legacy Factory card draws its Standard and Premium billing windows', () => {
  const card = dockView().renderProviderWindows(normalizeLimitProvider({
    provider: 'factory',
    status: 'ok',
    ...parseFactoryLegacyUsage({
      usage: {
        endDate: '2026-10-01T00:00:00Z',
        standard: { userTokens: 250, totalAllowance: 1000 },
        premium: { userTokens: 50, totalAllowance: 100 }
      }
    })
  }), '#FF6F00');

  const windows = [...card.walk()].filter((node) => node.classNames.has('limit-window'));
  assert.deepEqual(windows.map((node) => node.children[0].children[0].textContent), ['Standard', 'Premium']);
  assert.ok(windows.every((node) => node.classNames.has('limit-window-wide')));
});

test('a Cline card folds month spend into the credit detail tooltip', () => {
  const card = dockView().renderProviderWindows({
    provider: 'cline',
    windows: [
      { kind: 'billing', metric: 'credits', label: 'Credits', remaining: 0.5, currency: 'CREDITS', showMeter: false },
      { kind: 'billing', metric: 'spend', label: 'Usage credits', used: 0.13, limit: null, currency: 'USD', showMeter: false }
    ]
  }, '#9D4EDD');

  const rows = [...card.walk()].filter((node) => node.classNames.has('limit-window'));
  const tooltip = card.find('limit-detail-tooltip');
  assert.equal(rows.length, 1, 'credits and month spend should share one presentation row');
  assert.match(card.text, /Credits/);
  assert.match(card.text, /0\.50/);
  assert.ok(tooltip, 'the month spend should remain available from the credit row');
  assert.match(tooltip.text, /Month spent/);
  assert.match(tooltip.text, /\$0\.13/);
  assert.match(rows[0].attributes['aria-label'], /Month spent \$0\.13/);
});

test('a Codex card keeps the page ordering and the banked resets', () => {
  const card = dockView().renderProviderWindows({
    provider: 'codex',
    windows: [
      { kind: 'session', label: 'Session', remainingPercent: 70, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      { kind: 'weekly', label: '', remainingPercent: 55 },
      { kind: 'billing', label: 'Monthly', remainingPercent: 40 }
    ],
    resetCredits: { availableCount: 2, expirations: [new Date(Date.now() + 86_400_000).toISOString()] }
  }, '#10A37F');

  const windows = [...card.walk()].filter((node) => node.classNames.has('limit-window'));
  // Banked resets are a window row of their own on the page, and now here too.
  assert.deepEqual(
    windows.map((node) => node.children[0].children[0].textContent),
    ['Session', 'Weekly', 'Monthly', '2 resets']
  );
  assert.ok(card.find('limit-reset-credits'), 'banked resets belong on both surfaces');
  assert.equal(windows[2].classNames.has('limit-window-wide'), true);
  assert.match(windows[0].text, /Reset 1h 0m/);
});

test('the Codex additional-limit preference reaches the card through its own settings', () => {
  const provider = {
    provider: 'codex',
    windows: [
      { kind: 'session', label: 'Session', remainingPercent: 70 },
      { kind: 'daily', label: 'GPT-5.3-Codex-Spark', remainingPercent: 40, additional: true }
    ]
  };
  const labels = (appearance) => dockView(appearance)
    .renderProviderWindows(provider, '#10A37F')
    .textOf('limit-window-text')
    .length;

  assert.equal(labels({ showCodexAdditionalLimits: true }), 2);
  assert.equal(labels({ showCodexAdditionalLimits: false }), 1);
});

// The head was the other half of the divergence: the card hand-wrote it, so it
// showed a bare "Updated 2m ago" where the page showed the collection source
// beside it, a plan pill where the page showed the plan text, and no account
// count at all on a provider the page grouped.
test('a single-account row carries the page head: mark, title, meta and plan', () => {
  const row = dockView({ showLimitSource: true }).renderLimitProviderRow('codex', 'Codex', {
    provider: 'codex',
    status: 'ok',
    source: 'oauth',
    planLabel: 'Plus',
    accountEmail: 'demo@example.com',
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  }, '#10A37F');

  assert.ok(row.find('limit-icon'), 'the row heads with the provider mark');
  assert.equal(row.find('limit-name-title').textContent, 'Codex');
  assert.match(row.find('limit-meta').text, /Updated 2m ago · OAuth/);
  assert.equal(row.find('limit-plan').textContent, 'Plus');
});

test('a grouped provider heads with the account count the page shows', () => {
  const account = (email) => ({
    provider: 'codex',
    status: 'ok',
    accountEmail: email,
    updatedAt: new Date().toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  });
  const group = dockView().renderLimitProviderGroup(
    'codex',
    'Codex',
    ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'].map(account),
    '#10A37F'
  );

  assert.equal(group.find('limit-plan').textContent, '4 accounts');
  assert.equal([...group.walk()].filter((node) => node.classNames.has('limit-account-row')).length, 4);

  // A provider with no count phrase of its own prints nothing rather than the
  // untranslated key.
  const untranslated = dockView().renderLimitProviderGroup('deepseek', 'DeepSeek', [account('a@x'), account('b@x')], '#4D6BFE');
  assert.equal(untranslated.find('limit-plan').textContent, '');
});

// The switch control reads "Use {account} as this device's Codex account", and
// the name in that sentence was read off the object switchTarget() resolved —
// which the two surfaces resolve differently: the page looks the account up in
// its managed entries, which carry the raw `email`, while the card's projection
// reports an id and nothing else. So one control named the account on the page
// and read the unnamed placeholder on the card, and the page printed, under a
// masked title, exactly the address masking hides. The builder names the account
// itself now, from the record, in the form the row is titled with.
test('the Codex switch names the account the row beside it is titled with', () => {
  const accounts = ['a@example.com', 'b@example.com'].map((accountEmail) => ({
    provider: 'codex',
    status: 'ok',
    accountKey: `sha256:${accountEmail}`,
    accountEmail,
    updatedAt: new Date().toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  }));
  const render = (switchTarget) => {
    const labels = [];
    const view = dockView({ maskLimitAccountEmails: true }, {
      accountControl: {
        // Only a render that gets a target draws a switch (the control returns
        // the title untouched otherwise), so only those labels are collected.
        render: (options) => {
          if (options.switchAccount) labels.push(options.accountLabel);
          return options.titleNode;
        }
      },
      codexAccounts: { matchesActive: () => false, switchTarget, canSwitchSystemAccount: () => true }
    });
    const group = view.renderLimitProviderGroup('codex', 'Codex', accounts, '#10A37F');
    const solo = view.renderLimitProviderSolo('codex', 'Codex', accounts[0], '#10A37F');
    return {
      labels,
      titles: group.find('limit-account-list').children.map((row) => row.find('limit-name-title').textContent),
      soloTitle: solo.find('limit-name-title').textContent
    };
  };

  // The page's target is the managed entry; the card's carries the id alone.
  const page = render((provider) => ({ id: `codex-${provider.accountEmail}`, email: provider.accountEmail }));
  const card = render((provider) => ({ id: `codex-${provider.accountEmail}` }));

  assert.deepEqual(page.labels, ['a***@example.com', 'b***@example.com', 'a***@example.com']);
  assert.deepEqual(card.labels, page.labels, 'an id-only target names the account too');
  assert.deepEqual(page.labels.slice(0, 2), page.titles, 'and it is the name the row itself shows');
  assert.doesNotMatch(page.labels.join(' '), /[ab]@example\.com/, 'the address masking hides stays off the tooltip');
  // Standing alone the row is the provider, so the switch is the only place the
  // account is named at all — the card named it there before the card became
  // this builder, and does again.
  assert.equal(page.soloTitle, 'Codex');
});

// The mark rule reads like a rule about the provider and is a rule about the
// row's company: a group already names the provider in its header, so its
// account rows drop the mark, while a solo row IS the provider and has nothing
// else to be recognised by. Applied without that second half, every solo Claude,
// MiMo, Cursor, OpenCode and Volcengine row lost its mark on both surfaces at
// once — the card and the page agreed with each other and with nothing the user
// had seen before.
//
// OpenRouter and Antigravity are in the list for the other half: one login per
// row under a header that already wears the mark, so the rows drop theirs too.
// They were the two the policy table was missing, and a group drew the mark on
// its header and then again on every row beneath it.
test('a provider that drops its mark inside a group keeps it standing alone', () => {
  const account = (provider, key) => ({
    provider,
    status: 'ok',
    accountKey: key,
    updatedAt: new Date().toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  });
  const view = dockView();

  for (const [id, label, color] of [
    ['claude', 'Claude', '#D97757'],
    ['openrouter', 'OpenRouter', '#6566F1'],
    ['antigravity', 'Antigravity', '#4285F4']
  ]) {
    const solo = view.renderLimitProviderSolo(id, label, account(id, 'k1'), color);
    assert.ok(solo.find('limit-icon'), `${id}: a solo row wears the provider mark`);

    const group = view.renderLimitProviderGroup(id, label, [account(id, 'k1'), account(id, 'k2')], color);
    assert.ok(group.find('limit-icon'), `${id}: the group header wears it instead`);
    const list = group.find('limit-account-list');
    assert.equal(list.children.length, 2);
    for (const row of list.children) {
      assert.equal(row.find('limit-icon'), null, `${id}: an account row is named by its own title`);
    }
  }
});

test('a group-only plan replacement leaves a solo row its plan', () => {
  const view = dockView();
  // A profile name stored before accountName existed: inside a group it would
  // only repeat the row's own title, standing alone it IS the plan.
  const legacy = { provider: 'opencode', status: 'ok', accountKey: 'k1', accountLabel: 'work profile', windows: [] };

  assert.equal(view.renderLimitProviderSolo('opencode', 'OpenCode', legacy, '#8C4EDD').find('limit-plan').textContent, 'Work profile');
  const group = view.renderLimitProviderGroup('opencode', 'OpenCode', [legacy, { ...legacy, accountKey: 'k2' }], '#8C4EDD');
  assert.equal(group.find('limit-plan').textContent, '2 accounts');
  for (const row of group.find('limit-account-list').children) {
    assert.equal(row.find('limit-plan').textContent, '', 'the group title already carries it');
  }
});

test('the Codex reset forecast rides the card with its own tooltip', () => {
  const row = dockView({
    codexResetForecastEnabled: true,
    forecast: {
      status: 'active',
      chancePercent: 62,
      predictedAt: new Date(Date.now() + 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      latestResetAt: new Date(Date.now() - 86_400_000).toISOString(),
      sourceAuthor: 'someone',
      observedAt: new Date(Date.now() - 600_000).toISOString()
    }
  }).renderLimitProviderRow('codex', 'Codex', {
    provider: 'codex',
    status: 'ok',
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  }, '#10A37F');

  const forecast = row.find('codex-reset-forecast');
  assert.ok(forecast, 'the forecast row belongs on both surfaces');
  assert.ok(forecast.find('codex-reset-forecast-info-wrap'), 'and so does its tooltip');
  assert.match(forecast.find('limit-detail-tooltip').text, /Last reset|Signal|Expires/);
  // Switched off, neither surface draws it.
  const off = dockView({ codexResetForecastEnabled: false })
    .renderLimitProviderRow('codex', 'Codex', { provider: 'codex', status: 'ok', windows: [] }, '#10A37F');
  assert.equal(off.find('codex-reset-forecast'), null);
});

// The plan cell used to be the one row that differed: the page hung a hover card
// off it and the card showed the plan as dead text, because the decoration was
// the widget's own and arrived through a `decoratePlan` hook the dock had
// nothing to pass. The view builds that cell on both surfaces, so it builds the
// card too — and a record is the only switch there is.
test('a recorded subscription decorates the card plan cell with the page hover card', () => {
  const account = { provider: 'codex', accountKey: 'k1', accountName: 'demo@example.com' };
  const subscription = {
    id: 'sub-1',
    provider: 'codex',
    kind: 'subscription',
    planName: 'Plus',
    amountMinor: 2000,
    currency: 'USD',
    intervalCount: 1,
    interval: 'month',
    startDate: '2026-08-01',
    autoRenew: true,
    nextRenewalOverride: '',
    endDate: null,
    topUps: []
  };
  const row = dockView({
    subscriptions: [subscription],
    accounts: [account],
    monthClientCosts: { codex: 12 }
  }).renderLimitProviderRow('codex', 'Codex', {
    ...account,
    status: 'ok',
    planLabel: 'Plus',
    updatedAt: new Date().toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  }, '#10A37F');

  const wrap = row.find('subscription-plan-wrap');
  assert.ok(wrap, 'the plan cell should be the hover trigger, as it is on the page');
  assert.equal(wrap.find('subscription-plan-trigger').textContent, 'Plus');
  const card = wrap.find('subscription-tooltip');
  assert.ok(card, 'and it should carry the subscription card the page shows');
  assert.match(card.text, /\$20\.00/);
  assert.match(card.text, /12\.00/, 'the month\'s usage is charged against it');
  assert.equal(row.find('limit-plan'), wrap, 'the page class survives, so styling is shared');

  // No record, no card — and the plain cell underneath is unchanged.
  const bare = dockView({ accounts: [account] }).renderLimitProviderRow('codex', 'Codex', {
    ...account,
    status: 'ok',
    planLabel: 'Plus',
    windows: []
  }, '#10A37F');
  assert.equal(bare.find('subscription-tooltip'), null);
  assert.equal(bare.find('limit-plan').textContent, 'Plus');
});

// The usage figure is keyed by client, and a provider is not always named after
// the client whose tokens it bills. Read as a same-named key, a Factory Droid
// subscription found nothing at `factory` while the month's cost sat under
// `droid`, so the card stopped at the price and never showed what those tokens
// would have cost instead.
test('a subscription is compared against usage recorded under a differently named client', () => {
  const account = { provider: 'factory', accountKey: 'k1', accountName: 'demo@example.com' };
  const row = dockView({
    subscriptions: [{
      id: 'sub-1',
      provider: 'factory',
      kind: 'subscription',
      planName: 'Pro',
      amountMinor: 2000,
      currency: 'USD',
      intervalCount: 1,
      interval: 'month',
      startDate: '2026-08-01',
      autoRenew: true,
      nextRenewalOverride: '',
      endDate: null,
      topUps: []
    }],
    accounts: [account],
    monthClientCosts: { droid: 12, codex: 99 }
  }).renderLimitProviderRow('factory', 'Factory Droid', {
    ...account,
    status: 'ok',
    planLabel: 'Pro',
    updatedAt: new Date().toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  }, '#10A37F');

  const card = row.find('subscription-tooltip');
  assert.ok(card, 'the recorded plan still draws its card');
  assert.match(card.text, /12\.00/, "Droid's tokens are Factory's usage");
  assert.doesNotMatch(card.text, /99/, 'and another client\'s tokens stay out of it');
});

// The row is drawn from the aggregate's copy of an account, while the matcher
// can resolve a record to this device's copy of the same account. Those are two
// records, and what makes them one account is the key — not the display name,
// which each copy may read differently. Asked as a value built out of the record
// instead, the row that the record names lost its plan cell.
test('a record decorates the row whose account it resolved to, copy or no copy', () => {
  const subscription = {
    id: 'sub-1',
    provider: 'codex',
    kind: 'subscription',
    planName: 'Plus',
    amountMinor: 2000,
    currency: 'USD',
    intervalCount: 1,
    interval: 'month',
    startDate: '2026-08-01',
    autoRenew: true,
    nextRenewalOverride: '',
    endDate: null,
    binding: { accountKey: 'k1' },
    topUps: []
  };
  const drawn = { provider: 'codex', accountKey: 'k1', accountName: 'demo@example.com' };
  const mine = { provider: 'codex', accountKey: 'k1', accountName: 'demo' };
  const row = dockView({ subscriptions: [subscription], accounts: [mine] }).renderLimitProviderRow('codex', 'Codex', {
    ...drawn,
    status: 'ok',
    planLabel: 'Plus',
    updatedAt: new Date().toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  }, '#10A37F');

  const card = row.find('subscription-tooltip');
  assert.ok(card, "the account's own record decorates its row");
  assert.match(card.text, /\$20\.00/);
});

// A record binds to an account, and an account the composer hides is still one
// the provider has. Matched against the rows on screen instead, a record bound
// to the hidden account falls through matchProviderAccount()'s sole-account
// fallback and hands its price, renewal and top-ups to the row that is left.
test('a subscription bound to a hidden account does not decorate the row that is left', () => {
  const record = (key) => ({
    provider: 'codex',
    status: 'ok',
    accountKey: key,
    accountName: `${key}@example.com`,
    planLabel: 'Plus',
    updatedAt: new Date().toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  });
  const subscription = {
    id: 'sub-1',
    provider: 'codex',
    kind: 'subscription',
    planName: 'Plus',
    amountMinor: 2000,
    currency: 'USD',
    intervalCount: 1,
    interval: 'month',
    startDate: '2026-08-01',
    autoRenew: true,
    nextRenewalOverride: '',
    endDate: null,
    topUps: [],
    binding: { accountKey: 'a' }
  };
  const stats = { limits: { providers: [record('a'), record('b')] } };
  const cell = (hiddenAccounts) => buildEdgeDockCells(stats, {
    items: [{ type: 'limit', provider: 'codex', hiddenAccounts, showUsage: true }]
  })[0];
  // The dock's own wiring, one line from dock.js: the universe rides the cell
  // rather than being read back off the accounts it draws.
  const rowFor = (built, key) => dockView({ subscriptions: [subscription] }, {
    subscriptionAccounts: () => built.subscriptionAccounts || []
  }).renderLimitProviderSolo(
    'codex',
    'Codex',
    built.accounts.find((account) => account.record.accountKey === key).record,
    '#10A37F'
  );

  assert.ok(rowFor(cell([]), 'a').find('subscription-tooltip'), 'the bound account wears its card');
  assert.equal(rowFor(cell([]), 'b').find('subscription-tooltip'), null, 'and its sibling does not inherit it');
  assert.equal(
    rowFor(cell(['a']), 'b').find('subscription-tooltip'),
    null,
    'hiding the bound account must not move its card to the row beside it'
  );

  const dock = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
  assert.match(dock, /subscriptionAccounts: \(\) => state\.payload\?\.cell\?\.subscriptionAccounts \|\| \[\],/);
});

// Hiding is not the only display rule that narrows the universe. The rail lists
// only accounts that report something, which is another choice about what to
// draw — so a failing account with no last-known windows drops out of the rows
// while its subscription stays recorded against it, and the matcher sees the one
// account left.
test('an account the rail drops for reporting nothing does not lend its record to the row left behind', () => {
  const codexRecord = (key, status, windows) => ({
    provider: 'codex',
    status,
    accountKey: key,
    accountName: `${key}@example.com`,
    planLabel: 'Plus',
    updatedAt: new Date().toISOString(),
    windows
  });
  const window = { kind: 'session', label: 'Session', remainingPercent: 70 };
  const subscription = {
    id: 'sub-1',
    provider: 'codex',
    kind: 'subscription',
    planName: 'Plus',
    amountMinor: 2000,
    currency: 'USD',
    intervalCount: 1,
    interval: 'month',
    startDate: '2026-08-01',
    autoRenew: true,
    nextRenewalOverride: '',
    endDate: null,
    topUps: [],
    binding: { accountKey: 'b' }
  };
  const stats = { limits: { providers: [codexRecord('a', 'ok', [window]), codexRecord('b', 'error', [])] } };
  const [cell] = buildEdgeDockCells(stats, { items: [{ type: 'limit', provider: 'codex', showUsage: true }] });

  assert.deepEqual(cell.accounts.map((account) => account.record.accountKey), ['a'], 'only a is drawn');
  assert.deepEqual(
    cell.subscriptionAccounts.map((account) => account.accountKey),
    ['a', 'b'],
    'b is still an account the provider has, and the record binds to it'
  );

  const row = dockView({ subscriptions: [subscription] }, {
    subscriptionAccounts: () => cell.subscriptionAccounts
  }).renderLimitProviderSolo('codex', 'Codex', cell.accounts[0].record, '#10A37F');
  assert.equal(row.find('subscription-tooltip'), null, "b's plan must not appear on a");
});

// A group header stands for the rows under it, so its summary has to be drawn
// from those accounts too. Computed from the provider's subscriptions instead,
// a record bound to an account the composer hides is carded and counted on a
// header that has already said how many accounts it covers.
test('a group header cards the accounts it draws and totals the provider', () => {
  const codexRecord = (key) => ({
    provider: 'codex',
    status: 'ok',
    accountKey: key,
    accountName: `${key}@example.com`,
    planLabel: 'Plus',
    updatedAt: new Date().toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }]
  });
  const subscription = (id, key, amountMinor) => ({
    id,
    provider: 'codex',
    kind: 'subscription',
    planName: 'Plus',
    amountMinor,
    currency: 'USD',
    intervalCount: 1,
    interval: 'month',
    startDate: '2026-08-01',
    autoRenew: true,
    nextRenewalOverride: '',
    endDate: null,
    topUps: [],
    binding: { accountKey: key }
  });
  const stats = { limits: { providers: [codexRecord('a'), codexRecord('b'), codexRecord('c')] } };
  const headerFor = (subscriptions, hiddenAccounts) => {
    const [cell] = buildEdgeDockCells(stats, {
      items: [{ type: 'limit', provider: 'codex', hiddenAccounts, showUsage: true }]
    });
    const drawn = cell.accounts.map((account) => account.record);
    // The rollup is read against the month's usage, so a fixture without one
    // would assert on a card the rollup never reaches.
    return dockView({ subscriptions, monthClientCosts: { codex: 12 } }, {
      subscriptionAccounts: () => cell.subscriptionAccounts
    }).renderLimitProviderGroup('codex', 'Codex', drawn, '#10A37F');
  };

  const onlyHidden = headerFor([subscription('sub-1', 'a', 1000)], ['a']);
  assert.equal(
    onlyHidden.find('subscription-tooltip'),
    null,
    "the hidden account's card must not hang off a header that does not cover it"
  );

  const everyAccount = headerFor([
    subscription('sub-1', 'a', 1000),
    subscription('sub-2', 'b', 1000),
    subscription('sub-3', 'c', 1000)
  ], ['a']);
  const summary = everyAccount.find('subscription-tooltip');
  assert.ok(summary, 'the two accounts that do have records are still summarised');
  assert.match(summary.text, /3 subscriptions · \$30\.00 \/ mo/, "the total is the provider's, not the drawn set's");

  // One matching record left, so the header falls back to that account's own
  // card. It reads the same provider total the summary does: the two shapes are
  // the same row, and a total that moved with the shape would be two answers to
  // one question.
  const oneAccount = headerFor([
    subscription('sub-1', 'a', 2000),
    subscription('sub-2', 'b', 1000)
  ], ['a']);
  const single = oneAccount.find('subscription-tooltip');
  assert.ok(single, 'b keeps its own card');
  assert.match(single.text, /\$10\.00 \/ mo/, "the card is b's, the account the header draws");
  assert.match(single.text, /2 subscriptions · \$30\.00 \/ mo/, 'and the total still covers the provider');

  // The same row hidden down to one account, which the card draws in its solo
  // shape. Hiding accounts is a display choice; the money is still being spent.
  const [soloCell] = buildEdgeDockCells(stats, {
    items: [{ type: 'limit', provider: 'codex', hiddenAccounts: ['a', 'c'], showUsage: true }]
  });
  const solo = dockView({
    subscriptions: [subscription('sub-1', 'a', 2000), subscription('sub-2', 'b', 1000)],
    monthClientCosts: { codex: 12 }
  }, {
    subscriptionAccounts: () => soloCell.subscriptionAccounts
  }).renderLimitProviderSolo('codex', 'Codex', soloCell.accounts[0].record, '#10A37F');
  const soloCard = solo.find('subscription-tooltip');
  assert.match(soloCard.text, /\$10\.00 \/ mo/);
  assert.match(soloCard.text, /2 subscriptions · \$30\.00 \/ mo/, 'the solo shape answers the same way');
});

// The row's "· imac-m1" is the page's context, not the record's: a reading that
// came from another device is only nameable against this device's id, whether
// sync is on, and the device list. The shared view reads that through a dep, so
// the surface that has the context has to hand it over — the page stopped doing
// so when the row moved into the shared builder, and the device name silently
// disappeared from a line that still said which collection source it came from.
test('a row whose reading came from another device names that device', () => {
  const record = {
    provider: 'kiro',
    status: 'ok',
    source: 'cli',
    sourceDeviceId: 'imac-m1',
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
    windows: [{ kind: 'billing', label: 'Credits', remainingPercent: 100 }]
  };
  const context = { localDeviceId: 'this-mac', syncActive: true, devices: [{ deviceId: 'imac-m1' }] };
  const rowFor = (overrides) => dockView({ showLimitSource: true }, overrides)
    .renderLimitProviderSolo('kiro', 'Kiro', record, '#8B5CF6');

  assert.match(
    rowFor({ provenanceContext: () => context }).find('limit-meta').text,
    /Updated 2m ago · CLI · imac-m1/
  );
  // A host with no such context gets the source and no name, rather than a name
  // nobody resolved.
  assert.match(rowFor({}).find('limit-meta').text, /Updated 2m ago · CLI$/);
});

// The dock card is the surface that had no context at all: it is handed cells,
// so the two facts it needs — which device this is, and whether syncing is on —
// have to ride the cell the main process builds.
test('the dock card names the device from the cell it is handed', () => {
  const record = {
    provider: 'kiro',
    status: 'ok',
    source: 'cli',
    sourceDeviceId: 'imac-m1',
    accountKey: 'k',
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
    windows: [{ kind: 'billing', label: 'Credits', remainingPercent: 100 }]
  };
  const [cell] = buildEdgeDockCells({ limits: { providers: [record] } }, {
    items: [{ type: 'limit', provider: 'kiro' }],
    localDeviceId: 'this-mac',
    syncActive: true
  });
  assert.deepEqual(
    cell.provenanceContext,
    { localDeviceId: 'this-mac', syncActive: true },
    'the cell carries the context the card has no other way to read'
  );
  const row = dockView({ showLimitSource: true }, { provenanceContext: () => cell.provenanceContext })
    .renderLimitProviderSolo('kiro', 'Kiro', cell.accounts[0].record, '#8B5CF6');
  assert.match(row.find('limit-meta').text, /Updated 2m ago · CLI · imac-m1/);
});

test('the page hands the shared view the device context its rows read', () => {
  const app = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
  const wiring = app.slice(
    app.indexOf('const limitWindowsView = window.TokenMonitorLimitWindowsView.createLimitWindowsView({'),
    app.indexOf('function optionalFiniteNumber(value) {', app.indexOf('const limitWindowsView = window'))
  );
  assert.match(wiring, /(^|[\s{,])provenanceContext\s*[,:]/, 'the page must hand the view its device context');
  // And the context it hands over is the live one, not a context-free call that
  // reads as wired while naming nothing.
  assert.match(wiring, /localDeviceId: state\.settings\?\.deviceId/);
  assert.match(wiring, /syncActive: syncProvenanceActive\(\)/);
  assert.match(wiring, /devices: state\.stats\?\.devices/);
});

// The dock's half of the same wiring: it reads the context off the cell it is
// rendering, because that page has no settings and no device list of its own.
test('the dock hands the shared view the device context a cell carries', () => {
  const dock = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const wiring = balancedCall(dock, 'createLimitWindowsView({');
  assert.match(
    wiring,
    /provenanceContext: \(\) => state\.payload\?\.cell\?\.provenanceContext/,
    'the dock card must read the context off the cell it renders'
  );
});

test('a stale row is dimmed by the page rule, not recoloured', () => {
  const row = dockView().renderLimitProviderRow('openrouter', 'OpenRouter', {
    provider: 'openrouter',
    status: 'ok',
    stale: true,
    updatedAt: new Date(Date.now() - 3_300_000).toISOString(),
    windows: []
  }, '#6566F1');

  assert.equal(row.classNames.has('stale'), true);
  const dock = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
  assert.doesNotMatch(dock, /freshness\.tone === 'stale'/, 'the card no longer paints staleness orange on its own');
});

// ---- Visible usage items ----------------------------------------------------
// The checklist is read off the card itself, so these check both halves: what
// the card tags, and what an unchecked tag removes.

const usageItems = require('../../src/shared/limits/usageItems');

const codexRecord = () => ({
  provider: 'codex',
  windows: [
    { kind: 'session', label: 'Session', remainingPercent: 70 },
    { kind: 'weekly', label: '', remainingPercent: 55 },
    { kind: 'billing', label: 'Monthly', remainingPercent: 40 },
    { kind: 'session', label: 'Spark', remainingPercent: 90, additional: true }
  ],
  resetCredits: { availableCount: 2, expirations: [new Date(Date.now() + 86_400_000).toISOString()] }
});

const windowTitles = (card) => [...card.walk()]
  .filter((node) => node.classNames.has('limit-window'))
  .map((node) => node.children[0].children[0].textContent);

test('the checklist lists what the card draws, in card order, Codex additional pools included', () => {
  const items = dockView().limitProviderUsageItems([codexRecord()]);
  assert.deepEqual(items.map((item) => item.id), [
    usageItems.limitWindowKey({ kind: 'session', label: 'Session' }),
    usageItems.limitWindowKey({ kind: 'weekly', label: '' }),
    usageItems.limitWindowKey({ kind: 'billing', label: 'Monthly' }),
    usageItems.limitWindowKey({ kind: 'session', label: 'Spark', additional: true }),
    'resets'
  ]);
  assert.deepEqual(items.map((item) => item.label), ['Session', 'Weekly', 'Monthly', 'Spark', 'Resets']);
});

test('the checklist names each row once across accounts', () => {
  const items = dockView().limitProviderUsageItems([codexRecord(), codexRecord()]);
  assert.equal(items.length, 5);
});

test('an unchecked row leaves the card and its partner takes the full width', () => {
  const card = dockView({
    limitProviderHiddenItems: { codex: [usageItems.limitWindowKey({ kind: 'weekly', label: '' }), 'resets'] }
  }).renderProviderWindows(codexRecord(), '#10A37F');

  assert.deepEqual(windowTitles(card), ['Session', 'Monthly', 'Spark']);
  assert.equal(card.find('limit-reset-credits'), null);
  const [session] = [...card.walk()].filter((node) => node.classNames.has('limit-window'));
  assert.equal(session.classNames.has('limit-window-wide'), true, 'a row left alone spans its grid row');
});

test('each Codex additional pool is its own item, and the retired switch still hides them all', () => {
  const pool = (kind, windowMinutes) => ({
    kind, label: 'GPT-5.3-Codex-Spark', limitId: 'codex_spark', windowMinutes, additional: true, remainingPercent: 80
  });
  const record = { provider: 'codex', windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }, pool('session', 300), pool('weekly', 10080)] };
  const titles = (settings) => windowTitles(dockView(settings).renderProviderWindows(record, '#10A37F'));

  assert.deepEqual(titles({}), ['Session', 'GPT-5.3-Codex-Spark · 5-hour', 'GPT-5.3-Codex-Spark · Weekly']);
  assert.deepEqual(
    titles({ limitProviderHiddenItems: { codex: [usageItems.limitWindowKey(pool('weekly', 10080))] } }),
    ['Session', 'GPT-5.3-Codex-Spark · 5-hour']
  );
  assert.deepEqual(titles({ showCodexAdditionalLimits: false }), ['Session']);
});

test('another provider\'s hidden items leave this card alone', () => {
  const card = dockView({ limitProviderHiddenItems: { claude: ['resets'] } })
    .renderProviderWindows(codexRecord(), '#10A37F');
  assert.ok(card.find('limit-reset-credits'));
});

test('Cline\'s credits and month spend are one item, since they are one row', () => {
  const record = {
    provider: 'cline',
    windows: [
      { kind: 'billing', metric: 'credits', label: 'Credits', remaining: 0.5, currency: 'CREDITS', showMeter: false },
      { kind: 'billing', metric: 'spend', label: 'Usage credits', used: 0.13, limit: null, currency: 'USD', showMeter: false }
    ]
  };
  assert.deepEqual(dockView().limitProviderUsageItems([record]), [{ id: 'credits', label: 'Credits' }]);
  const card = dockView({ limitProviderHiddenItems: { cline: ['credits'] } }).renderProviderWindows(record, '#9D4EDD');
  assert.equal([...card.walk()].filter((node) => node.classNames.has('limit-window')).length, 0);
});

test('an Antigravity group whose rows are all unchecked goes with them', () => {
  const record = {
    provider: 'antigravity',
    windows: [
      { kind: 'session', label: 'Gemini Pro 5-hour', remainingPercent: 80 },
      { kind: 'weekly', label: 'Gemini Pro weekly', remainingPercent: 60 },
      { kind: 'session', label: 'Claude 5-hour', remainingPercent: 90 },
      { kind: 'weekly', label: 'Claude weekly', remainingPercent: 70 }
    ]
  };
  const items = dockView().limitProviderUsageItems([record]);
  assert.equal(items.length, 4);
  assert.match(items[0].label, /Gemini Pro/);
  const hidden = items.filter((item) => /Claude/.test(item.label)).map((item) => item.id);
  const card = dockView({ limitProviderHiddenItems: { antigravity: hidden } }).renderProviderWindows(record, '#4285F4');
  const groups = [...card.walk()].filter((node) => node.classNames.has('limit-window-group'));
  assert.equal(groups.length, 1);
  assert.doesNotMatch(card.text, /Claude/);
});

test('a MiMo plan drawn from the balance is the same item as the plan window', () => {
  const planKey = usageItems.limitWindowKey({ kind: 'billing', label: 'Token Plan' });
  const record = {
    provider: 'mimo',
    balance: { amount: 3, currency: 'USD', planUsed: 20, planLimit: 100 },
    windows: []
  };
  const ids = dockView().limitProviderUsageItems([record]).map((item) => item.id);
  assert.ok(ids.includes(planKey), `expected ${planKey} in ${ids.join(', ')}`);
});

// Every provider branch must tag the rows it draws, or a row can be neither
// listed nor hidden. One payload carrying every window shape the card knows —
// and one with the metric-less shapes older hubs send — goes through each
// branch.
const everyShapeRecord = (provider) => ({
  provider,
  windows: [
    { kind: 'session', label: 'Session', remainingPercent: 70 },
    { kind: 'daily', label: 'Daily', remainingPercent: 65 },
    { kind: 'weekly', label: 'Weekly', remainingPercent: 55 },
    { kind: 'billing', label: 'Monthly', remainingPercent: 40 },
    { kind: 'billing', metric: 'credits', label: 'Credits', remaining: 8, limit: 20, currency: 'USD' },
    { kind: 'billing', metric: 'spend', label: 'Usage credits', used: 3, limit: 10, currency: 'USD' },
    { kind: 'session', label: 'Spark', remainingPercent: 90, additional: true }
  ],
  balance: { amount: 12, currency: 'USD', todaySpend: 1, monthSpend: 4, giftBalance: 2, cashBalance: 10 },
  balanceUsd: 12,
  resetCredits: { availableCount: 2, expirations: [new Date(Date.now() + 86_400_000).toISOString()] },
  usageSummary: { period: 'month', totalTokens: 1200, todayTokens: 100, weekTokens: 500, inputTokens: 700, outputTokens: 500, requests: 12, standardCost: 0.01 }
});
const legacyShapeRecord = (provider) => ({
  provider,
  windows: [
    { kind: 'billing', label: 'Credits', remaining: 8, currency: 'USD' },
    { kind: 'billing', label: 'Usage credits', used: 3, limit: 10, currency: 'USD' }
  ],
  balance: { amount: 12, currency: 'USD' }
});
// Shapes that only some branches draw, each from a window the card renames or
// a row it builds with no window at all: Antigravity's grouped pools, a
// label-less credits pool and an unlimited quota with no balance; then an
// expired plan with no window at all.
const sparseShapeRecord = (provider) => ({
  provider,
  windows: [
    { kind: 'session', label: 'Gemini Pro 5-hour', remainingPercent: 60 },
    { kind: 'weekly', label: 'Gemini Pro weekly', remainingPercent: 50 },
    { kind: 'billing', remaining: 5, limit: 10 },
    { kind: 'billing', metric: 'credits', label: 'Quota', showMeter: false, detail: 'unlimited' }
  ]
});
const windowlessRecord = (provider) => ({ provider, windows: [], balance: { currency: 'USD', planStatus: 'expired' } });
const shapeRecords = (provider) => [
  everyShapeRecord(provider), legacyShapeRecord(provider), sparseShapeRecord(provider), windowlessRecord(provider)
];
// A row deliberately off the checklist: Antigravity's `--` Weekly stands in
// for a payload with no weekly window at all.
const offChecklist = { antigravity: ['Weekly'] };
// The whole drawn tree, so a window that only moves a meter still counts as
// drawn. Tooltip anchor names count up on every render, so they are masked.
const cardSnapshot = (node) => (node instanceof FakeElement
  ? JSON.stringify([node.className, node.textContent, node.style, node.attributes, node.children.map(cardSnapshot)])
    .replace(/--limit-detail-anchor-\d+/g, '--limit-detail-anchor')
  : String(node?.textContent ?? ''));
const cardRows = (card) => [...card.walk()].filter((node) => node.classNames.has('limit-window'));
const rowTitle = (row) => row.children[0]?.children[0]?.textContent || row.text;

test('every row any provider draws is a usage item the card can hide', () => {
  const problems = [];
  const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');
  for (const provider of LIMIT_PROVIDER_IDS) {
    for (const record of shapeRecords(provider)) {
      for (const row of cardRows(dockView().renderProviderWindows(record, '#888888'))) {
        if ((offChecklist[provider] || []).includes(rowTitle(row))) continue;
        if (!row.dataset.usageItem) problems.push(`${provider}: row "${rowTitle(row)}" is not a usage item`);
      }
      const hidden = { [provider]: dockView().limitProviderUsageItems([record]).map((item) => item.id) };
      const left = cardRows(dockView({ limitProviderHiddenItems: hidden }).renderProviderWindows(record, '#888888'))
        .filter((row) => row.dataset.usageItem);
      for (const row of left) problems.push(`${provider}: unchecked row "${rowTitle(row)}" is still drawn`);
    }
  }
  assert.deepEqual(problems, []);
});

// Home and the dock picker filter raw windows rather than card rows, so every
// window the card draws from has to land on an item the card lists — or a row
// gone from the card would stay on Home.
test('with every item unchecked, Home and the picker keep no window the card drew from', () => {
  const problems = [];
  const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');
  const view = dockView();
  for (const provider of LIMIT_PROVIDER_IDS) {
    for (const record of shapeRecords(provider)) {
      const full = cardSnapshot(view.renderProviderWindows(record, '#888888'));
      const hidden = { [provider]: view.limitProviderUsageItems([record]).map((item) => item.id) };
      for (const [index, window] of record.windows.entries()) {
        if (usageItems.isLimitWindowHidden(hidden, provider, window)) continue;
        const without = { ...record, windows: record.windows.filter((_, other) => other !== index) };
        if (cardSnapshot(view.renderProviderWindows(without, '#888888')) !== full) {
          problems.push(`${provider}: the card draws "${window.label}" but Home would keep it`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});
