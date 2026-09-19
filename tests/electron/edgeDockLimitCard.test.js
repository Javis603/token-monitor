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

const balanceDisplay = require('../../src/shared/limitBalanceDisplay');
const currencyApi = require('../../src/shared/currency');
const subscriptionApi = require('../../src/shared/subscriptionDisplay');
const subscriptionText = require('../../src/shared/subscriptionText');
const limitDisplayMode = require('../../src/electron/renderer/limitDisplayMode');
const limitPresentationApi = require('../../src/electron/renderer/limitProviderPresentation');
const limitResetMotionApi = require('../../src/electron/renderer/limitResetMotion');
const limitWindowLabels = require('../../src/shared/limitWindowLabels');
const limitWindowTextApi = require('../../src/shared/limitWindowText');
const accountIdentityApi = require('../../src/electron/renderer/accountIdentity');
const i18n = require('../../src/electron/renderer/i18n');
const { createLimitWindowsView } = require('../../src/electron/renderer/limitWindowsView');

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
      toggle: (name, enabled) => {
        if (enabled) this.classNames.add(name);
        else this.classNames.delete(name);
      }
    };
  }

  get className() { return [...this.classNames].join(' '); }
  set className(value) { this.classNames = new Set(String(value).split(' ').filter(Boolean)); }
  append(...children) { this.children.push(...children.filter(Boolean)); }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = value; }
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
// checked is that THAT list is complete.
function dockView(appearance = {}) {
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
    formatMoney: balanceDisplay.formatMoney,
    formatCompactMoney: balanceDisplay.formatCompactMoney,
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
    resetForecast: () => ({ busy: false, forecast: appearance.forecast || null })
  });
}

test('the dock hands the shared view every dependency it destructures', () => {
  const view = fs.readFileSync(path.join(root, 'src/electron/renderer/limitWindowsView.js'), 'utf8');
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

// The dependency list above is only half the wiring: the view also reads
// preferences off its settings accessor, and the dock's accessor is the
// appearance projection the main process pushes. A preference the projection
// forgets is not a TypeError — `settings()?.x` reads as undefined and the card
// quietly renders the other answer — so it has to be checked by name. Both
// omissions this guards against (`showLimitSource`, `codexResetForecastEnabled`)
// shipped as exactly that: a card that stayed silent where the page spoke.
test('every preference the shared view reads reaches the dock through the appearance projection', () => {
  const view = fs.readFileSync(path.join(root, 'src/electron/renderer/limitWindowsView.js'), 'utf8');
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

// The mark rule reads like a rule about the provider and is a rule about the
// row's company: a group already names the provider in its header, so its
// account rows drop the mark, while a solo row IS the provider and has nothing
// else to be recognised by. Applied without that second half, every solo Claude,
// MiMo, Cursor, OpenCode and Volcengine row lost its mark on both surfaces at
// once — the card and the page agreed with each other and with nothing the user
// had seen before.
test('a provider that drops its mark inside a group keeps it standing alone', () => {
  const account = (key, extra = {}) => ({
    provider: 'claude',
    status: 'ok',
    accountKey: key,
    updatedAt: new Date().toISOString(),
    windows: [{ kind: 'session', label: 'Session', remainingPercent: 70 }],
    ...extra
  });
  const view = dockView();

  const solo = view.renderLimitProviderSolo('claude', 'Claude', account('k1'), '#D97757');
  assert.ok(solo.find('limit-icon'), 'a solo row wears the provider mark');

  const group = view.renderLimitProviderGroup('claude', 'Claude', [account('k1'), account('k2')], '#D97757');
  assert.ok(group.find('limit-icon'), 'the group header wears it instead');
  const list = group.find('limit-account-list');
  assert.equal(list.children.length, 2);
  for (const row of list.children) {
    assert.equal(row.find('limit-icon'), null, 'an account row is named by its own title');
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
