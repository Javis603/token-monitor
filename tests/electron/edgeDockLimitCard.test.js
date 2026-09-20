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
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');

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
    resetForecast: () => ({ busy: false, forecast: appearance.forecast || null }),
    ...overrides
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
    rowFor({ provenance: (provider) => limitPresentationApi.limitProviderProvenance(provider, context) })
      .find('limit-meta').text,
    /Updated 2m ago · CLI · imac-m1/
  );
  // A host with no device list gets the source and no name, rather than a name
  // nobody resolved.
  assert.match(rowFor({}).find('limit-meta').text, /Updated 2m ago · CLI$/);
});

test('the page hands the shared view the device context its rows read', () => {
  const app = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
  const wiring = app.slice(
    app.indexOf('const limitWindowsView = window.TokenMonitorLimitWindowsView.createLimitWindowsView({'),
    app.indexOf('function optionalFiniteNumber(value) {', app.indexOf('const limitWindowsView = window'))
  );
  assert.match(wiring, /(^|[\s{,])provenance\s*[,:]/, 'the page must hand the view its device context');
  // And it is the resolver carrying the context, not a second context-free
  // module call that reads as wired while naming nothing.
  const wrapper = app.slice(
    app.indexOf('function limitProviderProvenance(provider) {'),
    app.indexOf('// ---------------------------------------------------------------------------\n// Subscriptions')
  );
  assert.match(wrapper, /localDeviceId: state\.settings\?\.deviceId/);
  assert.match(wrapper, /syncActive: syncProvenanceActive\(\)/);
  assert.match(wrapper, /devices: state\.stats\?\.devices/);
  assert.match(wiring, /provenance: \(provider\) => limitProviderProvenance\(provider\)/);
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
