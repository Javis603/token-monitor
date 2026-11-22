'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const displaySettingsApi = require('../../src/electron/renderer/displaySettings');
const { createEdgeDockComposer } = require('../../src/electron/renderer/edgeDock/composer');
const itemsApi = require('../../src/electron/renderer/edgeDock/items');
const { MESSAGES, LANGUAGE_OPTIONS, translate } = require('../../src/electron/renderer/i18n');

class FakeElement {
  constructor(tagName = 'div', id = '', className = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.className = className;
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.hidden = false;
    this.checked = false;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.tabIndex = 0;
    this.selectedOptions = [];
    const tokens = () => new Set(String(this.className || '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...names) => { const s = tokens(); names.forEach((n) => s.add(n)); this.className = [...s].join(' '); },
      remove: (...names) => { const s = tokens(); names.forEach((n) => s.delete(n)); this.className = [...s].join(' '); },
      toggle: (name, force) => {
        const s = tokens();
        const next = force === undefined ? !s.has(name) : Boolean(force);
        if (next) s.add(name); else s.delete(name);
        this.className = [...s].join(' ');
        return next;
      },
      contains: (name) => tokens().has(name)
    };
  }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  get firstChild() { return this.children[0] || null; }
  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      if (node.parent) {
        const idx = node.parent.children.indexOf(node);
        if (idx >= 0) node.parent.children.splice(idx, 1);
      }
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  focus() { if (this._doc) this._doc.activeElement = this; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector === '[data-i18n]') return Boolean(this.dataset.i18n);
    if (selector === '[data-reset-setting]') return Boolean(this.dataset.resetSetting);
    return false;
  }
  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parent;
    }
    return null;
  }
  querySelector(selector) {
    if (selector.startsWith(':scope > ')) {
      const sub = selector.slice(':scope > '.length);
      return this.children.find((child) => child.matches(sub)) || null;
    }
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    for (const child of this.children) {
      if (child.matches(selector)) out.push(child);
      out.push(...child.querySelectorAll(selector));
    }
    return out;
  }
}

function createWindowSettingsFixture({ platform = 'darwin', prefs = {} } = {}) {
  const byId = new Map();
  const doc = {
    activeElement: null,
    createElement(tag) {
      const node = new FakeElement(tag);
      node._doc = doc;
      return node;
    },
    getElementById(id) { return byId.get(id) || null; }
  };
  const reg = (tag, id = '', className = '') => {
    const node = new FakeElement(tag, id, className);
    node._doc = doc;
    if (id) byId.set(id, node);
    return node;
  };
  const itemWith = (child) => {
    const row = reg('div', '', 'settings-item');
    row.append(child);
    return row;
  };

  const sectionDetails = reg('div', 'windowSettingsDetails', 'settings-section-details');
  const root = reg('div', '', 'settings-section-details-inner');
  sectionDetails.append(root);
  const scrollPanel = reg('div', 'settingsPanel');

  const mainGroup = reg('div', '', 'settings-subgroup settings-window-group');
  const windowBehaviorInput = reg('select', 'windowBehaviorInput');
  mainGroup.append(itemWith(windowBehaviorInput));

  const presenceGroup = reg('div', '', 'settings-subgroup settings-presence-group');

  // Edge Dock
  const edgeDockLabel = reg('label', '', 'checkbox-label settings-item');
  const edgeDockInput = reg('input', 'edgeDockInput');
  const edgeDockResetHeading = reg('span');
  edgeDockResetHeading.dataset.resetSetting = 'edgeDockEnabled';
  edgeDockLabel.append(edgeDockResetHeading, edgeDockInput);
  const edgeDockOptions = reg('div', 'edgeDockOptions');
  edgeDockOptions.append(
    itemWith(reg('span', 'edgeDockModeLabel')),
    reg('div', 'edgeDockTriggerRangeRow', 'settings-item hidden'),
    itemWith(reg('span', 'edgeDockSideLabel')),
    itemWith(reg('span', 'edgeDockSizeLabel')),
    reg('div', 'edgeDockCustomScaleRow', 'settings-item'),
    itemWith(reg('span', 'edgeDockBubbleSizeLabel')),
    reg('div', 'edgeDockBubbleCustomScaleRow', 'settings-item')
  );
  const edgeMore = reg('div', 'edgeDockMoreOptionsGroup');
  const edgeMoreDetails = reg('div', 'edgeDockMoreOptionsDetails', 'cursor-settings-details');
  edgeMoreDetails.append(
    reg('label', 'edgeDockWindowsBackdropRow', 'settings-item'),
    reg('label', 'edgeDockMacBackdropRow', 'settings-item'),
    itemWith(reg('input', 'edgeDockWarnColorsInput')),
    itemWith(reg('input', 'edgeDockRunningIndicatorInput')),
    reg('label', 'edgeDockHapticRow', 'settings-item')
  );
  edgeMore.append(edgeMoreDetails);
  edgeDockOptions.append(edgeMore);
  const edgeComposerRow = reg('div', 'edgeDockComposerRow');
  edgeComposerRow.append(reg('div', 'edgeDockComposer'));
  presenceGroup.append(edgeDockLabel, edgeDockOptions, edgeComposerRow);

  // Notch
  const notchLabel = reg('label', '', 'checkbox-label settings-item');
  const notchInput = reg('input', 'notchInput');
  notchLabel.append(notchInput);
  const notchOptions = reg('div', 'notchOptions');
  const notchSummaryInput = reg('input', 'notchSummaryInput');
  notchSummaryInput.checked = true;
  const notchMore = reg('div', 'notchMoreOptionsGroup');
  const notchMoreDetails = reg('div', 'notchMoreOptionsDetails', 'cursor-settings-details');
  notchMoreDetails.append(
    itemWith(reg('select', 'notchStyleInput')),
    itemWith(reg('input', 'notchProgressiveBlurInput')),
    itemWith(notchSummaryInput),
    itemWith(reg('input', 'notchHideSummaryInFullScreenInput')),
    reg('label', 'notchRunningIndicatorRow', 'settings-item'),
    itemWith(reg('input', 'notchWarnColorsInput')),
    itemWith(reg('input', 'notchHapticInput')),
    itemWith(reg('input', 'notchSwipeGesturesInput')),
    itemWith(reg('select', 'notchSummaryModeInput')),
    reg('div', 'notchComposerDetails')
  );
  notchMore.append(notchMoreDetails);
  notchOptions.append(
    itemWith(reg('span', 'notchHoverActionLabel')),
    reg('div', 'notchHoverDelayRow', 'settings-item'),
    itemWith(reg('span', 'notchShapeLabel')),
    itemWith(reg('span', 'notchSizeLabel')),
    reg('div', 'notchCustomScaleRow', 'settings-item'),
    reg('div', '', 'notch-page-settings'),
    notchMore,
    reg('div', 'notchItemsComposer')
  );
  presenceGroup.append(notchLabel, notchOptions);

  // Floating Bubble
  const bubbleLabel = reg('label', '', 'checkbox-label settings-item');
  const floatingBubbleInput = reg('input', 'floatingBubbleInput');
  bubbleLabel.append(floatingBubbleInput);
  const bubbleOptions = reg('div', 'floatingBubbleOptions');
  const bubbleContentInput = reg('select', 'floatingBubbleContentInput');
  bubbleContentInput.selectedOptions = [{ dataset: { i18n: 'settings.tray.bothToday' }, textContent: 'Tokens + Cost Today' }];
  const bubbleContentRow = reg('label', 'floatingBubbleContentRow', 'settings-item');
  bubbleContentRow.append(bubbleContentInput);
  bubbleOptions.append(
    reg('div', 'floatingBubbleTriggerRow', 'settings-item'),
    bubbleContentRow,
    reg('div', 'floatingBubbleComposer')
  );
  presenceGroup.append(bubbleLabel, bubbleOptions);

  // Tray
  const trayLabel = reg('label', '', 'checkbox-label settings-item');
  const showTrayIconInput = reg('input', 'showTrayIconInput');
  trayLabel.append(showTrayIconInput);
  const trayOptions = reg('div', 'trayIconOptions');
  const trayContentInput = reg('select', 'trayContentInput');
  trayContentInput.selectedOptions = [{ dataset: { i18n: 'settings.tray.tokensToday' }, textContent: 'Tokens Today' }];
  trayOptions.append(
    itemWith(trayContentInput),
    reg('div', 'trayComposer'),
    itemWith(reg('input', 'showTrayProviderBadgeInput')),
    itemWith(reg('input', 'trayModeInput')),
    reg('div', 'trayOptions'),
    reg('label', 'hideAppIconRow', 'settings-item'),
    reg('div', 'hideAppIconOptions')
  );
  presenceGroup.append(trayLabel, trayOptions);

  root.append(mainGroup, presenceGroup);

  let currentPlatform = platform;
  let shortcutStops = 0;
  let helpCloses = 0;
  const controller = displaySettingsApi.create({
    document: doc,
    root,
    scrollPanel,
    t: (key) => translate('en', key, {}, currentPlatform),
    platform: () => currentPlatform,
    settings: () => prefs,
    helpPopover: {
      createHelpPopover: () => ({ close: () => { helpCloses++; } })
    },
    stopWindowShortcutRecording: () => { shortcutStops++; }
  });

  return {
    doc,
    root,
    controller,
    prefs,
    inputs: { edgeDockInput, notchInput, notchSummaryInput, floatingBubbleInput, showTrayIconInput },
    setPlatform: (next) => { currentPlatform = next; controller.sync(); },
    getShortcutStops: () => shortcutStops,
    getHelpCloses: () => helpCloses
  };
}

test('display switcher defaults to main, adapts tiles per OS, and stops shortcut recording on leave', () => {
  const f = createWindowSettingsFixture({ platform: 'darwin' });
  const visibleTabs = () => f.root.querySelector('.display-settings-dock').children.filter((c) => !c.hidden).map((c) => c.id);

  assert.equal(f.controller.active, 'main');
  assert.deepEqual(visibleTabs(), [
    'display-tab-main', 'display-tab-edgeDock', 'display-tab-notch', 'display-tab-floatingBubble', 'display-tab-tray'
  ]);

  f.controller.open('edgeDock');
  assert.equal(f.controller.active, 'edgeDock');
  assert.equal(f.getShortcutStops(), 1);
  assert.equal(f.root.querySelector('#display-page-main').hidden, true);
  const edgePage = f.root.querySelector('#display-page-edgeDock');
  assert.equal(edgePage.hidden, false);
  const visibilityRow = edgePage.querySelector('#edgeDockModeLabel').closest('.settings-item');
  const placementRows = visibilityRow.parent.children;
  assert.equal(placementRows[placementRows.indexOf(visibilityRow) + 1].id, 'edgeDockTriggerRangeRow');

  f.controller.open('main');
  assert.equal(f.controller.active, 'main');
  assert.equal(f.root.querySelector('#display-page-main').hidden, false);

  f.setPlatform('win32');
  assert.deepEqual(visibleTabs(), ['display-tab-main', 'display-tab-edgeDock', 'display-tab-floatingBubble', 'display-tab-tray']);

  f.controller.open('edgeDock');
  f.setPlatform('linux');
  assert.equal(f.controller.active, 'main', 'switching to a platform without the active surface returns to main');
  assert.deepEqual(visibleTabs(), ['display-tab-main', 'display-tab-floatingBubble', 'display-tab-tray']);
});

test('surface header shows plain intro and dims cards while off, then switches to live summary when enabled', () => {
  const f = createWindowSettingsFixture({
    platform: 'darwin',
    prefs: { edgeDockMode: 'autoHide', edgeDockSide: 'left', notchHoverAction: 'open', notchSummaryEnabled: true, notchSummaryMode: 'auto' }
  });

  f.controller.open('edgeDock');
  const edgePage = f.root.querySelector('#display-page-edgeDock');
  const edgeSub = edgePage.querySelector('.display-settings-hero-sub');
  const edgeCards = edgePage.querySelector('.display-settings-cards');
  const edgeHelp = edgePage.querySelector('#display-help-trigger-edgeDock');
  const edgeTab = f.root.querySelector('#display-tab-edgeDock');
  assert.equal(edgePage.querySelector('.display-settings-hero-title-row').dataset.resetSetting, 'edgeDockEnabled');
  assert.equal(edgePage.querySelector('.display-settings-hero-title').classList.contains('settings-item-title'), true);

  assert.equal(edgeSub.textContent, translate('en', 'settings.display.edgeDockNote', {}, 'darwin'));
  assert.equal(edgeCards.classList.contains('is-disabled-surface'), true);
  assert.equal(edgeHelp.hidden, true);
  assert.equal(edgeTab.classList.contains('is-enabled'), false);

  f.inputs.edgeDockInput.checked = true;
  f.controller.sync();

  assert.equal(edgeSub.textContent, 'Auto-hide · Left');
  assert.equal(edgeCards.classList.contains('is-disabled-surface'), false);
  assert.equal(edgeHelp.hidden, false);
  assert.equal(edgeTab.classList.contains('is-enabled'), true);

  // Notch collapsed-summary dependent subblock hides when notchSummaryInput is off.
  f.controller.open('notch');
  const notchPage = f.root.querySelector('#display-page-notch');
  const subblock = notchPage.querySelector('.display-settings-subblock');
  assert.equal(subblock.hidden, false);
  f.inputs.notchSummaryInput.checked = false;
  f.controller.sync();
  assert.equal(subblock.hidden, true);
});

test('edge dock composer auto-selects its first item while notch composer stays compact until clicked', () => {
  const previousDocument = global.document;
  global.document = { createElement: (tag) => new FakeElement(tag), activeElement: null };
  try {
    const makeComposer = (itemsKey) => {
      const root = new FakeElement('div');
      const composer = createEdgeDockComposer({
        root,
        itemsKey,
        itemsApi,
        t: (key) => key,
        presentationApi: { connectedLimitProviders: () => ['claude', 'codex'] },
        getSettings: () => ({ [itemsKey]: [{ type: 'limit', provider: 'claude' }, { type: 'limit', provider: 'codex' }] }),
        getStats: () => ({ limits: { providers: [] } }),
        save: () => {},
        providerLabel: (id) => id,
        providerColor: () => '#000',
        windowLabel: () => '',
        hasProviderMark: () => false,
        maskEmail: (v) => v,
        createRowDrag: () => ({ deferRender: () => false })
      });
      composer.render();
      return root;
    };

    const edgeRoot = makeComposer('edgeDockItems');
    const edgeTitle = edgeRoot.querySelector('.edge-dock-composer-detail-title');
    assert.equal(edgeTitle?.textContent, 'claude', 'edge dock selects first item automatically');
    edgeRoot.querySelector('.edge-dock-composer-item').dispatch('click');
    assert.equal(edgeRoot.querySelector('.edge-dock-composer-detail-title')?.textContent, 'claude', 'clicking selected edge dock item keeps detail open');

    const notchRoot = makeComposer('notchItems');
    assert.equal(notchRoot.querySelector('.edge-dock-composer-detail-title'), null, 'notch limits composer starts without expanding an item detail');
  } finally {
    global.document = previousDocument;
  }
});

test('every display-mode navigation string has a translation in every supported locale', () => {
  const keys = Object.keys(MESSAGES.en).filter((key) => key.startsWith('settings.displayModes.'));
  assert.ok(keys.length > 20);
  for (const { value } of LANGUAGE_OPTIONS.filter((locale) => locale.value !== 'auto')) {
    for (const key of keys) {
      assert.ok(MESSAGES[value][key], `${value}: ${key}`);
    }
  }
});
