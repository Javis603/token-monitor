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
const limitDisplayMode = require('../../src/electron/renderer/limitDisplayMode');
const limitPresentationApi = require('../../src/electron/renderer/limitProviderPresentation');
const limitResetMotionApi = require('../../src/electron/renderer/limitResetMotion');
const limitWindowLabels = require('../../src/shared/limitWindowLabels');
const limitWindowTextApi = require('../../src/shared/limitWindowText');
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

  get text() {
    return [...this.walk()].map((node) => node.textContent).filter(Boolean).join(' ');
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
      createTextNode: (value) => ({ textContent: String(value) })
    },
    t: (key) => key,
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
    limitWindowText: limitWindowTextApi.limitWindowText
  });
}

test('the dock hands the shared view every dependency it destructures', () => {
  const view = fs.readFileSync(path.join(root, 'src/electron/renderer/limitWindowsView.js'), 'utf8');
  const dock = fs.readFileSync(path.join(root, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const destructured = view.slice(view.indexOf('const {'), view.indexOf('} = deps;'));
  const required = destructured
    .replace('const {', '')
    .split(',')
    .map((entry) => entry.split(':')[0].trim())
    .filter(Boolean);
  const wiring = balancedCall(dock, 'createLimitWindowsView({');

  assert.ok(required.length > 10, 'the dependency list should have been parsed');
  for (const name of required) {
    assert.match(wiring, new RegExp(`(^|[\\s{,])${name}\\s*[,:]`, 'm'), `the dock must supply ${name}`);
  }
  // `document` is read off deps separately rather than destructured with the rest.
  assert.match(wiring, /^\s*document,$/m);
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
