'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const trayLayoutApi = require('../../src/shared/trayLayout');
const {
  accountModeSourcePatch,
  duplicateTrayLayoutItem,
  moveTrayLayoutItemByKey,
  periodItemPatch,
  syncTrayComposerSurfaces
} = require('../../src/electron/renderer/trayComposer');

function layoutWithIds(...ids) {
  return {
    version: trayLayoutApi.VERSION,
    items: ids.map((id) => {
      const item = trayLayoutApi.createTrayLayoutItem('tokens', { idFactory: () => id });
      if (id !== 'selected') return item;
      return {
        ...item,
        fontStyle: 'compactMono',
        period: 'month',
        source: {
          provider: 'claude',
          accountMode: 'specific',
          accountKey: 'team',
          window: 'weekly',
          valueMode: 'used'
        }
      };
    })
  };
}

test('duplicating an item copies its configuration under a fresh id', () => {
  const layout = layoutWithIds('first', 'selected', 'last');
  const duplicated = duplicateTrayLayoutItem(trayLayoutApi, layout, 'selected', {
    idFactory: () => 'duplicate'
  });

  assert.deepEqual(duplicated.items.map((item) => item.id), [
    'first',
    'selected',
    'last',
    'duplicate'
  ]);
  const selected = trayLayoutApi.normalizeTrayLayout(layout).items[1];
  assert.deepEqual(duplicated.items.at(-1), {
    ...selected,
    id: 'duplicate'
  });
});

test('duplicating at the item limit leaves every configured item unchanged', () => {
  const ids = Array.from({ length: trayLayoutApi.MAX_ITEMS }, (_, index) => (
    index === trayLayoutApi.MAX_ITEMS - 1 ? 'selected' : `item-${index}`
  ));
  const layout = layoutWithIds(...ids);
  const before = structuredClone(layout);
  const duplicated = duplicateTrayLayoutItem(trayLayoutApi, layout, 'selected');

  assert.deepEqual(duplicated, before);
  assert.equal(duplicated.items.at(-1).id, 'selected');
  assert.equal(duplicated.items.at(-1).period, 'month');
});

test('choosing a specific account commits the account shown by the picker immediately', () => {
  const accounts = [
    { value: 'personal', label: 'personal@example.com' },
    { value: 'team', label: 'Team' }
  ];
  assert.deepEqual(
    accountModeSourcePatch({ accountKey: '', window: 'secondary' }, accounts, 'specific'),
    { accountMode: 'specific', accountKey: 'personal', window: 'primary' }
  );
  assert.deepEqual(
    accountModeSourcePatch({ accountKey: 'team', window: 'weekly' }, accounts, 'specific'),
    { accountMode: 'specific', accountKey: 'team', window: 'primary' }
  );
  assert.deepEqual(
    accountModeSourcePatch({ accountKey: 'team', window: 'weekly' }, accounts, 'lowest'),
    { accountMode: 'lowest', accountKey: '', window: 'weekly' }
  );
});

test('period updates target the item for single text and the source for stacked text', () => {
  const single = trayLayoutApi.createTrayLayoutItem('tokens', { idFactory: () => 'single' });
  const stacked = trayLayoutApi.createTrayLayoutItem('doubleInfo', { idFactory: () => 'stacked' });

  const singleUpdated = periodItemPatch(single, 0, 'month');
  assert.equal(singleUpdated.period, 'month');
  assert.equal(singleUpdated.source.period, undefined);

  const stackedUpdated = periodItemPatch(stacked, 1, 'allTime');
  assert.equal(stackedUpdated.rows[0].period, 'today');
  assert.equal(stackedUpdated.rows[1].period, 'allTime');
});

test('keyboard movement returns the reordered layout and respects boundaries', () => {
  const layout = layoutWithIds('first', 'selected', 'last');
  const moved = moveTrayLayoutItemByKey(trayLayoutApi, layout, 'selected', 'ArrowRight');

  assert.equal(moved.moved, true);
  assert.deepEqual(moved.layout.items.map((item) => item.id), ['first', 'last', 'selected']);

  const boundary = moveTrayLayoutItemByKey(trayLayoutApi, moved.layout, 'selected', 'ArrowRight');
  assert.equal(boundary.moved, false);
  assert.deepEqual(boundary.layout, moved.layout);
});

test('composer visibility destroys hidden surfaces and creates newly visible surfaces', () => {
  const toggles = [];
  const destroyed = [];
  const composers = {
    tray: { destroy: () => destroyed.push('tray') }
  };
  const surfaces = [
    {
      id: 'tray',
      visible: false,
      root: { classList: { toggle: (...args) => toggles.push(['tray', ...args]) } }
    },
    {
      id: 'floatingBubble',
      visible: true,
      root: { classList: { toggle: (...args) => toggles.push(['floatingBubble', ...args]) } }
    }
  ];

  const clockNeeded = syncTrayComposerSurfaces(
    surfaces,
    composers,
    (id) => ({ id, destroy() {} })
  );

  assert.equal(clockNeeded, true);
  assert.deepEqual(destroyed, ['tray']);
  assert.equal('tray' in composers, false);
  assert.equal(composers.floatingBubble.id, 'floatingBubble');
  assert.deepEqual(toggles, [
    ['tray', 'hidden', true],
    ['floatingBubble', 'hidden', false]
  ]);
});

const balanceStats = {
  periods: { today: {}, month: {}, allTime: {} },
  limits: {
    providers: [{
      provider: 'deepseek',
      accountKey: 'ds1',
      accountLabel: 'Pay-as-you-go',
      status: 'ok',
      stale: false,
      windows: [{
        kind: 'billing',
        metric: 'credits',
        label: 'Balance',
        remaining: 4,
        currency: 'CNY',
        showMeter: true
      }],
      balance: { amount: 4, currency: 'CNY', monthSpend: 6 }
    }]
  }
};

function balanceSource() {
  return {
    provider: 'deepseek',
    accountMode: 'lowest',
    accountKey: '',
    window: 'primary',
    valueMode: 'remaining'
  };
}

test('a balance-only provider is offered in the tray window picker', () => {
  const options = trayLayoutApi.windowOptions(balanceStats, 'deepseek');
  assert.equal(options.length, 1);
  assert.equal(options[0].kind, 'billing');
  assert.equal(options[0].label, 'Balance');
});

test('a tray percent item prints a balance as compact money', () => {
  const resolved = trayLayoutApi.resolveTrayLayout({
    version: trayLayoutApi.VERSION,
    items: [{ id: 'a', type: 'text', metric: 'percent', source: balanceSource() }]
  }, balanceStats, {});

  assert.equal(resolved.items[0].available, true);
  assert.equal(resolved.items[0].text, '¥4.00');
});

test('a tray bar item meters a balance against its derived percentage', () => {
  const resolved = trayLayoutApi.resolveTrayLayout({
    version: trayLayoutApi.VERSION,
    items: [{ id: 'a', type: 'bars', rows: [balanceSource()] }]
  }, balanceStats, {});

  // 4 / (4 + 6) = 40%
  assert.equal(resolved.items[0].rows[0].percent, 40);
});

test('a balance selection carries resolved percentages so tray icons never fabricate 0%', () => {
  const { compactLimitSelection, pickConfiguredLimitProviders } = require('../../src/shared/trayText');

  const provider = balanceStats.limits.providers[0];
  const selection = compactLimitSelection(provider);
  // 4 / (4 + 6) = 40% — the raw window carries no percentage at all.
  assert.equal(selection.primaryWindow.remainingPercent, undefined);
  assert.equal(selection.primaryPercent, 40);
  assert.equal(selection.secondaryPercent, null);

  const [pick] = pickConfiguredLimitProviders(balanceStats, {});
  assert.equal(pick.percent, 40);
});
