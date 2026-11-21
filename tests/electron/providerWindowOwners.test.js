'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, Module } = require('node:module');
const { Element } = require('../helpers/notchPanel');
const renderer = path.resolve(__dirname, '../../src/electron/renderer');
const registry = require('../../src/electron/renderer/limits/windowOwners');

function snapshot(node) {
  return { tag: node.tagName || '#text', text: node.textContent,
    classes: node.className || '', attributes: { ...node.attributes }, dataset: { ...node.dataset },
    style: Object.fromEntries(Object.entries(node.style || {}).filter(([, value]) => typeof value !== 'function')),
    children: (node.children || []).map(snapshot) };
}

function fixture(createLimitWindowsView, appearance = {}) {
  const balance = require('../../src/shared/limits/balanceDisplay');
  const labels = require('../../src/shared/limits/windowLabels');
  const document = { createElement: tag => new Element(tag), createTextNode: text => {
    const node = new Element('#text'); node.textContent = text; return node;
  }};
  return createLimitWindowsView({ document,
    t: (key, params) => require('../../src/electron/renderer/i18n').translate('en', key, params),
    settings: () => appearance, currentLocale: () => 'en-US',
    presentation: require('../../src/electron/renderer/limits/providerPresentation'),
    motion: require('../../src/electron/renderer/limits/resetMotion'),
    tooltip: { hasOpened: () => false, markOpened() {}, release() {} },
    formatCompact: String, compactTokenThreshold: () => 1000,
    formatMoney: balance.formatMoney, formatCompactMoney: balance.formatMoney,
    formatPercent: value => Math.round(value) + '%', formatDuration: String,
    formatLimitBoundary: require('../../src/electron/renderer/limits/providerPresentation').limitBoundaryText,
    ...require('../../src/electron/renderer/limits/displayMode'),
    optionalFiniteNumber: value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null,
    colorWithAlpha: String, applyBarScale: (node, value) => node.style.setProperty('--bar-scale', String(value)),
    ...balance, ...labels, limitWindowText: require('../../src/shared/limits/windowText').limitWindowText,
    accountIdentity: require('../../src/electron/renderer/accountIdentity'), provenanceContext: () => ({}),
    accountControl: { render: options => options.titleNode },
    codexAccounts: { matchesActive: () => false, switchTarget: () => null, canSwitchSystemAccount: () => false },
    hasMark: () => true, formatAgo: String, openExternal() {},
    subscriptionApi: require('../../src/shared/subscriptionDisplay'),
    subscriptionText: require('../../src/shared/subscriptionText'), currencyApi: require('../../src/shared/currency'),
    formatCost: String, subscriptions: () => [], subscriptionAccounts: () => appearance.accounts || [], monthClientCosts: () => ({})
  });
}
const createView = require('../../src/electron/renderer/limits/windowsView').createLimitWindowsView;

function records(id) {
  const quota = kind => ({ kind, usedPercent: 20, remainingPercent: 80, resetsAt: '2099-01-01T00:00:00Z' });
  return [
    { provider: id, status: 'ok', windows: [] },
    { provider: id, status: 'ok', accountKey: 'one', accountEmail: 'one@example.com', updatedAt: '2026-11-17T00:00:00Z',
      windows: [quota('session'), quota('weekly'), quota('billing')] },
    { provider: id, status: 'ok', accountKey: 'one', accountLabel: 'Plan', source: 'api',
      windows: [{ kind: 'billing', metric: 'credits', label: 'Credits', remaining: 80, limit: 100, used: 20, currency: 'USD', resetDescription: id === 'muse' ? '2K tokens left' : '' }],
      balance: { amount: 80, currency: 'USD', todaySpend: 1, weekSpend: 3, monthSpend: 20, allTimeSpend: 40 },
      usageSummary: { period: 'month', totalTokens: 100, inputTokens: 80, outputTokens: 20, requests: 1 }
    }
  ];
}

test('provider window owners load as plain scripts with the same registrations as Node', () => {
  const context = vm.createContext({});
  const registration = fs.readFileSync(path.join(renderer, 'limits/windowOwners.js'), 'utf8');
  const ids = [...registration.matchAll(/require\('..\/providers\/([^/]+)\/windows'\)/g)].map(match => match[1]);
  for (const id of ids) vm.runInContext(fs.readFileSync(path.join(renderer, 'providers', id, 'windows.js'), 'utf8'), context);
  vm.runInContext(registration, context);
  const browser = context.TokenMonitorLimitWindowOwners.createOwners({});
  const node = registry.createOwners({});
  assert.deepEqual(Object.keys(browser), Object.keys(node));
  for (const id of Object.keys(node)) assert.deepEqual(Object.keys(browser[id]), Object.keys(node[id]));
  assert.equal(node.trae.rowPolicy, undefined, 'card reuse must not inherit WorkBuddy account policy');
});

test('all provider cards render retained records without changing their input', () => {
  const view = fixture(createView);
  for (const id of [...Object.keys(registry.createOwners({})), 'generic', 'plugin:fixture:quota']) {
    for (const record of records(id)) {
      const before = JSON.stringify(record);
      assert.ok(view.renderProviderWindows(record, '#fff'));
      assert.equal(JSON.stringify(record), before, id);
    }
  }
});

test('provider groups preserve identity, order, and shared frames', () => {
  const view = fixture(createView);
  for (const id of ['mimo', 'minimax', 'codex', 'workbuddy', 'thirdparty', 'muse']) {
    const first = { ...records(id)[1], source: 'oauth', region: 'cn', accountName: 'First' };
    const second = { ...first, source: 'api', accountKey: 'two', accountName: 'Second', accountEmail: 'two@example.com' };
    const row = view.renderLimitProviderGroup(id, id, [first, second], '#fff');
    assert.ok(row);
    assert.ok(row.classList.contains('limit-row'));
    const accountRows = [];
    const visit = node => {
      if (node.classList.contains('limit-account-row') && node.dataset.limitMotionKey) accountRows.push(node);
      for (const child of node.children) visit(child);
    };
    visit(row);
    const { providerKey } = require('../../src/electron/renderer/limits/resetMotion');
    assert.deepEqual(accountRows.map(child => child.dataset.limitMotionKey), [first, second].map(providerKey), id);
  }
});

test('Codex solo and grouped rows each render one enabled forecast', () => {
  const view = fixture(createView, { codexResetForecastEnabled: true });
  const first = records('codex')[1];
  const second = { ...first, accountKey: 'two', accountEmail: 'two@example.com' };
  const solo = view.renderLimitProviderSolo('codex', 'Codex', first, '#fff');
  const grouped = view.renderLimitProviderGroup('codex', 'Codex', [first, second], '#fff');
  const forecastCount = node => Number(node.classList.contains('codex-reset-forecast'))
    + node.children.reduce((count, child) => count + forecastCount(child), 0);
  assert.equal(forecastCount(solo), 1);
  assert.equal(forecastCount(grouped), 1);
});

test('optional migration evidence compares original and owner DOM snapshots', { skip: !process.env.WINDOWS_OWNER_BASELINE }, () => {
  const filename = path.join(renderer, 'limits/windowsView.js');
  const baselineModule = new Module(filename);
  baselineModule.filename = filename;
  baselineModule.paths = module.paths;
  baselineModule.require = createRequire(filename);
  baselineModule._compile(fs.readFileSync(process.env.WINDOWS_OWNER_BASELINE, 'utf8'), filename);
  let count = 0;
  for (const appearance of [{}, { showLimitUsed: true }, { showAllUsageItems: true }, { limitProviderHiddenItems: { codex: ['weekly'], minimax: ['weekly'] } }]) {
    const before = fixture(baselineModule.exports.createLimitWindowsView, appearance);
    const after = fixture(createView, appearance);
    for (const id of [...Object.keys(registry.createOwners({})), 'generic', 'plugin:fixture:quota']) {
      for (const record of records(id)) {
        assert.deepEqual(snapshot(after.renderProviderWindows(record, '#fff', appearance)), snapshot(before.renderProviderWindows(record, '#fff', appearance)), id);
        count++;
      }
    }
    for (const id of ['codex', 'mimo', 'minimax', 'workbuddy', 'muse', 'thirdparty']) {
      const rows = [records(id)[1], { ...records(id)[1], accountKey: 'two', accountEmail: 'two@example.com' }];
      assert.deepEqual(snapshot(after.renderLimitProviderGroup(id, id, rows, '#fff')), snapshot(before.renderLimitProviderGroup(id, id, rows, '#fff')), id + ' group');
      count++;
    }
  }
  console.log('Identical before/after DOM snapshots:', count);
});
