'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const trayLayoutApi = require('../../src/shared/trayLayout');
const {
  duplicateTrayLayoutItem,
  moveTrayLayoutItemByKey,
  syncTrayComposerSurfaces
} = require('../../src/electron/renderer/trayComposer');

function layoutWithIds(...ids) {
  return {
    version: trayLayoutApi.VERSION,
    items: ids.map((id) => ({
      ...trayLayoutApi.createTrayLayoutItem('tokens', { idFactory: () => id }),
      period: id === 'selected' ? 'month' : 'today'
    }))
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
  assert.equal(duplicated.items.at(-1).style, 'tokens');
  assert.equal(duplicated.items.at(-1).period, 'month');
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
