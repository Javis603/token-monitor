'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const trayLayoutApi = require('../../src/shared/trayLayout');
const {
  accountModeSourcePatch,
  costDisplayPatch,
  createTrayComposer,
  duplicateTrayLayoutItem,
  handlePickerDocumentScroll,
  moveTrayLayoutItemByKey,
  periodItemPatch,
  syncTrayComposerSurfaces,
  usageScopePatch
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

test('cost display updates target a single item or one mixed-information row', () => {
  const single = trayLayoutApi.createTrayLayoutItem('cost', { idFactory: () => 'single-cost' });
  const singleUpdated = costDisplayPatch(single, 0, { costFormat: 'full', costDecimals: 'auto' });
  assert.equal(singleUpdated.costFormat, 'full');
  assert.equal(singleUpdated.costDecimals, 'auto');
  assert.equal(singleUpdated.source.costFormat, undefined);

  const stacked = trayLayoutApi.createTrayLayoutItem('doubleInfo', { idFactory: () => 'stacked-cost' });
  const stackedUpdated = costDisplayPatch(stacked, 1, { costFormat: 'compact', costDecimals: 3 });
  assert.equal(stackedUpdated.rows[0].costFormat, undefined);
  assert.equal(stackedUpdated.rows[1].costFormat, 'compact');
  assert.equal(stackedUpdated.rows[1].costDecimals, 3);

  const normalized = trayLayoutApi.normalizeTrayLayout({
    version: trayLayoutApi.VERSION,
    items: [{ ...stackedUpdated, rows: [stackedUpdated.rows[0], { ...stackedUpdated.rows[1], metric: 'cost' }] }]
  });
  assert.equal(normalized.items[0].rows[1].costFormat, 'compact');
  assert.equal(normalized.items[0].rows[1].costDecimals, 3);
});

test('usage source updates target a single item or one mixed-information row', () => {
  const single = trayLayoutApi.createTrayLayoutItem('tokens', { idFactory: () => 'single-tokens' });
  const singleUpdated = usageScopePatch(single, 0, 'recent');
  assert.equal(singleUpdated.usageScope, 'recent');
  assert.equal(singleUpdated.source.usageScope, undefined);

  const stacked = trayLayoutApi.createTrayLayoutItem('doubleInfo', { idFactory: () => 'stacked-tokens' });
  const stackedUpdated = usageScopePatch(stacked, 1, 'recent');
  assert.equal(stackedUpdated.rows[0].usageScope, undefined);
  assert.equal(stackedUpdated.rows[1].usageScope, 'recent');

  const normalized = trayLayoutApi.normalizeTrayLayout({
    version: trayLayoutApi.VERSION,
    items: [{ ...stackedUpdated, rows: [stackedUpdated.rows[0], { ...stackedUpdated.rows[1], metric: 'tokens' }] }]
  });
  assert.equal(normalized.items[0].rows[1].usageScope, 'recent');
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

test('an open picker follows outer scroll updates while its trigger stays connected', () => {
  const menu = { contains: (target) => target === 'menu-scroll' };
  const connected = {
    menu,
    owner: { isConnected: true },
    trigger: { isConnected: true }
  };
  const calls = [];
  const actions = {
    close: () => calls.push('close'),
    reposition: () => calls.push('reposition')
  };

  assert.equal(handlePickerDocumentScroll(connected, 'menu-scroll', actions), 'ignore');
  assert.deepEqual(calls, []);
  assert.equal(handlePickerDocumentScroll(connected, 'settings-scroll', actions), 'reposition');
  assert.deepEqual(calls, ['reposition']);
  assert.equal(
    handlePickerDocumentScroll(
      { ...connected, trigger: { isConnected: false } },
      'settings-scroll',
      actions
    ),
    'close'
  );
  assert.deepEqual(calls, ['reposition', 'close']);
  assert.equal(
    handlePickerDocumentScroll(
      { ...connected, owner: { isConnected: false } },
      'settings-scroll',
      actions
    ),
    'close'
  );
  assert.deepEqual(calls, ['reposition', 'close', 'close']);
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

// The read-only preview path of render() only touches a handful of DOM APIs, so
// a shim covers it without pulling in a headless-browser dependency.
function fakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    src: '',
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    clickHandlers: []
  };
  const classes = () => el.className.split(' ').filter(Boolean);
  el.classList = {
    add: (...names) => { el.className = [...new Set([...classes(), ...names])].join(' '); },
    remove: (...names) => { el.className = classes().filter((name) => !names.includes(name)).join(' '); },
    contains: (name) => classes().includes(name),
    toggle: (name, force) => {
      const on = force === undefined ? !el.classList.contains(name) : Boolean(force);
      if (on) el.classList.add(name);
      else el.classList.remove(name);
    }
  };
  el.append = (...nodes) => { el.children.push(...nodes); };
  el.replaceChildren = (...nodes) => { el.children = [...nodes]; };
  el.setAttribute = (name, value) => { el.attributes[name] = value; };
  el.addEventListener = (type, handler) => { if (type === 'click') el.clickHandlers.push(handler); };
  el.querySelector = () => null;
  return el;
}

function renderComposer({ preview = {}, editable = false, onCustomize = () => {} }) {
  const saved = { document: global.document, window: global.window, Image: global.Image };
  global.document = { createElement: (tag) => fakeElement(tag) };
  global.window = { addEventListener() {}, removeEventListener() {} };
  global.Image = function FakeImage() { return fakeElement('img'); };
  const root = fakeElement('div');
  try {
    createTrayComposer({
      root,
      surface: 'tray',
      layoutApi: trayLayoutApi,
      getLayout: () => layoutWithIds(),
      getPreview: () => preview,
      isEditable: () => editable,
      onCustomize,
      onLayoutChange() {},
      label: (key) => key
    });
  } finally {
    global.document = saved.document;
    global.window = saved.window;
    global.Image = saved.Image;
  }
  const [heading, strip] = root.children;
  return { root, heading, strip, content: strip.children[0].children[0] };
}

test('a non-custom surface previews the real tray image behind a Customize button', () => {
  const { root, heading, strip, content } = renderComposer({
    preview: { generatedSrc: 'data:image/png;base64,GENERATED' }
  });

  assert.equal(heading.children[0].textContent, 'Live preview');
  assert.equal(heading.children[1].tagName, 'BUTTON');
  assert.equal(heading.children[1].textContent, 'Customize…');
  assert.equal(root.classList.contains('is-editing'), false);
  // No add button: nothing on this surface is editable yet.
  assert.equal(strip.children.length, 1);

  assert.equal(content.classList.contains('is-menubar'), true);
  assert.equal(content.children[0].className, 'tray-composer-menubar-generated');
  assert.equal(content.children[0].src, 'data:image/png;base64,GENERATED');
});

test('the preview falls back from a rendered image to text to the app mark', () => {
  const image = renderComposer({ preview: { src: 'data:image/png;base64,PLAIN' } });
  assert.equal(image.content.classList.contains('is-menubar'), false);
  assert.equal(image.content.children[0].className, 'tray-composer-preview-image');
  assert.equal(image.content.children[0].src, 'data:image/png;base64,PLAIN');

  const text = renderComposer({ preview: { text: '24.9M' } });
  assert.equal(text.content.classList.contains('is-text'), true);
  assert.equal(text.content.textContent, '24.9M');

  const empty = renderComposer({ preview: {} });
  assert.equal(empty.content.textContent, 'Σ');
});

test('Customize hands the surface back to the editor', () => {
  let customized = 0;
  const { heading } = renderComposer({ onCustomize: () => { customized += 1; } });

  heading.children[1].clickHandlers.forEach((handler) => handler());
  assert.equal(customized, 1);
});

test('a custom surface keeps the editor affordances instead of a preview', () => {
  const { root, heading, strip } = renderComposer({
    editable: true,
    preview: { generatedSrc: 'data:image/png;base64,GENERATED' }
  });

  assert.equal(heading.children[1].textContent, 'Drag to reorder · Click to configure');
  assert.equal(root.classList.contains('is-editing'), true);
  assert.equal(strip.children.at(-1).className, 'tray-composer-add');
  assert.equal(strip.children[0].children[0].textContent, 'Add your first item');
});

// A capture listener on `window` sees every element's blur, not just the
// window's. The press moves focus off whatever was clicked last, so the chip
// drag died on its own first pointerdown whenever a control still held focus.
test('only the window own blur cancels the chip drag', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'trayComposer.js'),
    'utf8'
  );
  assert.match(source, /window\.addEventListener\('blur', cancelDrag\);/);
  assert.match(source, /window\.removeEventListener\('blur', cancelDrag\);/);
  assert.doesNotMatch(source, /'blur', cancelDrag, true/);
});
