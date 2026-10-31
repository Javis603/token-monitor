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
const vm = require('node:vm');

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
const { aggregateLimits, normalizeLimitProvider } = require('../../src/shared/limits/core');
const { fetchWorkbuddyLimits, workbuddyAccountKey } = require('../../src/shared/providers/workbuddy/limits');
const { fetchMinimaxLimits } = require('../../src/shared/providers/minimax/limits');
const { fetchAntigravityLimits } = require('../../src/shared/providers/antigravity/limits');

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
  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    if (index < 0) throw new Error('Reference is not a child');
    child.parent = this;
    this.children.splice(index, 0, child);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  addEventListener(name, handler) { (this.listeners ||= {})[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  replaceChildren(...children) { this.children = [...children]; }
  querySelector(selector) {
    if (selector === '.limit-window-text > span') return this.find('limit-window-text')?.children[0] || null;
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const names = selector.split(',').map((part) => part.trim().replace('.', ''));
    return [...this.walk()].slice(1).filter((node) => names.some((name) => node.classNames.has(name)));
  }
  replaceWith(node) {
    const index = this.parent.children.indexOf(this);
    this.parent.children.splice(index, 1, node);
    node.parent = this.parent;
    this.parent = null;
  }

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
    creditsCurrency: balanceDisplay.creditsCurrency,
    creditsMeterPercent: balanceDisplay.creditsMeterPercent,
    isCreditsWindow: balanceDisplay.isCreditsWindow,
    spendWindow: balanceDisplay.spendWindow,
    limitWindowLabel: limitWindowLabels.limitWindowLabel,
    mimoProductLabel: limitWindowLabels.mimoProductLabel,
    mimoAccountGroups: limitWindowLabels.mimoAccountGroups,
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

function limitsSubscriptionPool(localProviders, aggregateProviders) {
  const app = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
  const state = { mode: 'sync', settings: { deviceId: 'local' }, stats: {
    devices: [{ deviceId: 'local', limits: { providers: localProviders } }],
    limits: { providers: aggregateProviders }
  } };
  const context = vm.createContext({ state, accountIdentityApi });
  for (const name of ['localDeviceLimitsProviders', 'limitProvidersForSubscriptions']) {
    vm.runInContext(balancedCall(app, `function ${name}() {`), context);
  }
  return vm.runInContext('limitProvidersForSubscriptions()', context);
}

for (const realm of ['cn', 'ai']) for (const reason of ['', 'encrypted']) {
  test(`WorkBuddy ${realm} totals ignore ${reason || 'unsigned'} local placeholders without removing local hints`, async () => {
    const now = Date.parse('2026-10-12T00:10:00Z');
    const at = new Date(now).toISOString();
    const healthy = ['remote-a', 'remote-b'].map((user) => normalizeLimitProvider({
      provider: 'workbuddy', accountKey: workbuddyAccountKey('', user, '', '', realm),
      status: 'ok', region: realm, updatedAt: at,
      windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', used: 20, remaining: 80, limit: 100 }]
    }));
    for (const localRealm of ['cn', 'ai']) {
      const placeholder = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true,
        workbuddyRealm: localRealm, workbuddyLocalSessionReason: reason }, { env: {}, now: () => now });
      const summary = aggregateLimits([
        { deviceId: 'remote', limits: { updatedAt: at, providers: healthy } },
        { deviceId: 'local', limits: { updatedAt: at, providers: [placeholder] } }
      ], 0, now);
      assert.equal(summary.providers.length, 2);
      const pool = limitsSubscriptionPool([placeholder], summary.providers);
      assert.equal(pool.length, 3, 'the global pool still includes local discovery');
      const view = dockView({ workbuddyQuotaTotalEnabled: true }, { subscriptionAccounts: () => pool });
      assert.equal(view.workbuddyCombinedProvider(summary.providers).windows[0].remaining, 160);
      const group = view.renderLimitProviderGroup('workbuddy', 'WorkBuddy', summary.providers, '#12B7F5');
      assert.equal(group.children[1].className, 'limit-windows', localRealm);
      assert.match(group.children[1].text, /160/);
      assert.equal(group.find('limit-account-list').children.length, 2);
      assert.equal(pool.length, 3, 'rendering does not mutate the observed pool');
      const off = dockView({ workbuddyQuotaTotalEnabled: false }, { subscriptionAccounts: () => pool })
        .renderLimitProviderGroup('workbuddy', 'WorkBuddy', summary.providers, '#12B7F5');
      assert.equal(off.children[1].className, 'limit-account-list');
      const hint = view.renderLimitProviderSolo('workbuddy', 'WorkBuddy', placeholder, '#12B7F5');
      assert.ok(hint.text.includes(reason ? 'Encrypted by app' : 'Not signed in'), hint.text);
    }
  });
}

test('WorkBuddy total completeness retains real failed, incomplete and hidden accounts beside a placeholder', async () => {
  const healthy = ['a', 'b'].map((accountKey) => normalizeLimitProvider({
    provider: 'workbuddy', accountKey, status: 'ok', region: 'cn',
    windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', used: 20, remaining: 80, limit: 100 }]
  }));
  const placeholder = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true }, { env: {} });
  const failed = (extra = {}) => normalizeLimitProvider({
    provider: 'workbuddy', accountKey: 'c', status: 'notConfigured', region: 'cn', windows: [], ...extra
  });
  const siblings = [
    ['missing credentials', failed()],
    ['unauthorized', failed({ status: 'unauthorized' })],
    ['unavailable', failed({ status: 'unavailable' })],
    ['known encrypted identity', failed({ actionRequired: 'appSessionEncrypted' })],
    ['missing key', failed({ accountKey: '' })],
    ['missing quota', failed({ status: 'ok' })],
    ['stale', { ...healthy[0], accountKey: 'c', stale: true }],
    ['unlimited', { ...healthy[0], accountKey: 'c', windows: [
      { kind: 'billing', metric: 'credits', currency: 'CREDITS', detail: 'unlimited', used: 20 }
    ] }],
    ['healthy hidden', { ...healthy[0], accountKey: 'c' }]
  ];
  for (const [name, sibling] of siblings) {
    assert.equal(limitPresentationApi.isWorkbuddyPlaceholder(sibling), false, name);
    const pool = limitsSubscriptionPool([placeholder, sibling], healthy);
    assert.equal(pool.length, 4, name);
    const view = dockView({ workbuddyQuotaTotalEnabled: true }, { subscriptionAccounts: () => pool });
    const hidden = view.renderLimitProviderGroup('workbuddy', 'WorkBuddy', healthy, '#12B7F5');
    assert.equal(hidden.children[1].className, 'limit-account-list', name);
    if (name !== 'healthy hidden') {
      const drawn = view.renderLimitProviderGroup('workbuddy', 'WorkBuddy', [...healthy, sibling], '#12B7F5');
      assert.equal(drawn.children[1].className, 'limit-account-list', `${name} drawn`);
    }
    assert.equal(pool.length, 4, 'real identities and local hints remain in the global pool');
  }
});

test('Limits group counts only genuine accounts when both credentials are unavailable', async () => {
  const now = Date.parse('2026-10-12T00:10:00Z');
  const at = new Date(now).toISOString();
  const known = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true, workbuddyLocalSessions: [
    { realm: 'cn', userId: 'encrypted-user', reason: 'encrypted' },
    { realm: 'cn', userId: 'missing-user', reason: 'incomplete' }
  ] }, { env: {}, now: () => now });
  const placeholder = await fetchWorkbuddyLimits({ workbuddyDesktopSessionEnabled: true }, { env: {}, now: () => now });
  const summary = aggregateLimits([
    { deviceId: 'known', limits: { updatedAt: at, providers: known } },
    { deviceId: 'unsigned', limits: { updatedAt: at, providers: [placeholder] } }
  ], 0, now);
  const view = dockView({ workbuddyQuotaTotalEnabled: true });
  const group = view.renderLimitProviderGroup('workbuddy', 'WorkBuddy', summary.providers, '#12B7F5');
  assert.ok(group.text.includes('2 accounts'), group.text);
  assert.equal(group.find('limit-account-list').children.length, 2);
  assert.equal(group.text.includes('Account 3'), false);
  assert.ok(group.text.includes('Encrypted by app'), group.text);
  assert.ok(group.text.includes('Not signed in'), group.text);
  assert.equal(view.workbuddyCombinedProvider(summary.providers), null);
  const alone = aggregateLimits([{ deviceId: 'unsigned', limits: { updatedAt: at, providers: [placeholder] } }], 0, now);
  const signIn = view.renderLimitProviderSolo('workbuddy', 'WorkBuddy', alone.providers[0], '#12B7F5');
  assert.ok(signIn.text.includes('Not signed in'), signIn.text);
});

test('WorkBuddy group draws a healthy total plus independent accounts and omits partial totals', () => {
  const rows = ['one', 'two'].map((accountKey) => normalizeLimitProvider({
    provider: 'workbuddy', accountKey, accountName: 'Same nickname', region: 'cn', status: 'ok',
    windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', used: 20, limit: 100, remaining: 80 }]
  }));
  const healthy = dockView({ workbuddyQuotaTotalEnabled: true }).renderLimitProviderGroup('workbuddy', 'WorkBuddy', rows, '#12B7F5');
  assert.equal(healthy.children[1].className, 'limit-windows');
  assert.equal(healthy.find('limit-account-list').children.length, 2);
  for (const appearance of [{}, { workbuddyQuotaTotalEnabled: false }]) {
    const off = dockView(appearance).renderLimitProviderGroup('workbuddy', 'WorkBuddy', rows, '#12B7F5');
    assert.equal(off.children[1].className, 'limit-account-list');
    assert.equal(off.children[1].children.length, 2);
  }
  const partial = dockView({ workbuddyQuotaTotalEnabled: true }).renderLimitProviderGroup('workbuddy', 'WorkBuddy',
    [rows[0], { ...rows[1], status: 'unavailable' }], '#12B7F5');
  assert.equal(partial.children[1].className, 'limit-account-list');
  assert.equal(partial.children[1].children.length, 2);
});

test('Dock projection cannot total only visible WorkBuddy accounts while a known sibling is omitted', () => {
  const wb = (accountKey, extra = {}) => normalizeLimitProvider({ provider: 'workbuddy', accountKey, region: 'cn', status: 'ok',
    windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', used: 20, remaining: 80, limit: 100 }], ...extra });
  for (const scenario of ['nonreporting', 'hidden', 'unlimited-hidden', 'healthy-hidden']) {
    const c = scenario === 'nonreporting' ? wb('c', { status: 'unauthorized', windows: [] })
      : scenario === 'unlimited-hidden' ? wb('c', { windows: [{ kind: 'billing', metric: 'credits', detail: 'unlimited', used: 20 }] })
        : wb('c', { status: scenario === 'hidden' ? 'unavailable' : 'ok' });
    const [cell] = buildEdgeDockCells({ limits: { providers: [wb('a'), wb('b'), c] } }, {
      items: [{ type: 'limit', provider: 'workbuddy', hiddenAccounts: scenario === 'nonreporting' ? [] : ['c'] }]
    });
    const drawn = cell.accounts.map((account) => account.record);
    assert.equal(drawn.length, 2, scenario);
    const card = dockView({ workbuddyQuotaTotalEnabled: true }, { subscriptionAccounts: () => cell.subscriptionAccounts })
      .renderLimitProviderGroup('workbuddy', 'WorkBuddy', drawn, '#12B7F5');
    assert.equal(card.children[1].className, 'limit-account-list', scenario);
  }
});

test('saved-only WorkBuddy subscription card does not appear on the sole live sibling', () => {
  const live = normalizeLimitProvider({ provider: 'workbuddy', accountKey: 'a', status: 'ok',
    windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', used: 20, remaining: 80, limit: 100 }] });
  const saved = { id: 'saved-c', provider: 'workbuddy', kind: 'subscription', binding: { accountKey: 'c', profileName: 'Saved C' },
    planName: 'C plan', amountMinor: 9900, currency: 'USD', interval: 'month', intervalCount: 1, startDate: '2026-01-01', autoRenew: true };
  const [cell] = buildEdgeDockCells({ limits: { providers: [live] } }, { items: [{ type: 'limit', provider: 'workbuddy' }] });
  const card = dockView({ subscriptions: [saved] }, { subscriptionAccounts: () => cell.subscriptionAccounts })
    .renderLimitProviderSolo('workbuddy', 'WorkBuddy', live, '#12B7F5');
  assert.equal(card.find('subscription-tooltip'), null);
});

test('Notion rolling and monthly allowances render in both display modes and hide independently', () => {
  const provider = normalizeLimitProvider({
    provider: 'notion', status: 'ok', source: 'web',
    windows: [
      { kind: 'session', label: 'Rolling', used: 21, limit: 50, usedPercent: 42, resetsAt: '2026-11-01T00:00:00Z' },
      { kind: 'billing', label: 'Monthly', used: 18, limit: 100, usedPercent: 18, resetsAt: '2026-12-01T00:00:00Z' }
    ]
  });
  const before = JSON.stringify(provider);
  for (const showLimitUsed of [false, true]) {
    const view = dockView({ showLimitUsed });
    const card = view.renderProviderWindows(provider, '#888888');
    assert.equal(card.children.length, 2);
    assert.deepEqual(card.children.map((row) => row.children[0].children[0].textContent), ['Rolling', 'Monthly']);
    assert.match(card.text, showLimitUsed ? /42% used/ : /58% left/);
    assert.match(card.text, showLimitUsed ? /18% used/ : /82% left/);
    assert.equal(card.text.includes('$'), false, 'included allowance units are not spendable money');
    assert.ok(card.children.every((row) => row.find('limit-reset').text));
    const items = view.limitProviderUsageItems([provider]);
    assert.equal(items.length, 2);
    for (const item of items) {
      const hidden = dockView({ showLimitUsed, limitProviderHiddenItems: { notion: [item.id] } });
      assert.equal(hidden.renderProviderWindows(provider, '#888888').children.length, 1);
      assert.deepEqual(hidden.limitProviderUsageItems([provider]), items);
    }
  }
  const monthlyOnly = { ...provider, windows: [provider.windows[1]] };
  assert.ok(dockView().renderProviderWindows(monthlyOnly, '#888888').children[0].classNames.has('limit-window-wide'));
  assert.equal(JSON.stringify(provider), before);
});

test('MiniMax API balances reach the shared Limits and dock renderer in both currencies', async () => {
  for (const [region, currency, symbol] of [['cn', 'CNY', '¥'], ['intl', 'USD', '$']]) {
    for (const amount of [98.25, 0, -1.5]) {
      const provider = await fetchMinimaxLimits({ minimaxApiKey: 'sk-api-fixture', minimaxBillingMode: 'api', minimaxApiRegion: region }, {
        env: {}, fetchJson: async () => ({ available_amount: String(amount), base_resp: { status_code: 0 } })
      });
      assert.equal(provider.status, 'ok');
      assert.equal(provider.windows[0].currency, currency);
      assert.equal(provider.balance, null, 'the collector only supplies a credits window');
      const before = JSON.stringify(provider);
      for (const showLimitUsed of [false, true]) {
        const card = dockView({ showLimitUsed }).renderProviderWindows(provider, '#888888');
        assert.equal(card.children.length, 1);
        const row = card.children[0];
        assert.equal(row.children[0].children[0].textContent, 'Balance');
        assert.equal(row.children[0].children[1].textContent, `${symbol}${amount.toFixed(2)}`);
        assert.equal(row.dataset.usageItem, 'credits');
        assert.ok(row.classNames.has('limit-window-wide'));
        assert.ok(row.classNames.has('limit-window-no-reset'));
        assert.equal(row.find('limit-meter-fill').style['--bar-scale'], amount > 0 ? '1' : '0');
        assert.equal(row.find('limit-reset').text, '');
      }
      assert.equal(JSON.stringify(provider), before, 'display percentages never mutate the wire reading');
    }
  }
});

test('MiniMax Balance is listed and can be hidden without disappearing from its checklist', () => {
  const provider = normalizeLimitProvider({
    provider: 'minimax', status: 'ok',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 0, currency: 'CNY' }]
  });
  const view = dockView({ limitProviderHiddenItems: { minimax: ['credits'] } });
  assert.deepEqual(view.limitProviderUsageItems([provider]), [{ id: 'credits', label: 'Balance' }]);
  assert.equal(view.renderProviderWindows(provider, '#888888').children.length, 0);
  assert.equal(view.renderProviderWindows(provider, '#888888', { showAllUsageItems: true }).children.length, 1);
  assert.equal(dockView().renderProviderWindows(provider, '#888888').children.length, 1);
});

test('MiniMax Token Plan retains its quota pair and missing API balances do not invent a row', async () => {
  const plan = await fetchMinimaxLimits({ minimaxApiKey: 'sk-cp-fixture', minimaxApiRegion: 'cn' }, {
    env: {}, fetchJson: async () => ({ data: { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 75, current_weekly_remaining_percent: 50 }] } })
  });
  const card = dockView().renderProviderWindows(plan, '#888888');
  assert.equal(plan.status, 'ok');
  assert.deepEqual(card.children.map((row) => row.children[0].children[0].textContent), ['5h', 'Weekly']);
  assert.equal(card.text.includes('Balance'), false);
  for (const available_amount of [undefined, 'invalid']) {
    const provider = await fetchMinimaxLimits({ minimaxApiKey: 'sk-api-fixture', minimaxBillingMode: 'api', minimaxApiRegion: 'cn' }, {
      env: {}, fetchJson: async () => ({ available_amount, base_resp: { status_code: 0 } })
    });
    assert.equal(provider.status, 'unavailable');
    assert.equal(dockView().renderProviderWindows(provider, '#888888').children.length, 0);
  }
});

test('default provider balance rendering follows the credits marker without a provider whitelist', () => {
  const provider = { provider: 'future-provider', windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 5, currency: 'USD' }] };
  assert.match(dockView().renderProviderWindows(provider, '#888888').text, /\$5\.00/);
});

test('Home text and bars use the plan text rendered by Limits account rows', () => {
  const window = { kind: 'weekly', remainingPercent: 40 };
  const fixtures = [
    [{ provider: 'codex', status: 'ok', planLabel: 'Plus' }],
    [{ provider: 'zed', status: 'ok', planLabel: 'Zed Student' }],
    [{ provider: 'future-provider', status: 'ok', planLabel: 'Pro' }],
    [{ provider: 'mimo', status: 'ok', accountLabel: 'Desktop Membership', planLabel: '' }],
    [{ provider: 'cursor', status: 'ok', accountEmail: 'alice@example.com', accountLabel: 'alice@example.com', planLabel: '' }],
    [{ provider: 'openrouter', status: 'ok', accountName: 'Work', accountLabel: 'Work', planLabel: '' }],
    ['Work', 'Personal'].map((accountName) => ({ provider: 'openrouter', status: 'ok', accountName, accountLabel: accountName, planLabel: '' })),
    ['Zen', ''].map((planLabel, index) => ({ provider: 'opencode', status: 'ok', accountLabel: `Profile ${index}`, planLabel })),
    ['Coding Plan', 'Agent Plan Pro'].map((accountLabel) => ({ provider: 'volcengine', status: 'ok', accountLabel })),
    ['newapi-account', 'sub2api'].map((adapterId) => ({ provider: 'thirdparty', status: 'ok', adapterId, planLabel: 'Account' })),
    [false, true].map((stale) => ({ provider: 'opencode', status: 'unauthorized', stale, accountLabel: 'Work profile', planLabel: 'Zen' }))
  ];
  const app = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function homeLimitRows()');
  const end = app.indexOf('function homeLimitWindowLabel(', start);
  const renderStart = app.indexOf('function renderHomeLimitModule()');
  const renderEnd = app.indexOf('function renderHomeModelModule(', renderStart);
  for (const homeLimitDisplayMode of ['text', 'bars']) {
    for (const maskLimitAccountEmails of [true, false]) {
      const settings = { homeLimitDisplayMode, maskLimitAccountEmails, homeLimitAccountCount: 20 };
      const view = dockView(settings);
      for (const fixture of fixtures) {
        const providers = fixture.map((provider, index) => ({ ...provider, accountKey: `account-${index}`, windows: [window] }));
        const id = providers[0].provider;
        settings.homeLimitProviderOrder = [id];
        const limits = providers.length > 1
          ? view.renderLimitProviderGroup(id, id, providers, '#000000')
          : view.renderLimitProviderSolo(id, id, providers[0], '#000000');
        const limitsPlans = [...limits.walk()]
          .filter((node) => node.classNames.has('limit-row') && node.children[1]?.classNames?.has('limit-windows'))
          .map((row) => row.children[0].find('limit-plan').textContent);
        const home = vm.runInNewContext(`${app.slice(start, end)}; homeLimitRows();`, {
          state: { stats: { limits: { providers } }, settings },
          enabledLimitProviderSet: () => new Set([id]),
          hiddenHomeLimitProviderSet: () => new Set(),
          LIMIT_PROVIDERS: [{ id, label: id }],
          limitProviderOrderApi: require('../../src/electron/renderer/limits/providerOrder'),
          limitUsageItemsApi: require('../../src/shared/limits/usageItems'),
          homeOverviewApi: require('../../src/electron/renderer/homeOverview'),
          limitProviderPresentationApi: limitPresentationApi,
          limitWindowsView: view,
          limitAccountTitle: view.limitAccountTitle,
          ...limitWindowLabels,
          clientColors: {}
        });
        assert.deepEqual(Array.from(home, (row) => row.plan), limitsPlans, `${id}: ${homeLimitDisplayMode}, mask=${maskLimitAccountEmails}`);
        const body = new FakeElement('div');
        vm.runInNewContext(`${app.slice(renderStart, renderEnd)}; renderHomeLimitModule();`, {
          document: { createElement: (tag) => new FakeElement(tag) },
          state: { settings },
          homeModuleShell: () => ({ module: new FakeElement('div'), body }),
          homeLimitRows: () => home,
          applyHomeListMark() {},
          iconKindFor: () => id,
          homeLimitWindowLabel: () => 'Weekly',
          formatHomeLimitWindowValue: () => '40% left',
          isCreditsWindow: balanceDisplay.isCreditsWindow,
          limitFillPercent: limitDisplayMode.limitFillPercent,
          optionalFiniteNumber: Number,
          limitWindowsView: view,
          t: (key) => key,
          limitProviderPresentationApi: limitPresentationApi
        });
        assert.deepEqual(body.children.map((row) => row.find('home-limit-plan')?.textContent || ''), limitsPlans);
        for (const row of body.children) {
          const plan = row.find('home-limit-plan');
          if (plan) assert.equal(plan.attributes['aria-label'], plan.textContent);
          assert.equal(Boolean(row.find('limit-meter')), homeLimitDisplayMode === 'bars');
        }
      }
    }
  }
});

for (const [host, file] of [
  ['dock', 'edgeDock/dock.js'],
  ['page', 'app.js']
]) {
  test(`the ${host} hands the shared view every dependency it destructures`, () => {
    const view = fs.readFileSync(path.join(root, 'src/electron/renderer/limits/windowsView.js'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'src/electron/renderer', file), 'utf8');
    const required = view
      .slice(view.indexOf('const {'), view.indexOf('} = deps;'))
      .replace('const {', '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      // A dependency with a default is one the host may legitimately omit.
      .filter((line) => line && !line.includes('='))
      .map((entry) => entry.split(':')[0].replace(',', '').trim())
      .filter(Boolean);
    const wiring = balancedCall(source, 'createLimitWindowsView({');

    assert.ok(required.length > 10, 'the dependency list should have been parsed');
    for (const name of required) {
      assert.match(wiring, new RegExp(`(^|[\\s{,])${name}\\s*[,:]`, 'm'), `the ${host} must supply ${name}`);
    }
    // `document` is read off deps separately rather than destructured with the rest.
    if (host === 'dock') assert.match(wiring, /^\s*document,$/m);
  });
}

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
    balance: { amount: 4.2, currency: 'USD', todaySpend: 0.12, weekSpend: 0.5, monthSpend: 1.4 }
  }, '#4D6BFE');

  assert.ok(card.find('limit-spend'), 'the card should carry the spend row');
  assert.match(card.text, /Today/);
  assert.match(card.text, /Month/);
  assert.match(card.text, /\$4\.20/);
  assert.match(card.find('limit-detail-tooltip-trigger').getAttribute('aria-label'), /Month: \$1\.40/);
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

test('an Ollama new-plan card draws the monthly included credits', () => {
  const row = normalizeLimitProvider({
    provider: 'ollama',
    accountKey: 'sha256:ollama-credits-row',
    status: 'ok',
    source: 'api',
    updatedAt: '2026-10-23T12:00:00Z',
    windows: [{
      kind: 'billing',
      metric: 'credits',
      label: 'Included credits',
      used: 15,
      limit: 60,
      remaining: 45,
      currency: 'USD',
      usedPercent: 25,
      remainingPercent: 75,
      resetsAt: '2026-11-08T08:00:00Z',
      showMeter: true
    }]
  });
  const node = dockView().renderLimitProviderSolo('ollama', 'Ollama', row, '#888888');
  assert.match(node.text, /\$45\.00/);
  assert.match(node.text, /Included credits/);
});

test('Ollama Cookie monthly and wallet cards render real measurements with no wallet meter', async () => {
  const { fetchOllamaLimits } = require('../../src/shared/providers/ollama/limits');
  const { monthly, free, wallet } = require('../fixtures/ollamaCookieUsage.cjs');
  for (const [html, meters, amounts] of [
    [monthly, 1, ['$52.50']],
    [free, 1, ['31% left']],
    [wallet, 0, ['$18.25', '$4.50', 'Refills to $30 in 3 weeks.']],
    [monthly + wallet, 1, ['$52.50', '$18.25', '$4.50']]
  ]) {
    const row = await fetchOllamaLimits({ ollamaCookie: 'wos-session=fixture-card' }, {
      env: {}, bypassValidationCache: true,
      fetch: async () => ({ ok: true, status: 200, text: async () => html })
    });
    assert.equal(row.status, 'ok');
    const card = dockView().renderProviderWindows(row, '#888888');
    assert.equal(card.textOf('limit-meter').length, meters);
    for (const amount of amounts) assert.ok(card.text.includes(amount), card.text);
  }
});

test('an Ollama API card keeps purchased balance separate from included monthly credits', async () => {
  const { fetchOllamaLimits } = require('../../src/shared/providers/ollama/limits');
  const row = await fetchOllamaLimits({ ollamaApiKey: 'fixture-purchased-card' }, {
    env: {}, probe: true,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({
      included: { balance_usd: 52.5, allowance_usd: 60 }, purchased: { balance_usd: 18.25 }
    }) })
  });
  const card = dockView().renderProviderWindows(row, '#888888');
  assert.equal(card.textOf('limit-meter').length, 1);
  for (const amount of ['$52.50', '$18.25', '$7.50']) assert.ok(card.text.includes(amount), card.text);
  assert.equal(card.text.includes('$70.75'), false, 'wallet and allowance must not be added');
  assert.deepEqual([...card.walk()].filter((node) => node.classNames.has('limit-window-text')).map((node) => node.children[0].textContent), ['Included credits', 'Credit balance']);
  assert.match(card.find('limit-spend-summary').textContent, /\$18\.25/);
  const tooltip = card.find('limit-detail-tooltip');
  assert.equal(tooltip.text, 'Monthly credits used $7.50');
  const trigger = card.find('limit-detail-tooltip-trigger');
  assert.equal(trigger.tabIndex, 0);
  assert.match(trigger.getAttribute('aria-label'), /Monthly credits used: \$7\.50/);
  const wrap = card.find('limit-spend-info-wrap');
  wrap.isConnected = true;
  wrap.getBoundingClientRect = () => ({ top: 200 });
  tooltip.childElementCount = tooltip.children.length;
  tooltip.offsetHeight = 40;
  tooltip.showPopover = () => { tooltip.opened = true; };
  tooltip.hidePopover = () => { tooltip.opened = false; };
  wrap.listeners.focusin();
  assert.equal(tooltip.opened, true);
  wrap.listeners.keydown({ key: 'Escape' });
  assert.equal(tooltip.opened, false);
  wrap.listeners.pointerenter();
  assert.equal(tooltip.opened, true);
  wrap.listeners.pointerleave();
  assert.equal(tooltip.opened, false);
});

test('Ollama hides spending details when that usage item is disabled and keeps spend-only readings', () => {
  const { parseOllamaBalance } = require('../../src/shared/providers/ollama/limits');
  const parsed = parseOllamaBalance({ included: { balance_usd: 52.5, allowance_usd: 60 }, purchased: { balance_usd: 0 } });
  const row = normalizeLimitProvider({ provider: 'ollama', status: 'ok', windows: parsed.windows });
  const hidden = dockView({ limitProviderHiddenItems: { ollama: ['spend'] } }).renderProviderWindows(row, '#888888');
  assert.match(hidden.text, /Credit balance \$0\.00/);
  assert.equal(hidden.find('limit-detail-tooltip'), null);
  assert.ok(dockView().limitProviderUsageItems([row]).some((item) => item.id === 'spend'));
  const hiddenBalance = dockView({ limitProviderHiddenItems: { ollama: ['credits'] } }).renderProviderWindows(row, '#888888');
  assert.doesNotMatch(hiddenBalance.text, /Credit balance/);
  assert.match(hiddenBalance.text, /Monthly credits used \$7\.50/);
  const spendOnly = dockView().renderProviderWindows({ provider: 'ollama', windows: parsed.windows.filter((w) => w.metric === 'spend') }, '#888888');
  assert.match(spendOnly.text, /Monthly credits used \$7\.50/);
  assert.doesNotMatch(spendOnly.text, /Credit balance/);
});

function renderHomeLimitFixture(rows) {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
  const functions = ['homeModuleShell', 'homeLimitWindowLabel', 'formatHomeLimitWindowValue', 'renderHomeLimitModule'].map((name) => {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf('\n}\n', start) + 2);
  }).join('\n');
  const context = {
    document: { createElement: (tag) => new FakeElement(tag) }, homeLimitRows: () => rows,
    els: { homePanel: { children: [] } }, pluginContent: null,
    state: { settings: { homeLimitDisplayMode: 'bars' } }, VIEW_ICON_CLASSES: {}, renderBreakdownChange() {},
    t: (key) => i18n.translate('en', key), applyHomeListMark() {}, iconKindFor: () => '',
    limitWindowsView: dockView(), limitProviderPresentationApi: limitPresentationApi,
    isCreditsWindow: balanceDisplay.isCreditsWindow, formatCompactMoney: balanceDisplay.formatCompactMoney,
    currentLocale: () => 'en', formatPercent: (n) => `${n}%`,
    limitModeSuffix: limitDisplayMode.limitModeSuffix, limitFillPercent: limitDisplayMode.limitFillPercent,
    formatLimitBoundary: () => '', optionalFiniteNumber: (n) => n == null ? null : Number(n)
  };
  vm.runInNewContext(`${functions}\nthis.result = renderHomeLimitModule();`, context);
  return context.result;
}

test('Home renders Ollama included quota before balance on separate full-width rows with the shared tooltip', () => {
  const { parseOllamaBalance } = require('../../src/shared/providers/ollama/limits');
  const { homeLimitAccounts } = require('../../src/electron/renderer/homeOverview');
  const parsed = parseOllamaBalance({ included: { balance_usd: 52.5, allowance_usd: 60 }, purchased: { balance_usd: 18.25 } });
  const rows = homeLimitAccounts([{ providerId: 'ollama', name: 'Ollama', windows: parsed.windows }]);
  const result = renderHomeLimitFixture(rows);
  const readings = [...result.walk()].filter((node) => node.classNames.has('home-limit-window'));
  assert.equal(readings.length, 2);
  assert.ok(readings.every((node) => node.classNames.has('home-limit-window-wide')));
  assert.equal(readings[1].find('home-limit-window-label').textContent, 'Credit balance');
  assert.equal(readings[1].find('home-list-value').textContent, '$18.25');
  assert.equal(readings[1].find('limit-meter'), null);
  assert.equal(readings[1].find('limit-detail-tooltip').text, 'Monthly credits used $7.50');
  assert.equal(readings[1].find('limit-detail-tooltip-trigger').tabIndex, 0);
  assert.equal(readings[0].find('home-list-value').textContent, '$52.50');
  assert.ok(readings[0].find('limit-meter'));
});

test('Ollama refill tooltips expose complete accessible names on cards and Home', () => {
  const { parseOllamaUsageHtml } = require('../../src/shared/providers/ollama/limits');
  const { homeLimitAccounts } = require('../../src/electron/renderer/homeOverview');
  const { wallet } = require('../fixtures/ollamaCookieUsage.cjs');
  const refill = 'Refills to $30 in 3 weeks.';
  for (const withSpend of [false, true]) {
    const html = withSpend ? wallet : wallet.replace('<div><span>Monthly credits used</span><span>$4.50</span></div>', '');
    const parsed = parseOllamaUsageHtml(html);
    const row = normalizeLimitProvider({ provider: 'ollama', status: 'ok', windows: parsed.windows });
    const surfaces = [
      dockView().renderProviderWindows(row, '#888888'),
      renderHomeLimitFixture(homeLimitAccounts([{ providerId: 'ollama', windows: row.windows }]))
    ];
    for (const surface of surfaces) {
      const trigger = surface.find('limit-detail-tooltip-trigger');
      assert.equal(trigger.tabIndex, 0);
      assert.equal(trigger.getAttribute('aria-label'), withSpend ? `Monthly credits used: $4.50, ${refill}` : refill);
      const wrap = surface.find('limit-detail-tooltip-wrap');
      const tooltip = surface.find('limit-detail-tooltip');
      assert.ok(tooltip.text.includes(refill));
      wrap.isConnected = true;
      wrap.getBoundingClientRect = () => ({ top: 200 });
      tooltip.childElementCount = tooltip.children.length;
      tooltip.offsetHeight = 40;
      tooltip.showPopover = () => { tooltip.opened = true; };
      tooltip.hidePopover = () => { tooltip.opened = false; };
      wrap.listeners.focusin();
      assert.equal(tooltip.opened, true);
      wrap.listeners.keydown({ key: 'Escape' });
      assert.equal(tooltip.opened, false);
    }
  }
  const custom = dockView().limitDetailInfoNode([{ full: refill }], '', 'Custom accessible label');
  assert.equal(custom.find('limit-detail-tooltip-trigger').getAttribute('aria-label'), 'Custom accessible label');
  const mixed = dockView().limitDetailInfoNode([['Grant', '$1', '7/1'], { full: refill }, null, {}]);
  assert.equal(mixed.find('limit-detail-tooltip-trigger').getAttribute('aria-label'), `Grant: $1 7/1, ${refill}`);
});

test('Home retains standalone Ollama spending after legacy quotas when balance is absent or hidden', () => {
  const { parseOllamaUsageHtml } = require('../../src/shared/providers/ollama/limits');
  const { homeLimitAccountsForProviders } = require('../../src/electron/renderer/homeOverview');
  const { wallet } = require('../fixtures/ollamaCookieUsage.cjs');
  const legacy = '<section><span>Session usage</span><span>25% used</span><span>Weekly usage</span><span>40% used</span></section>';
  for (const hiddenWallet of [false, true]) {
    const html = legacy + (hiddenWallet ? wallet : wallet.replace('<span>$18.25</span>', ''));
    const parsed = parseOllamaUsageHtml(html);
    const row = normalizeLimitProvider({ provider: 'ollama', status: 'ok', windows: parsed.windows });
    for (const hiddenSpend of [false, true]) {
      const isWindowHidden = (_, window) => (hiddenWallet && window.metric === 'credits') || (hiddenSpend && window.metric === 'spend');
      const windows = limitPresentationApi.limitProviderCompactWindows(row, row.windows.filter((window) => !isWindowHidden('ollama', window)));
      const rows = homeLimitAccountsForProviders({
        providers: [{ ...row, windows }], providerOptions: [{ id: 'ollama', label: 'Ollama' }],
        enabledProviderIds: ['ollama'], isWindowHidden
      });
      const result = renderHomeLimitFixture(rows);
      const readings = [...result.walk()].filter((node) => node.classNames.has('home-limit-window'));
      assert.equal(readings.length, hiddenSpend ? 2 : 3);
      assert.equal(result.text.includes('$4.50'), !hiddenSpend);
      assert.ok(readings.every((node) => node.classNames.has('home-limit-window-wide')));
      if (!hiddenSpend) {
        assert.equal(readings.at(-1).find('home-limit-window-label').textContent, 'Monthly credits used');
        assert.equal(readings.at(-1).find('limit-meter'), null);
      }
    }
  }
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

test('a Sub2API card keeps Month and All time in the summary and its original usage tooltip', () => {
  const card = dockView().renderProviderWindows({
    provider: 'thirdparty', adapterId: 'sub2api', status: 'ok', planLabel: 'Account',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 12.5, currency: 'USD' }],
    balance: { amount: 12.5, currency: 'USD', monthSpend: 2.5, allTimeSpend: 18.75 },
    usageSummary: {
      period: 'month', requests: 21, totalTokens: 1940, inputTokens: 1234,
      outputTokens: 456, cacheReadTokens: 200, cacheCreationTokens: 50,
      averageDurationMs: 850, standardCost: 3
    }
  }, '#888888');
  assert.equal(card.find('limit-spend-summary').text, 'Month $2.50 · All time $18.75');
  const tooltip = card.find('limit-detail-tooltip');
  assert.deepEqual(tooltip.children.map((row) => row.text), [
    'Month requests 21', 'Month tokens 1,940', 'Input tokens 1,234',
    'Output tokens 456', 'Cache tokens 250', 'Avg response 850 ms', 'Standard cost $3.00'
  ]);
  assert.equal(tooltip.find('is-separated'), null);
});

test('a real Sub2API adapter result retains its inferred balance meter', () => {
  const { THIRD_PARTY_ADAPTERS } = require('../../src/shared/providers/thirdparty/limits');
  const quota = THIRD_PARTY_ADAPTERS.sub2api.quota({ code: 0, data: { id: 7, balance: 4 } }, null, null, null, {
    month: { code: 0, data: { total_actual_cost: 6 } }
  });
  const row = normalizeLimitProvider({ provider: 'thirdparty', adapterId: 'sub2api', status: 'ok', windows: [quota.window], balance: quota.balance });
  const card = dockView().renderProviderWindows(row, '#888888');
  assert.equal(card.textOf('limit-meter').length, 1);
  assert.match(card.text, /\$4\.00/);
  assert.match(card.text, /Month \$6\.00/);
  assert.equal(card.find('limit-meter-fill').style['--bar-scale'], '0.4');
});

test('a third-party card summarizes Today and Month and details every period', () => {
  const card = dockView().renderProviderWindows({
    provider: 'thirdparty',
    adapterId: 'newapi-account',
    status: 'ok',
    planLabel: 'Account',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 11.42, currency: 'USD' }],
    balance: {
      amount: 11.42,
      currency: 'USD',
      todaySpend: 0,
      weekSpend: 1.44,
      monthSpend: 1.44,
      allTimeSpend: 18.58
    }
  }, '#888888');

  assert.match(card.text, /Spend Today \$0\.00 · Month \$1\.44/);
  const tooltip = card.find('limit-detail-tooltip');
  assert.ok(tooltip, 'the card should carry the ⓘ tooltip, not only the summary');
  assert.match(tooltip.text, /Today \$0\.00/);
  assert.match(tooltip.text, /Week \$1\.44/);
  assert.match(tooltip.text, /All time \$18\.58/);
});

test('a third-party tooltip keeps account details above spend without duplicate spoken periods', () => {
  const card = dockView().renderProviderWindows({
    provider: 'thirdparty', adapterId: 'newapi-account', status: 'ok', planLabel: 'Account',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 11.42, limit: 30, currency: 'USD' }],
    balance: {
      amount: 11.42, currency: 'USD', todaySpend: 0, weekSpend: 1.44,
      monthSpend: 1.44, allTimeSpend: 18.58, requestCount: 12345, quotaGroup: 'default'
    }
  }, '#888888');
  const tooltip = card.find('limit-detail-tooltip');
  const rows = tooltip.children.map((row) => row.text);
  assert.deepEqual(rows, [
    'Total quota $30.00', 'Requests 12,345', 'Group default', '',
    'Today $0.00', 'Week $1.44', 'Month $1.44', 'All time $18.58'
  ]);
  assert.ok(tooltip.children[3].classList.contains('is-separated'));
  const spoken = card.find('limit-spend').attributes['aria-label'];
  assert.equal(spoken.match(/Today/g)?.length, 1);
  assert.equal(spoken.match(/Month/g)?.length, 1);
});

test('the dock card asks for room instead of dropping tooltip rows', () => {
  // The bubble is only as tall as the card, so the card is what grows: the
  // tooltip keeps every row the Limits page shows, and the host is asked for the
  // height it needs rather than the rows being trimmed to fit the window.
  const requested = [];
  const card = dockView({}, {
    tooltipSpace: {
      request: (height) => requested.push(height),
      release: () => {}
    }
  }).renderProviderWindows({
    provider: 'thirdparty', adapterId: 'newapi-account', status: 'ok', planLabel: 'Account',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 11.42, limit: 30, currency: 'USD' }],
    balance: {
      amount: 11.42, currency: 'USD', todaySpend: 0, weekSpend: 1.44,
      monthSpend: 1.44, allTimeSpend: 18.58, requestCount: 12_345, quotaGroup: 'default'
    },
    usageSummary: {
      period: 'month', requests: 21, totalTokens: 1940, inputTokens: 1234,
      outputTokens: 456, averageDurationMs: 850, standardCost: 3
    }
  }, '#888888');
  const rows = card.find('limit-detail-tooltip').children.map((row) => row.text);
  assert.deepEqual(rows, [
    'Total quota $30.00', 'Requests 12,345', 'Group default',
    'Month requests 21', 'Month tokens 1,940', 'Input tokens 1,234',
    'Output tokens 456', 'Avg response 850 ms', 'Standard cost $3.00', '',
    'Today $0.00', 'Week $1.44', 'Month $1.44', 'All time $18.58'
  ]);
  // Nothing is requested until the tooltip actually opens.
  assert.deepEqual(requested, []);
});

test('a third-party card falls back to all-time when dashboard periods are unknown', () => {
  const card = dockView().renderProviderWindows({
    provider: 'thirdparty', adapterId: 'newapi-account', status: 'ok', planLabel: 'Account',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 39.45, currency: 'USD' }],
    balance: {
      amount: 39.45, currency: 'USD', todaySpend: null, weekSpend: null,
      monthSpend: null, allTimeSpend: 140.57
    }
  }, '#888888');
  assert.match(card.text, /Spend All time \$140\.57/);
  assert.doesNotMatch(card.text, /Today|Week|Month|\$0\.00/);
});

test('a third-party tooltip keeps the original account format when all-time is the summary', () => {
  const card = dockView().renderProviderWindows({
    provider: 'thirdparty', adapterId: 'newapi-account', status: 'ok', planLabel: 'Account',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 39.45, limit: 180.02, currency: 'USD' }],
    balance: {
      amount: 39.45, currency: 'USD', todaySpend: null, weekSpend: null,
      monthSpend: null, allTimeSpend: 140.57, requestCount: 30836, quotaGroup: 'default'
    }
  }, '#888888');
  assert.match(card.find('limit-spend-summary').text, /All time \$140\.57/);
  const tooltip = card.find('limit-detail-tooltip');
  assert.deepEqual(tooltip.children.map((row) => row.text), [
    'Total quota $180.02', 'Requests 30,836', 'Group default'
  ]);
  assert.doesNotMatch(tooltip.text, /Today|Week|Month|All time/);
  assert.equal(tooltip.find('is-separated'), null);
});

test('a third-party card retains zero account details when spend is unavailable', () => {
  const card = dockView().renderProviderWindows({
    provider: 'thirdparty', adapterId: 'newapi-account', status: 'ok', planLabel: 'Account',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 0, limit: 0, currency: 'USD' }],
    balance: { amount: 0, currency: 'USD', requestCount: 0, quotaGroup: 'default' }
  }, '#888888');
  assert.match(card.find('limit-spend').text, /Details/);
  assert.deepEqual(card.find('limit-detail-tooltip').children.map((row) => row.text), [
    'Total quota $0.00', 'Requests 0', 'Group default'
  ]);
});

test('a MiMo membership row meters like any percent quota, WorkBuddy included', () => {
  // The membership lane answers with a percentage and nothing else — the app's
  // own card prints "{{percent}}% remaining" from that field, and no endpoint
  // reports an absolute used/limit pair for it. So the row is a percent window
  // and draws the shared meter, the path every rate-limit window takes.
  const membershipRow = {
    provider: 'mimo',
    source: 'local',
    sourceDetail: 'app',
    status: 'ok',
    accountName: 'MiMo abcdef1',
    accountLabel: 'Desktop Membership',
    planLabel: 'Pro',
    // What the collector's normalization produces from the vendor's percent.
    windows: [{
      kind: 'weekly',
      usedPercent: 21.5,
      remainingPercent: 78.5,
      resetsAt: new Date(Date.now() + 86_400_000).toISOString()
    }]
  };
  const card = dockView().renderProviderWindows(membershipRow, '#000000');
  const fill = card.find('limit-meter-fill');
  assert.ok(fill, 'the membership row should carry a bar, not only a number');
  // "left" mode is the default, so the bar shows the share still available.
  assert.equal(fill.style['--bar-scale'], '0.785');
  assert.match(card.text, /79% left/);
  assert.match(card.text, /Weekly/);
  assert.doesNotMatch(card.text, /Monthly/);
  assert.match(card.text, /Reset/);

  // The used-mode flip is the shared one, so the same row read the other way
  // fills to the consumed share.
  const usedMode = dockView({ showLimitUsed: true }).renderProviderWindows(membershipRow, '#000000');
  assert.equal(usedMode.find('limit-meter-fill').style['--bar-scale'], '0.215');
  assert.match(usedMode.text, /22% used/);

  // WorkBuddy meters a credits window the same way — its own branch only swaps
  // the right-hand cell for the amount, so the two rows agree on the bar.
  const workbuddyRow = {
    provider: 'workbuddy',
    status: 'ok',
    windows: [{
      kind: 'billing',
      label: 'Credits',
      metric: 'credits',
      currency: 'CREDITS',
      used: 215,
      limit: 1000,
      remaining: 785,
      usedPercent: 21.5,
      remainingPercent: 78.5,
      showMeter: true
    }],
    balance: { amount: 785, currency: 'CREDITS' }
  };
  const workbuddyCard = dockView().renderProviderWindows(workbuddyRow, '#12B7F5');
  assert.equal(workbuddyCard.find('limit-meter-fill').style['--bar-scale'], '0.785');

  // An empty window list must not invent a percentage meter.
  const noPlan = dockView().renderProviderWindows(
    { ...membershipRow, planLabel: '', windows: [] },
    '#000000'
  );
  assert.equal(noPlan.find('limit-meter-fill'), null);
});

test('one MiMo product failing still leaves the other row and its quota on the card', () => {
  const rows = [
    {
      provider: 'mimo',
      status: 'ok',
      source: 'web',
      sourceDetail: 'managed',
      accountKey: 'sha256:console',
      accountLabel: 'Console',
      accountName: 'MiMo console',
      planLabel: 'Pay-as-you-go',
      windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 9.95, currency: 'CNY', showMeter: false }],
      balance: { amount: 9.95, currency: 'CNY' }
    },
    {
      provider: 'mimo',
      status: 'unauthorized',
      source: 'local',
      sourceDetail: 'app',
      accountKey: 'sha256:membership',
      accountLabel: 'Desktop Membership',
      accountName: 'MiMo member',
      windows: []
    }
  ];
  const group = dockView().renderLimitProviderGroup('mimo', 'Xiaomi MiMo', rows, '#000000');

  // The lane that answered keeps its rows: the wallet is on the card...
  assert.match(group.text, /9\.95/);
  // ...and the lane that did not is a row of its own instead of taking the
  // other product's place, so neither failure is silent and neither is a
  // swallowed row.
  assert.match(group.text, /Sign in again/);
  assert.equal(group.text.match(/Sign in again/g).length, 1, 'one row asks, the healthy one does not');
});

test('a MiMo wallet meters against its month spend and carries the spend line', () => {
  // No provider percentage: reuse the shared current / (current + month spend)
  // fallback, as DeepSeek does.
  const row = {
    provider: 'mimo',
    status: 'ok',
    source: 'web',
    sourceDetail: 'managed',
    accountLabel: 'Console',
    accountName: 'MiMo console',
    planLabel: 'Pay-as-you-go',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 9.95, currency: 'CNY' }],
    balance: { amount: 9.95, currency: 'CNY', giftBalance: 9.95, cashBalance: 0, monthSpend: 9.3, allTimeSpend: 32.85 }
  };
  const card = dockView().renderProviderWindows(row, '#000000');
  const labels = [...card.walk()].filter((n) => n.classNames?.has('limit-window')).map((n) => n.text.replace(/\s+/g, ' ').trim());

  // 9.95 / (9.95 + 9.30) = 51.7% left.
  assert.ok(
    Math.abs(Number(card.find('limit-meter-fill').style['--bar-scale']) - 0.5169) < 0.001,
    'the bar is the wallet against its month spend'
  );
  assert.match(labels[0], /Balance ¥9\.95 Gift ¥9\.95 · Cash ¥0\.00/);
  // This fixture has no locally tracked Today or Week spend.
  const spend = card.find('limit-spend');
  assert.ok(spend, 'the card should carry the spend row the wallet providers have');
  assert.match(spend.text, /Month ¥9\.30/);
  assert.doesNotMatch(spend.text, /Today|Week/);

  // A wallet with no reported spend reads as untouched — the shared rule for a
  // positive top-up balance — and has no spend row to show.
  const bare = dockView().renderProviderWindows(
    { ...row, balance: { amount: 9.95, currency: 'CNY' } },
    '#000000'
  );
  assert.equal(bare.find('limit-meter-fill').style['--bar-scale'], '1');
  assert.equal(bare.find('limit-spend'), null);

  for (const partial of [{ giftBalance: 5 }, { cashBalance: 5 }]) {
    const unknown = dockView().renderProviderWindows({
      ...row, windows: [], balance: { amount: null, currency: 'CNY', ...partial }
    }, '#000000');
    assert.match(unknown.text, /Balance —/);
    assert.equal(unknown.find('limit-meter-fill'), null, 'unknown funds must not look exhausted');
  }
  const empty = dockView().renderProviderWindows({
    ...row, windows: [], balance: { amount: 0, currency: 'CNY' }
  }, '#000000');
  assert.equal(empty.find('limit-meter-fill').style['--bar-scale'], '0');
  const reported = dockView().renderProviderWindows({
    ...row, windows: [{ kind: 'billing', metric: 'credits', usedPercent: 25 }],
    balance: { amount: null, currency: 'CNY', giftBalance: 5 }
  }, '#000000');
  assert.equal(reported.find('limit-meter-fill').style['--bar-scale'], '0.75');
});

test('a MiMo Console card renders Token Plan states from normalized and persisted rows', () => {
  const active = dockView().renderProviderWindows({
    provider: 'mimo',
    status: 'ok',
    accountLabel: 'Console',
    windows: [
      { kind: 'billing', label: 'Token Plan', used: 25, limit: 100, usedPercent: 25, remainingPercent: 75 },
      { kind: 'billing', metric: 'credits', label: 'Balance', remaining: 9.95, currency: 'CNY' }
    ],
    balance: { amount: 9.95, currency: 'CNY' }
  }, '#000000');
  const activeRows = [...active.walk()].filter((node) => node.classNames.has('limit-window'));
  assert.deepEqual(activeRows.map((node) => node.children[0].children[0].textContent), ['Token Plan', 'Balance']);
  assert.equal(activeRows[0].find('limit-meter-fill').style['--bar-scale'], '0.75');

  const persisted = dockView().renderProviderWindows({
    provider: 'mimo',
    status: 'ok',
    accountLabel: 'Console',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 9.95, currency: 'CNY' }],
    balance: { amount: 9.95, currency: 'CNY', planUsed: 25, planLimit: 100, planPercent: 25 }
  }, '#000000');
  const persistedRows = [...persisted.walk()].filter((node) => node.classNames.has('limit-window'));
  assert.deepEqual(persistedRows.map((node) => node.children[0].children[0].textContent), ['Token Plan', 'Balance']);
  assert.equal(persistedRows[0].find('limit-meter-fill').style['--bar-scale'], '0.75');

  const expired = dockView().renderProviderWindows({
    provider: 'mimo',
    status: 'ok',
    accountLabel: 'Console',
    windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 9.95, currency: 'CNY' }],
    balance: { amount: 9.95, currency: 'CNY', planStatus: 'expired' }
  }, '#000000');
  const expiredRows = [...expired.walk()].filter((node) => node.classNames.has('limit-window'));
  assert.deepEqual(expiredRows.map((node) => node.children[0].children[0].textContent), ['Token Plan', 'Balance']);
  assert.match(expiredRows[0].text, /Expired/);
  assert.equal(expiredRows[0].find('limit-meter-fill'), null);
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
    ['workbuddy', 'WorkBuddy', '#10B981'],
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

test('MiMo groups products under each account and keeps their own plan and status', () => {
  const view = dockView();
  const rows = [
    { provider: 'mimo', status: 'ok', accountKey: 'sha256:abcdef123456', accountName: 'MiMo abcdef1', accountLabel: 'Desktop Membership', planLabel: 'Pro', windows: [{ kind: 'weekly', usedPercent: 40 }] },
    { provider: 'mimo', status: 'ok', accountKey: 'sha256:abcdef654321', accountName: 'MiMo abcdef6', accountLabel: 'Desktop Membership', windows: [{ kind: 'weekly', usedPercent: 25 }] }
  ];
  const group = view.renderLimitProviderGroup('mimo', 'MiMo', rows, '#000000');
  const accounts = group.find('limit-account-list').children;
  assert.deepEqual(accounts.map((row) => row.find('limit-name-title').textContent), [
    'MiMo abcdef1', 'MiMo abcdef6'
  ]);
  assert.equal(group.find('limit-plan').textContent, '2 accounts');
  const products = accounts.map((account) => account.find('limit-account-list').children[0]);
  // Product rows name nothing: the plan cell and the readings carry what they are.
  for (const row of products) {
    assert.equal(row.find('limit-name-title'), null, 'the lane word stays off the screen');
  }
  assert.equal(products[0].find('limit-plan').textContent, 'Pro');
  assert.equal(products[1].find('limit-plan')?.textContent ?? '', '');
  // INVITE hides the plan name but retains the quota that identifies the row.
  assert.match(products[1].text, /Weekly/);
  assert.match(products[1].text, /75%/);
});

test('one MiMo account uses the provider heading and separate product rows', () => {
  const view = dockView({ maskLimitAccountEmails: true });
  const rows = [
    { provider: 'mimo', status: 'ok', accountKey: 'sha256:console', accountName: 'Old profile · MiMo abcdef1', accountEmail: 'same@example.com', accountLabel: 'Console', windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 9.95, currency: 'CNY' }] },
    { provider: 'mimo', status: 'unauthorized', sourceDetail: 'app', accountKey: 'sha256:membership', accountName: 'New profile · MiMo abcdef1', accountEmail: 'same@example.com', accountLabel: 'Desktop Membership', windows: [] }
  ];
  const group = view.renderLimitProviderGroup('mimo', 'Xiaomi MiMo', rows, '#000000');
  assert.equal(group.find('limit-name-title').textContent, 'Xiaomi MiMo');
  assert.equal(group.find('limit-plan').textContent, '');
  const products = group.find('limit-account-list').children;
  // The healthy row names nothing; the refused lane has no reading left, so its
  // row carries the lane word the wire gave it.
  assert.equal(products[0].find('limit-name-title'), null);
  assert.equal(products[1].find('limit-name-title').textContent, 'Desktop Membership');
  assert.match(products[0].text, /9\.95/);
  assert.match(products[1].text, /Sign in again/);
});

test('a healthy MiMo product row names nothing; a refused one keeps its lane word', () => {
  const view = dockView();
  {
    const card = view.renderLimitProviderSolo('mimo', 'Xiaomi MiMo', {
      provider: 'mimo', status: 'ok', sourceDetail: 'app', accountLabel: 'Console',
      planLabel: 'Pay-as-you-go', windows: []
    }, '#000000');
    // The readings and the plan cell say what the row is.
    assert.deepEqual(card.textOf('limit-name-title'), ['Xiaomi MiMo']);
    assert.equal(card.text.includes('Console'), false);
    assert.equal(card.find('limit-account-list').children[0].find('limit-plan').textContent, 'Pay-as-you-go');
  }
  {
    const card = view.renderLimitProviderSolo('mimo', 'Xiaomi MiMo', {
      provider: 'mimo', status: 'unauthorized', sourceDetail: 'app', accountLabel: 'Desktop Membership',
      planLabel: 'Pay-as-you-go', windows: []
    }, '#000000');
    assert.deepEqual(card.textOf('limit-name-title'), ['Xiaomi MiMo', 'Desktop Membership']);
    assert.equal(card.find('limit-account-list').children[0].find('limit-plan').textContent, 'Sign in again');
  }
  {
    // A status-only row synced before the lane words existed carries no
    // recognized label; it still names itself through the account title rather
    // than failing anonymously beside its named siblings.
    const group = view.renderLimitProviderGroup('mimo', 'Xiaomi MiMo', [
      { provider: 'mimo', status: 'ok', source: 'web', sourceDetail: 'managed', accountKey: 'sha256:mimoa', accountName: 'MiMo abcdefa', accountLabel: 'Console', planLabel: 'Pay-as-you-go', windows: [] },
      { provider: 'mimo', status: 'unavailable', sourceDetail: 'app', accountKey: 'sha256:mimoa-membership', accountName: 'MiMo abcdefa', accountLabel: '', windows: [] }
    ], '#000000');
    // One logical account renders its products flat under the provider heading.
    // The legacy row's title is the shared two-stage identity: the descriptive
    // name, disambiguated by an opaque key fingerprint because both rows
    // describe themselves identically.
    const products = group.find('limit-account-list').children;
    assert.equal(products[0].find('limit-name-title'), null);
    assert.match(products[1].find('limit-name-title').textContent, /^MiMo abcdefa · #[a-z0-9]+$/);
  }
  const unconfigured = view.renderLimitProviderSolo('mimo', 'Xiaomi MiMo', {
    provider: 'mimo', status: 'notConfigured', windows: []
  }, '#000000');
  assert.deepEqual(unconfigured.textOf('limit-name-title'), ['Xiaomi MiMo']);
});

test('MiMo keeps different accounts apart when emails mask alike', () => {
  const view = dockView({ maskLimitAccountEmails: true });
  const rows = [
    { provider: 'mimo', status: 'ok', accountKey: 'sha256:console-a', accountName: 'Profile · MiMo abcdef1', accountEmail: 'james@example.com', accountLabel: 'Console', windows: [] },
    { provider: 'mimo', status: 'ok', accountKey: 'sha256:member-b', accountName: 'Profile · MiMo abcdef6', accountEmail: 'jones@example.com', accountLabel: 'Desktop Membership', planLabel: 'Pro', windows: [] },
    { provider: 'mimo', status: 'ok', accountKey: 'sha256:member-a', accountName: 'Profile · MiMo abcdef1', accountEmail: 'james@example.com', accountLabel: 'Desktop Membership', planLabel: 'Plus', windows: [] }
  ];
  const group = view.renderLimitProviderGroup('mimo', 'Xiaomi MiMo', rows, '#000000');
  const accounts = group.find('limit-account-list').children;
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((account) => account.find('limit-name-title').textContent), [
    'j***s@example.com · Profile · MiMo abcdef1',
    'j***s@example.com · Profile · MiMo abcdef6'
  ]);
  assert.equal(group.find('limit-plan').textContent, '2 accounts');
  for (const account of accounts) {
    for (const product of account.find('limit-account-list').children) {
      assert.equal(product.find('limit-name-title'), null, 'the lane word stays off the screen');
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

test('MiMo account headings do not duplicate the provider subscription card or add empty focus stops', () => {
  const rows = ['a', 'b'].map((accountKey, index) => ({
    provider: 'mimo', status: 'ok', accountKey, accountName: `MiMo abcdef${index + 1}`,
    accountLabel: 'Console', planLabel: 'Pay-as-you-go', windows: []
  }));
  const subscription = {
    id: 'mimo-sub', provider: 'mimo', kind: 'subscription', planName: 'Pro', amountMinor: 1000,
    currency: 'USD', intervalCount: 1, interval: 'month', startDate: '2026-08-01', autoRenew: true,
    topUps: [], binding: { accountKey: 'a' }
  };
  const view = dockView({ subscriptions: [subscription], accounts: rows });
  const built = view.renderLimitProviderGroup('mimo', 'Xiaomi MiMo', rows, '#000000');
  const wraps = [...built.walk()].filter((node) => node.classNames.has('subscription-plan-wrap'));
  assert.deepEqual(wraps.map((node) => node.find('subscription-plan-trigger').textContent), ['2 accounts', 'Pay-as-you-go']);
  assert.equal(wraps.every((node) => node.tabIndex === 0), true, 'the visible triggers remain keyboard accessible');
  assert.equal(view.renderLimitProviderHead('mimo', 'Account A', rows[0], '#000000', {
    accountRow: true, planText: ''
  }).find('subscription-plan-wrap'), null, 'an empty plan has no hover or keyboard trigger');
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
  assert.match(dock, /subscriptionAccounts: \(\) => cell\(\)\?\.subscriptionAccounts \|\| \[\],/);
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
    /provenanceContext: \(\) => cell\(\)\?\.provenanceContext/,
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

for (const unavailable of [false, true]) for (const showLimitUsed of [false, true]) test(`Antigravity keeps the original quota pairs above Argon weekly with Claude 5-hour ${unavailable ? 'unavailable' : 'available'} in ${showLimitUsed ? 'used' : 'remaining'} mode`, () => {
  const record = normalizeLimitProvider({
    provider: 'antigravity',
    windows: [
      { kind: 'weekly', label: 'Gemini 4 Argon weekly', usedPercent: 63 },
      { kind: 'session', label: 'Gemini 5-hour', usedPercent: 2 },
      { kind: 'weekly', label: 'Gemini weekly', usedPercent: 1 },
      { kind: 'session', label: 'Claude/GPT 5-hour', usedPercent: unavailable ? null : 0, showMeter: !unavailable },
      { kind: 'weekly', label: 'Claude/GPT weekly', usedPercent: 100 }
    ]
  });
  const before = structuredClone(record);
  const card = dockView({ showLimitUsed }).renderProviderWindows(record, '#4285F4');
  const groups = [...card.walk()].filter((node) => node.classNames.has('limit-window-group'));
  assert.deepEqual(
    groups.map((group) => [
      group.find('limit-window-group-title')?.textContent,
      [...group.walk()].filter((node) => node.classNames.has('limit-window')).map(rowTitle)
    ]),
    [
      ['Gemini', ['5-hour', 'Weekly']],
      ['Claude/GPT', ['5-hour', 'Weekly']],
      ['Gemini 4 Argon', ['Weekly']]
    ]
  );
  const items = dockView().limitProviderUsageItems([record]);
  assert.deepEqual(items.map((item) => item.label), [
    'Gemini · 5-hour',
    'Gemini · Weekly',
    'Claude/GPT · 5-hour',
    'Claude/GPT · Weekly',
    'Gemini 4 Argon · Weekly'
  ]);
  assert.equal([...card.walk()].filter((node) => node.classNames.has('limit-meter')).length, unavailable ? 4 : 5);
  const expectedRemaining = [98, 99, unavailable ? null : 100, 0, 37];
  const rows = [...card.walk()].filter((node) => node.classNames.has('limit-window'));
  rows.forEach((row, index) => {
    const remaining = expectedRemaining[index];
    const fill = row.find('limit-meter-fill');
    if (remaining === null) {
      assert.equal(fill, null);
      assert.doesNotMatch(row.text, /%/);
    } else {
      const percent = showLimitUsed ? 100 - remaining : remaining;
      assert.ok(row.text.includes(`${percent}% ${showLimitUsed ? 'used' : 'left'}`), row.text);
      assert.equal(Number(fill.style['--bar-scale']), percent / 100);
    }
  });
  assert.deepEqual(record, before, 'display ordering does not mutate the normalized quota record');
});

test('Antigravity OAuth legacy fallback keeps unknown, exhausted and numeric quotas distinct in both display modes', async () => {
  const resetTime = '2030-06-03T04:00:00Z';
  const providers = await fetchAntigravityLimits({
    antigravityManagedAccounts: [{
      id: 'legacy', accountEmail: 'legacy@example.com',
      credentials: { accessToken: 'fixture-token', expiresAt: Date.now() + 3600_000,
        clientId: 'client', clientSecret: 'secret', projectId: 'fixture-project' }
    }]
  }, {
    antigravityProbe: async () => { throw new Error('local RPC unavailable'); },
    fetch: async (url) => {
      let payload;
      if (url.endsWith(':loadCodeAssist')) payload = {};
      else if (url.endsWith(':retrieveUserQuotaSummary')) payload = { groups: [] };
      else if (url.endsWith(':fetchAvailableModels')) payload = { models: {
        'gemini-4-argon-high': { displayName: 'Gemini 4 Argon', quotaInfo: { remainingFraction: null, resetTime } },
        'gemini-flash': { displayName: 'Gemini Flash', quotaInfo: { remainingFraction: 0.8, resetTime } },
        'claude-sonnet': { displayName: 'Claude', quotaInfo: { remainingFraction: 0, resetTime } }
      } };
      else throw new Error(`Unexpected URL ${url}`);
      return { ok: true, status: 200, json: async () => payload };
    }
  });
  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.equal(provider.source, 'oauth');
  const unknown = provider.windows.find((window) => window.label === 'Gemini 4 Argon');
  assert.equal(unknown.remainingPercent, null);
  assert.equal(unknown.usedPercent, null);
  assert.equal(unknown.showMeter, false);
  assert.equal(unknown.resetsAt, new Date(resetTime).toISOString());
  const before = structuredClone(provider);

  for (const showLimitUsed of [false, true]) {
    const card = dockView({ showLimitUsed }).renderProviderWindows(provider, '#4285F4');
    const rows = [...card.walk()].filter((node) => node.classNames.has('limit-window'));
    const argon = rows.find((row) => row.text.includes('Gemini 4 Argon'));
    assert.equal(argon, undefined, 'unknown legacy pools do not render their name or reset');
    assert.equal(rows.length, 2);
    for (const [label, remaining] of [['Gemini Flash', 80], ['Claude', 0]]) {
      const row = rows.find((entry) => entry.text.includes(label));
      const percent = showLimitUsed ? 100 - remaining : remaining;
      assert.ok(row.text.includes(`${percent}% ${showLimitUsed ? 'used' : 'left'}`), row.text);
      assert.equal(Number(row.find('limit-meter-fill').style['--bar-scale']), percent / 100);
    }
  }
  assert.deepEqual(dockView().limitProviderUsageItems([provider]).map((item) => item.label), ['Gemini Flash', 'Claude']);
  assert.deepEqual(limitPresentationApi.limitProviderCompactWindows('antigravity', provider.windows).map((window) => window.label), ['Gemini Flash', 'Claude']);
  assert.deepEqual(provider, before, 'hidden legacy pools retain their source data');
});

test('Antigravity hides an all-unknown legacy pool without adding a placeholder quota', () => {
  const provider = normalizeLimitProvider({ provider: 'antigravity', windows: [
    { kind: 'weekly', label: 'Gemini 4 Argon', usedPercent: null, resetsAt: '2030-06-03T04:00:00Z' }
  ] });
  const before = structuredClone(provider);
  for (const showLimitUsed of [false, true]) {
    const card = dockView({ showLimitUsed }).renderProviderWindows(provider, '#4285F4');
    assert.equal(card.children.length, 0);
    assert.equal(card.text, '');
  }
  assert.deepEqual(dockView().limitProviderUsageItems([provider]), []);
  assert.deepEqual(limitPresentationApi.limitProviderCompactWindows('antigravity', provider.windows), []);
  assert.deepEqual(provider, before);
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


test('WorkBuddy sealed credentials show their cause instead of signed-out instructions on shared rows', () => {
  const view = dockView();
  const provider = { provider: 'workbuddy', status: 'notConfigured', accountKey: 'encrypted-account', actionRequired: 'appSessionEncrypted', windows: [] };
  const row = view.renderLimitProviderSolo('workbuddy', 'WorkBuddy', provider, '#10A37F');
  assert.equal(row.find('limit-plan').textContent, 'Encrypted by app');
  assert.equal(view.limitProviderMeta(provider), 'Encrypted by app');
  assert.equal(view.renderLimitProviderSolo('workbuddy', 'WorkBuddy', { ...provider, actionRequired: undefined }, '#10A37F').find('limit-plan').textContent, 'Not signed in');
});


test('WorkBuddy groups count accounts and retain failures without repeating the provider mark', () => {
  const view = dockView();
  const accounts = [
    { provider: 'workbuddy', status: 'ok', accountKey: 'a', accountName: 'Personal', region: 'cn', windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', remaining: 80, limit: 100 }] },
    { provider: 'workbuddy', status: 'unavailable', accountKey: 'b', accountName: 'Work', region: 'cn', windows: [] }
  ];
  const group = view.renderLimitProviderGroup('workbuddy', 'WorkBuddy', accounts, '#10B981');
  assert.equal(group.find('limit-plan').textContent, '2 accounts');
  assert.equal([...group.walk()].filter((node) => node.classNames.has('limit-icon')).length, 1);
  const rows = group.find('limit-account-list').children;
  assert.deepEqual(rows.map((row) => row.find('limit-name-title').textContent), ['Personal', 'Work']);
  assert.equal(rows[1].find('limit-plan').textContent, 'Unavailable');
});









test('EdgeDock render hold preserves account gestures and open tooltips', () => {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const start = source.indexOf('function deferBubbleRender(');
  const end = source.indexOf('bridge.onRender(render);', start);
  let accountHeld = false, tooltipHeld = false;
  const context = {
    contentLayer: {}, codexAccountControl: { deferRender: () => accountHeld },
    limitTooltipShouldHoldRender: () => tooltipHeld, limitTooltip: { pending: false }
  };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.deferBubbleRender(), false);
  accountHeld = true;
  assert.equal(context.deferBubbleRender(), true, 'an in-progress account gesture keeps its DOM');
  accountHeld = false; tooltipHeld = true;
  assert.equal(context.deferBubbleRender(), true, 'an open tooltip holds the update');
  assert.equal(context.limitTooltip.pending, true);
  tooltipHeld = false;
  assert.equal(context.deferBubbleRender(), false, 'closing the tooltip releases the update');
});











test('Notch ears preserve configured tray items and embedded fields across all styles', () => {
  const trayLayout = require('../../src/shared/trayLayout');
  const typography = require('../../src/electron/renderer/trayTypography');
  const { buildNotchData } = require('../../src/electron/notch/data');
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/notch/renderer.js'), 'utf8');
  const el = (tag, classes, text = '') => {
    const node = new FakeElement(tag); node.className = classes; node.textContent = text; return node;
  };
  const context = {
    el, trayTypographyApi: typography, trayBarsApi: require('../../src/electron/renderer/trayBars'), notchNumbers: new Map(), cancelAnimationFrame() {},
    providerLabel: id => id, positionNotchSummary() {},
    notchIcon: item => el('span', 'edge-dock-mark', item.provider),
    notchText: (_item, row) => el('span', 'notch-text-run', row.text)
  };
  vm.runInNewContext(source.slice(source.indexOf('function allocateNotchSummary('), source.indexOf('function zoomForNotchText(')), context);
  const stats = {
    limits: { providers: [{ provider: 'codex', status: 'ok', accountKey: 'test', accountEmail: 'test@example.test', windows: [
      { kind: 'session', remainingPercent: 64, resetsAt: new Date(Date.now() + 3600000).toISOString() },
      { kind: 'weekly', remainingPercent: 74 }
    ] }] }, periods: { today: { totalTokens: 9500, costUsd: 0 } }
  };
  for (const style of trayLayout.STYLE_IDS) {
    const item = trayLayout.createTrayLayoutItem(style);
    const icon = trayLayout.createTrayLayoutItem('providerIcon'); icon.source.provider = 'codex';
    const cost = trayLayout.createTrayLayoutItem('cost');
    const separator = trayLayout.createTrayLayoutItem('separatorDot');
    const readings = !['icon', 'spacer'].includes(item.type);
    if (readings) {
      const summary = buildNotchData(stats, [], { notchSummaryMode: 'custom',
        notchCustomLayout: { version: trayLayout.VERSION, items: [icon, item] } }).summary;
      const single = context.notchSummary({ summary, geometry: { gapWidth: 179 }, appearance: {} });
      assert.equal(single.find('notch-left').querySelectorAll('.notch-reading').length, 0, `${style} remains one field even with multiple rows`);
      assert.equal(single.find('notch-right').querySelectorAll('.notch-reading').length, 1);
    }
    for (const gapWidth of [179, 0]) {
      const summary = buildNotchData(stats, [], { notchSummaryMode: 'custom',
        notchCustomLayout: { version: trayLayout.VERSION, items: [icon, item, separator, cost] }
      }).summary;
      const head = context.notchSummary({ summary, geometry: { gapWidth }, appearance: {} });
      const left = head.find('notch-left').children[0], right = head.find('notch-right').children[0];
      if (gapWidth && readings) {
        assert.equal(left.children.length, 2, style);
        assert.equal(right.children.length, 1, style);
        assert.equal(right.dataset.notchOptional, 'true');
        assert.equal(left.children[0].textContent, 'codex');
        assert.equal(left.children[1].dataset.notchPrimary, 'true');
        assert.equal(right.children[0].dataset.notchSpacer, 'false', 'no separator starts the right ear');
        if (item.type === 'stack' || item.type === 'bars') {
          const block = left.find(item.type === 'stack' ? 'notch-stack' : 'notch-bars');
          assert.equal(block.children.length, item.rows?.length || item.lines.length, `${style} rows stay together`);
          if (item.type === 'bars') {
            assert.equal(block.style.gap, '3px');
            for (const track of block.children) {
              assert.equal(track.style.width, '18px', 'bars retain the compact tray width');
              assert.equal(track.style.height, '5px');
            }
          }
          if (summary.items[1].iconProvider) {
            const field = left.find('notch-summary-field');
            assert.equal(field.children.length, 2, 'only the embedded mark stays with its field');
            assert.equal(field.style.gap, item.type === 'bars' ? '3px' : '2px');
          }
        }
        assert.match(right.text, /0/, 'zero cost remains a displayed field');
      } else {
        assert.equal(left.querySelectorAll('.notch-reading').filter(node => node.dataset.notchSpacer !== 'true').length, 0, `${style} keeps readings together on the right`);
      }
    }
  }
});

test('ear fitting keeps graphics whole within the hard budget', () => {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/notch/renderer.js'), 'utf8');
  const el = (tag, classes, text = '') => {
    const node = new FakeElement(tag); node.className = classes; node.textContent = text;
    node.getBoundingClientRect = () => ({ width: node.width ?? node.children.filter(child => !child.hidden)
      .reduce((total, child, index) => total + child.getBoundingClientRect().width + (index ? 6 : 0), 0) });
    return node;
  };
  const context = { el, fitNotchTypeface() {}, getComputedStyle: () => ({ zoom: 1, gap: '6px' }) };
  vm.runInNewContext(source.slice(source.indexOf('function zoomForNotchText('), source.indexOf('function reportNotchSlots(')), context);
  const content = el('div', 'notch-slot-content');
  const field = el('span', 'notch-summary-field');
  const mark = el('span', 'edge-dock-mark'); mark.width = 17;
  const reading = el('span', 'notch-reading'); reading.width = 40;
  field.append(mark, reading); content.append(field);
  const primary = context.fitNotchSlot(content, 20);
  assert.equal(primary.minimum, 63, 'the icon and primary number are both reserved');
  assert.equal(field.hidden, true, 'an indivisible group cannot exceed the budget');
  const optional = el('div', 'notch-slot-content'); optional.dataset.notchOptional = 'true';
  optional.append(field);
  const overflow = el('span', 'notch-reading notch-overflow', '⋯'); overflow.width = 8;
  optional.append(overflow);
  const result = context.fitNotchSlot(optional, 20);
  assert.equal(result.minimum, 0);
  assert.equal(field.hidden, true, 'the whole group disappears, not just its reading');
  assert.equal(mark.hidden, undefined);
  assert.equal(overflow.hidden, false);
});


test('custom summary order never infers standalone icon ownership or removes same-ear separators', () => {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/notch/renderer.js'), 'utf8');
  const el = (tag, classes, text = '') => { const node = new FakeElement(tag); node.className = classes; node.textContent = text; return node; };
  const context = { el, trayTypographyApi: require('../../src/electron/renderer/trayTypography'), notchNumbers: new Map(),
    cancelAnimationFrame() {}, providerLabel: id => id, positionNotchSummary() {},
    notchIcon: item => el('span', 'edge-dock-mark', item.provider), notchText: (_item, row) => el('span', 'notch-text-run', row.text) };
  vm.runInNewContext(source.slice(source.indexOf('function allocateNotchSummary('), source.indexOf('function zoomForNotchText(')), context);
  const icon = provider => ({ type: 'icon', provider });
  const text = value => ({ type: 'text', text: value });
  const dot = { type: 'spacer', variant: 'dot' };
  const cases = [
    { items: [icon('codex'), icon('claude'), text('89%'), text('62%')], left: ['codex', 'claude', '89%'], right: ['62%'] },
    { items: [icon('codex'), text('89%'), icon('claude'), text('62%')], left: ['codex', '89%'], right: ['claude', '62%'] },
    { items: [text('51M'), dot, text('$1'), dot, text('62%')], left: ['51M'], right: ['$1', '·', '62%'] },
    { items: [text('89%'), icon('claude'), text('62%'), icon('codex')], left: ['89%'], right: ['claude', '62%', 'codex'] }
  ];
  for (const row of cases) for (const gapWidth of [179, 0]) {
    const head = context.notchSummary({ summary: { items: row.items }, geometry: { gapWidth }, appearance: {} });
    const left = head.find('notch-left').children[0], right = head.find('notch-right').children[0];
    const texts = node => [...node.walk()].map(n => n.textContent).filter(Boolean);
    const actual = [...texts(left), ...texts(right)];
    const expected = gapWidth ? [...row.left, ...row.right] : row.items.map(item => item.provider || item.text || '·');
    assert.deepEqual(actual, expected);
    assert.equal(left.find('notch-summary-field'), null, 'standalone icons do not become part of another field');
    if (gapWidth) { assert.deepEqual(texts(left), row.left); assert.deepEqual(texts(right), row.right); }
  }
});

test('primary reading survives extra standalone icons without inflating the minimum budget', () => {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/notch/renderer.js'), 'utf8');
  const el = (tag, classes, text = '') => {
    const node = new FakeElement(tag); node.className = classes; node.textContent = text;
    node.getBoundingClientRect = () => ({ width: node.width ?? node.children.filter(child => !child.hidden).reduce((sum, child, i) => sum + child.getBoundingClientRect().width + (i ? 6 : 0), 0) });
    return node;
  };
  const context = { el, fitNotchTypeface() {}, getComputedStyle: () => ({ zoom: 1, gap: '6px' }) };
  vm.runInNewContext(source.slice(source.indexOf('function zoomForNotchText('), source.indexOf('function reportNotchSlots(')), context);
  const content = el('div', 'notch-slot-content');
  const icons = Array.from({ length: 10 }, () => { const node = el('span', 'edge-dock-mark'); node.width = 17; return node; });
  const reading = el('span', 'notch-reading'); reading.width = 40; reading.dataset.notchPrimary = 'true';
  content.append(...icons, reading);
  const overflow = el('span', 'notch-reading notch-overflow', '⋯'); overflow.width = 8; content.append(overflow);
  const result = context.fitNotchSlot(content, 80);
  assert.equal(result.minimum, 40, 'only the primary reading sets the minimum');
  assert.equal(reading.hidden, false);
  assert.equal(icons.filter(node => !node.hidden).length, 1);
  assert.equal(overflow.hidden, false);
  assert.ok(result.width <= 80);
  context.fitNotchSlot(content, 40);
  assert.ok(icons.every(node => node.hidden));
  assert.equal(reading.hidden, false);
  assert.equal(overflow.hidden, true);
});


test('switching camera clearance rebuilds the same summary without losing configured separators', () => {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/notch/renderer.js'), 'utf8');
  const el = (tag, classes, text = '') => { const node = new FakeElement(tag); node.className = classes; node.textContent = text; return node; };
  const layer = el('div', 'content');
  layer.prepend = node => { node.parent = layer; layer.children.unshift(node); };
  const context = { el, contentLayer: layer, root: el('div', 'root'), state: { appearanceKey: 'unchanged' }, pluginHost: null,
    notchHeaderKey: '', notchClock: 0, notchNumbers: new Map(), trayTypographyApi: require('../../src/electron/renderer/trayTypography'),
    refreshVisit: 0, refreshFeedbackTimer: null, refreshBusy: false, refreshResult: '',
    clearTimeout() {}, cancelAnimationFrame() {}, settleNotchNumbers() {}, panel: { suspend() {} }, settleNotchStatNumbers() {}, resetRefreshVisit() {}, paintRefreshButton() {}, captureRingResetMotion() {}, animateRingResets() {},
    notchSummaryObserver: { disconnect() {}, observe() {} }, providerLabel: id => id, positionNotchSummary() {},
    notchIcon: item => el('span', 'edge-dock-mark', item.provider), notchText: (_item, row) => el('span', 'notch-text-run', row.text) };
  const summarySource = source.slice(source.indexOf('function allocateNotchSummary('), source.indexOf('function zoomForNotchText('));
  const renderSource = source.slice(source.indexOf('function renderNotch('), source.indexOf('  const summary = contentLayer.querySelector', source.indexOf('function renderNotch(')));
  vm.runInNewContext(`${summarySource}\n${renderSource}\n}`, context);
  const payload = { summary: { items: [{ type: 'icon', provider: 'codex' }, { type: 'text', text: '51M' },
    { type: 'spacer', variant: 'dot' }, { type: 'text', text: '$1' }] }, appearance: {}, geometry: { notched: true, gapWidth: 179 } };
  context.renderNotch(payload);
  const attached = layer.find('notch-summary');
  assert.equal(attached.find('notch-left').text, 'codex 51M');
  assert.equal(attached.find('notch-right').text, '$1');
  context.renderNotch({ ...payload, geometry: { notched: false, gapWidth: 0 } });
  const pill = layer.find('notch-summary');
  assert.notEqual(pill, attached);
  assert.equal(pill.find('notch-left').text, 'codex');
  assert.equal(pill.find('notch-right').text, '51M · $1');
  context.renderNotch({ ...payload, geometry: { notched: true, gapWidth: 0 } });
  assert.equal(layer.find('notch-summary'), pill, 'camera-free outlines share the compact grouping');
  context.renderNotch(payload);
  assert.notEqual(layer.find('notch-summary'), pill);
  assert.equal(layer.find('notch-right').text, '$1');
});


test('summary text ellipsis preserves the full value and restores within a larger budget', () => {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/notch/renderer.js'), 'utf8');
  for (const zoom of [1, 1.25]) {
    const el = (tag, classes, text = '') => {
      const node = new FakeElement(tag); node.className = classes; node.textContent = text;
      node.getBoundingClientRect = () => {
        const width = node.width ?? (node.classList.contains('notch-overflow') ? (node.textContent === '…' && /12px/.test(node.style.font || '') ? 12 : 8) : node.children.filter(child => !child.hidden)
          .reduce((total, child, index) => total + child.getBoundingClientRect().width + (index ? 6 : 0), 0));
        const maximum = parseFloat(node.style.maxWidth);
        return { width: Number.isFinite(maximum) ? Math.min(width, maximum * zoom) : width };
      };
      return node;
    };
    const context = { el, fitNotchTypeface() {}, getComputedStyle: () => ({ zoom, gap: '6px', font: '', fontStyle: 'normal', fontWeight: '500', fontSize: '12px', fontFamily: 'sans-serif' }) };
    vm.runInNewContext(source.slice(source.indexOf('function zoomForNotchText('), source.indexOf('function reportNotchSlots(')), context);
    const content = el('div', 'notch-slot-content');
    const reading = el('span', 'notch-reading');
    const run = el('span', 'notch-text-run', 'HK$7557194.97'); run.width = 100;
    run.dataset.horizontalScale = '1'; run.closest = () => content;
    reading.append(run); content.append(reading);
    const fitted = context.fitNotchSlot(content, 40);
    assert.equal(fitted.width, 40);
    assert.equal(run.style.maxWidth, `${40 / zoom}px`);
    assert.equal(run.textContent, 'HK$7557194.97');
    assert.equal(content.querySelector('.notch-overflow').hidden, true, 'native text ellipsis needs no second marker');
    context.fitNotchSlot(content, 8);
    assert.equal(reading.hidden, true, 'too little space for the text ellipsis cannot leave a partial glyph');
    assert.equal(content.querySelector('.notch-overflow').hidden, false);
    context.fitNotchSlot(content, 0);
    assert.equal(reading.hidden, true);
    const restored = context.fitNotchSlot(content, 200);
    assert.equal(restored.width, 100);
    assert.equal(run.style.maxWidth, 'none');
    assert.equal(reading.hidden, false);
    assert.equal(run.textContent, 'HK$7557194.97');
  }
});

test('summary overflow marks omitted content, not removed spacing', () => {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/notch/renderer.js'), 'utf8');
  const context = {};
  vm.runInNewContext(source.slice(source.indexOf('function fitNotchSummaryItems('), source.indexOf('function fitNotchSlot(')), context);
  const reading = { width: 35, minimum: 35, spacer: false };
  const spacer = { width: 4, minimum: 4, spacer: true };
  const cases = [
    { name: 'trailing decoration', items: [reading, spacer], budget: Infinity, visible: [0], overflow: false },
    { name: 'spacing only', items: [spacer, spacer], budget: Infinity, visible: [], overflow: false },
    { name: 'decoration exceeds clearance', items: [reading, spacer], budget: 40, visible: [0], overflow: false },
    { name: 'optional trailing decoration', items: [reading, spacer], budget: 80, optional: true, visible: [0], overflow: false },
    { name: 'optional spacing only', items: [spacer], budget: 80, optional: true, visible: [], overflow: false },
    { name: 'internal separator remains', items: [reading, spacer, reading], budget: 100, visible: [0, 1, 2], overflow: false },
    { name: 'omitted reading', items: [reading, spacer, reading], budget: 60, visible: [0], overflow: true },
    { name: 'omitted icon beside primary', items: [{ width: 17, minimum: 17, spacer: false }, reading], budget: 50, primary: 1, visible: [1], overflow: true }
  ];
  for (const row of cases) {
    const fitted = context.fitNotchSummaryItems(row.items, { budget: row.budget, gap: 6, overflowWidth: 8, primary: row.primary ?? -1, optional: row.optional === true });
    assert.deepEqual(Array.from(fitted.visible), row.visible, row.name);
    assert.equal(fitted.overflow, row.overflow, row.name);
  }
});

test('summary allocation and width fitting need only ordered items and measured widths', () => {
  const source = fs.readFileSync(path.join(root, 'src/electron/renderer/notch/renderer.js'), 'utf8');
  const context = {};
  vm.runInNewContext(source.slice(source.indexOf('function allocateNotchSummary('), source.indexOf('function notchSummary(')), context);
  vm.runInNewContext(source.slice(source.indexOf('function fitNotchSummaryItems('), source.indexOf('function fitNotchSlot(')), context);
  const types = ['icon', 'text', 'spacer', 'icon', 'stack', 'spacer', 'text'];
  const items = Object.freeze(types.map(type => Object.freeze({ type })));
  const plan = context.allocateNotchSummary(items, true);
  assert.deepEqual(Array.from(plan.left), [0, 1]);
  assert.deepEqual(Array.from(plan.right), [3, 4, 5, 6], 'only the camera split loses its separator');
  assert.equal(plan.primary, 1);
  const compact = context.allocateNotchSummary(items, false);
  assert.deepEqual([...compact.left, ...compact.right], items.map((_item, index) => index));
  assert.equal(compact.primary, null);
  const widths = Object.freeze([
    Object.freeze({ width: 17, minimum: 17, spacer: false }),
    Object.freeze({ width: 40, minimum: 40, spacer: false })
  ]);
  const fitted = context.fitNotchSummaryItems(widths, { budget: 40, gap: 6, overflowWidth: 8, primary: 1 });
  assert.deepEqual(Array.from(fitted.visible), [1], 'the reading survives when its independent icon does not fit');
  assert.equal(fitted.minimum, 40);
  assert.equal(fitted.overflow, false);
  const embedded = context.fitNotchSummaryItems([{ width: 63, minimum: 63, spacer: false }],
    { budget: 40, gap: 6, overflowWidth: 8, primary: 0 });
  assert.deepEqual(Array.from(embedded.visible), [], 'an indivisible item cannot exceed the budget');
  assert.equal(embedded.minimum, 63);
  const hidden = context.fitNotchSummaryItems(widths, { budget: 0, gap: 6, overflowWidth: 8, optional: true });
  assert.deepEqual(Array.from(hidden.visible), []);
  assert.equal(hidden.overflow, false, 'unknown or occupied clearance admits no optional overflow');
});
