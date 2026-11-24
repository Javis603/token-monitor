'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..', '..');
const electronDir = path.join(rootDir, 'src', 'electron');
const rendererDir = path.join(electronDir, 'renderer');

const appSource = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8');
const dockSource = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'dock.js'), 'utf8');
const detailTokenDisplaySource = fs.readFileSync(path.join(rendererDir, 'detailTokenDisplay.js'), 'utf8');
const i18n = require('../../src/electron/renderer/i18n');
const compactTokens = require('../../src/shared/compactTokens');
const rendererDom = {
  reconcileChildren(parent, nodes) { parent.replaceChildren(...nodes); },
  placeChildren(parent, nodes) { parent.replaceChildren(...nodes); },
  clear(parent) { parent.replaceChildren(); }
};
const sessionRows = require('../../src/electron/renderer/sessionRows');

function freshDetailTokenDisplay() {
  const resolved = require.resolve('../../src/electron/renderer/detailTokenDisplay');
  delete require.cache[resolved];
  return require(resolved);
}

class FakeClassList {
  constructor(node) {
    this.node = node;
    this.set = new Set();
  }
  add(...names) { for (const name of names) if (name) this.set.add(name); }
  remove(...names) { for (const name of names) this.set.delete(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.set.has(name) : Boolean(force);
    if (next) this.set.add(name); else this.set.delete(name);
    return next;
  }
  contains(name) { return this.set.has(name); }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this._textContent = '';
  }
  set className(value) {
    this.classList.set = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classList.set].join(' ');
  }
  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children = [];
  }
  get textContent() {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join('');
    return this._textContent;
  }
  set innerHTML(markup) {
    this.children = [];
    this._textContent = '';
    const stack = [this];
    const tokenRegex = /<\/?([a-zA-Z0-9-]+)([^>]*)>/g;
    let match;
    while ((match = tokenRegex.exec(markup)) !== null) {
      const [full, tag, attrs] = match;
      if (full.startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const el = new FakeElement(tag);
      const classMatch = attrs.match(/class="([^"]*)"/);
      if (classMatch) el.className = classMatch[1];
      const ariaHiddenMatch = attrs.match(/aria-hidden="([^"]*)"/);
      if (ariaHiddenMatch) el.setAttribute('aria-hidden', ariaHiddenMatch[1]);
      stack[stack.length - 1].append(el);
      if (!full.endsWith('/>')) stack.push(el);
    }
  }
  get childNodes() { return this.children; }
  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      if (node.parentElement) {
        const index = node.parentElement.children.indexOf(node);
        if (index >= 0) node.parentElement.children.splice(index, 1);
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      if (!node) continue;
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._textContent = '';
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  matches(selector) {
    for (const part of selector.split(',').map((item) => item.trim())) {
      const attrMatch = part.match(/^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i);
      if (attrMatch) {
        const [, attr, expected] = attrMatch;
        if (attr === 'data-detail-token-toggle') {
          if (expected === undefined ? Boolean(this.dataset.detailTokenToggle) : this.dataset.detailTokenToggle === expected) return true;
        } else if (expected === undefined ? this.hasAttribute(attr) : this.getAttribute(attr) === expected) {
          return true;
        }
        continue;
      }
      const classAndAttr = part.match(/^\.([a-z0-9_-]+)\[role="([^"]+)"\]$/i);
      if (classAndAttr) {
        if (this.classList.contains(classAndAttr[1]) && this.getAttribute('role') === classAndAttr[2]) return true;
        continue;
      }
      if (part.startsWith('.')) {
        const classes = part.slice(1).split('.');
        if (classes.every((cls) => this.classList.contains(cls))) return true;
      } else if (part.toUpperCase() === this.tagName) {
        return true;
      }
    }
    return false;
  }
  closest(selector) {
    let cursor = this;
    while (cursor) {
      if (cursor.matches?.(selector)) return cursor;
      cursor = cursor.parentElement;
    }
    return null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches?.(selector)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }
  querySelectorAll(selector) {
    const results = [];
    for (const child of this.children) {
      if (child.matches?.(selector)) results.push(child);
      if (child.querySelectorAll) results.push(...child.querySelectorAll(selector));
    }
    return results;
  }
  dispatch(type, init = {}) {
    let stopped = false;
    let defaultPrevented = false;
    const event = {
      type,
      target: this,
      currentTarget: this,
      key: init.key,
      preventDefault() { defaultPrevented = true; },
      stopPropagation() { stopped = true; },
      get defaultPrevented() { return defaultPrevented; },
      get propagationStopped() { return stopped; }
    };
    let cursor = this;
    while (cursor && !stopped) {
      event.currentTarget = cursor;
      for (const listener of cursor.listeners.get(type) || []) {
        listener(event);
      }
      cursor = cursor.parentElement;
    }
    return event;
  }
}

function fakeDocument() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text ?? ''), parentElement: null })
  };
}

test('detailTokensUseCompactUnits is a default-off appearance preference wired across main, HTML, CSS, and all bundled locales', () => {
  assert.match(mainSource, /detailTokensUseCompactUnits:\s*false/);
  assert.match(mainSource, /'showCompactTotalTokens',\s*'detailTokensUseCompactUnits',\s*'compactTokenUnits'/);
  assert.match(mainSource, /merged\.detailTokensUseCompactUnits = parseBoolean\(merged\.detailTokensUseCompactUnits, false\);/);
  assert.match(mainSource, /detailTokensUseCompactUnits:\s*parseBoolean\(patch\.detailTokensUseCompactUnits \?\? settings\.detailTokensUseCompactUnits, false\)/);

  assert.match(htmlSource, /id="detailTokensUseCompactUnitsInput" type="checkbox"/);
  assert.match(htmlSource, /data-reset-setting="detailTokensUseCompactUnits"/);
  assert.match(htmlSource, /data-i18n="settings\.appearance\.detailCompactTokens"/);
  assert.match(htmlSource, /data-i18n="settings\.appearance\.detailCompactTokensNote"/);
  assert.match(htmlSource, /<script src="detailTokenDisplay\.js"><\/script>/);
  assert.ok(
    htmlSource.indexOf('<script src="detailTokenDisplay.js"></script>') < htmlSource.indexOf('<script src="sessionRows.js"></script>'),
    'detailTokenDisplay.js loads before sessionRows.js'
  );

  assert.match(cssSource, /\.detail-token-toggle\s*\{\s*cursor:\s*pointer;/);
  assert.match(cssSource, /\.detail-token-toggle:focus-visible\s*\{/);

  assert.match(appSource, /detailTokensUseCompactUnits:\s*false/);
  assert.match(appSource, /detailTokensUseCompactUnitsInput:\s*document\.getElementById\('detailTokensUseCompactUnitsInput'\)/);
  assert.match(appSource, /detailTokensUseCompactUnits:\s*Boolean\(els\.detailTokensUseCompactUnitsInput\?\.checked\)/);
  assert.match(appSource, /els\.detailTokensUseCompactUnitsInput\.checked = state\.settings\.detailTokensUseCompactUnits === true/);
  assert.match(appSource, /els\.detailTokensUseCompactUnitsInput\?\.addEventListener\('change',[\s\S]*?saveAppearanceFromControls\(\)/);

  const requiredKeys = [
    'settings.appearance.detailCompactTokens',
    'settings.appearance.detailCompactTokensNote',
    'detail.tokens.clickForExact',
    'detail.tokens.clickForCompact'
  ];
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'pt-BR', 'es']) {
    for (const key of requiredKeys) {
      assert.ok(
        typeof i18n.MESSAGES[locale]?.[key] === 'string' && i18n.MESSAGES[locale][key].trim().length > 0,
        `${locale} should define ${key}`
      );
    }
  }
});

test('detailTokenDisplay formats exact when disabled, western/localized compact when enabled, and toggles transient exact without persistence', () => {
  const api = freshDetailTokenDisplay();
  let enabled = false;
  let unitSystem = 'western';
  let locale = 'en';
  let toggleCount = 0;

  api.configure({
    isEnabled: () => enabled,
    getUnitSystem: () => unitSystem,
    getLocale: () => locale,
    onToggle: () => { toggleCount += 1; }
  });

  // Disabled: always exact with thousand separators.
  assert.equal(api.isTransientExact(), false);
  assert.equal(api.formatDetailTokens(1_234_567), '1,234,567');
  assert.equal(api.formatDetailTokens(15_400), '15,400');

  // Enabled + western: K/M/B.
  enabled = true;
  assert.equal(api.formatDetailTokens(999), '999');
  assert.equal(api.formatDetailTokens(1_500), '1.5K');
  assert.equal(api.formatDetailTokens(1_234_567), '1.2M');
  assert.equal(api.formatDetailTokens(3_400_000_000), '3.4B');

  // Enabled + localized: East Asian units in CJK locales, western fallback in en.
  unitSystem = 'localized';
  assert.equal(api.formatDetailTokens(15_000), '15K');
  locale = 'zh-CN';
  assert.equal(api.formatDetailTokens(15_000), '1.5万');
  assert.equal(api.formatDetailTokens(295_116_445), '2.95亿');
  locale = 'zh-TW';
  assert.equal(api.formatDetailTokens(15_000), '1.5萬');
  assert.equal(api.formatDetailTokens(295_116_445), '2.95億');
  locale = 'ja';
  assert.equal(api.formatDetailTokens(295_116_445), '2.95億');
  locale = 'ko';
  assert.equal(api.formatDetailTokens(295_116_445), '2.95억');

  // Toggle to transient exact and back.
  assert.equal(api.toggleTransientExact(), true);
  assert.equal(toggleCount, 1);
  assert.equal(api.isTransientExact(), true);
  assert.equal(api.formatDetailTokens(295_116_445), '295,116,445');

  assert.equal(api.toggleTransientExact(), false);
  assert.equal(toggleCount, 2);
  assert.equal(api.isTransientExact(), false);
  assert.equal(api.formatDetailTokens(295_116_445), '2.95억');

  // Transient state must live only in memory and reset on renderer reload.
  assert.doesNotMatch(detailTokenDisplaySource, /localStorage|sessionStorage|updateSettings/);
  api.toggleTransientExact();
  assert.equal(api.isTransientExact(), true);
  const reloadedApi = freshDetailTokenDisplay();
  assert.equal(reloadedApi.isTransientExact(), false);
  reloadedApi.configure({ isEnabled: () => true, getUnitSystem: () => 'localized', getLocale: () => 'zh-CN' });
  assert.equal(reloadedApi.formatDetailTokens(15_000), '1.5万');
});

test('compactTokenUnitsRow stays visible in East Asian locales when detailTokensUseCompactUnits is enabled without showCompactTotalTokens', () => {
  const row = new FakeElement('div');
  row.classList.add('hidden');
  const syncVisibility = (locale) => {
    row.classList.toggle('hidden', !compactTokens.supportsLocalizedCompactTokenUnits(locale));
  };
  syncVisibility('zh-CN');
  assert.equal(row.classList.contains('hidden'), false);
  syncVisibility('ja');
  assert.equal(row.classList.contains('hidden'), false);
  syncVisibility('ko');
  assert.equal(row.classList.contains('hidden'), false);
  syncVisibility('en');
  assert.equal(row.classList.contains('hidden'), true);
});

test('breakdown rows toggle between compact and exact across all visible rows, expose exact aria-label, and stop propagation so clicking tokens never opens session detail', () => {
  const api = freshDetailTokenDisplay();
  const document = fakeDocument();
  const state = {
    breakdown: 'session',
    settings: {
      detailTokensUseCompactUnits: false,
      compactTokenUnits: 'localized',
      locale: 'zh-CN',
      showToolIcons: false
    }
  };
  const formatNumber = (value) => Math.round(Number(value || 0)).toLocaleString('en-US');
  const formatCompact = (value, unitSystem, locale) => compactTokens.formatCompactTokens(
    value,
    unitSystem ?? compactTokens.effectiveCompactTokenUnits(state.settings.compactTokenUnits, state.settings.locale),
    locale ?? state.settings.locale
  );
  const t = (key) => i18n.translate(state.settings.locale, key);

  const rowTemplateStart = appSource.indexOf('function rowTemplate(');
  const rowTemplateEnd = appSource.indexOf('const DEVICE_DELETE_CONFIRMATION_MS', rowTemplateStart);
  const updateRowStart = appSource.indexOf('function updateRow(');
  const updateRowEnd = appSource.indexOf('function applyHomeListMark(', updateRowStart);
  const deviceAccordionStart = appSource.indexOf('function renderDeviceAccordion(');
  const deviceAccordionEnd = appSource.indexOf('function appendAccordionMetricRow(', deviceAccordionStart);
  const toolAccordionStart = appSource.indexOf('function appendAccordionMetricRow(');
  const toolAccordionEnd = appSource.indexOf('function activeToolDetail(', toolAccordionStart);

  const context = {
    document,
    rendererDom,
    state,
    rowLiveMarkup: '',
    overflowText: { update() {} },
    bindHoverMarquee() {},
    setHoverMarqueeText(el, text) { el.textContent = text || ''; },
    rowWidth: () => 50,
    iconKindFor: () => ({ kind: 'dot' }),
    toolIconsEnabled: () => false,
    clientsWithIcon: new Set(),
    toolDetailData: new WeakMap(),
    toolDetailsApi: require('../../src/electron/renderer/toolDetails'),
    fixedPeriodRangesApi: require('../../src/electron/renderer/fixedPeriodRanges'),
    formatNumber,
    formatCompact,
    formatCost: (value) => `$${Number(value || 0).toFixed(2)}`,
    rowNumberAnimations: new Map(),
    cancelRowNumberAnimation() {},
    updateRowContext() {},
    updateRowLive() {},
    applyBarScale() {},
    sessionRowsApi: sessionRows,
    t,
    isDetailCompactEnabled: () => state.settings.detailTokensUseCompactUnits === true,
    formatDetailTokens: (value) => api.formatDetailTokens(value),
    detailTokenDisplaySignature: () => api.stateSignature(),
    decorateDetailTokenElement: (el, value, options = {}) => {
      const exactText = options.exactText !== undefined ? String(options.exactText) : formatNumber(value);
      api.decorateTokenElement(el, exactText, {
        ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
        exactHint: t('detail.tokens.clickForExact'),
        compactHint: t('detail.tokens.clickForCompact')
      });
    }
  };
  vm.runInNewContext(`
    ${appSource.slice(rowTemplateStart, rowTemplateEnd)}
    ${appSource.slice(deviceAccordionStart, deviceAccordionEnd)}
    ${appSource.slice(toolAccordionStart, toolAccordionEnd)}
    ${appSource.slice(updateRowStart, updateRowEnd)}
    globalThis.rowTemplate = rowTemplate;
    globalThis.updateRow = updateRow;
  `, context);

  const breakdown = document.createElement('div');
  let openedSessions = 0;
  breakdown.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-detail-token-toggle="true"]')) return;
    if (event.target.closest?.('.row')) openedSessions += 1;
  });
  breakdown.addEventListener('keydown', (event) => {
    sessionRows.handleBreakdownRowKeydown(event);
  });

  const rowsData = [
    { key: 'session:claude:s1', name: 'Session A', kind: 'session', client: 'claude', value: 150_000, cost: 1.5, max: 300_000, barValue: 150_000, color: '#6ab4f0' },
    { key: 'session:codex:s2', name: 'Session B', kind: 'session', client: 'codex', value: 2_500_000, cost: 4.2, max: 300_000, barValue: 2_500_000, color: '#cc7c5e' }
  ];
  const rowNodes = rowsData.map((data) => {
    const node = context.rowTemplate(data);
    breakdown.append(node);
    return node;
  });
  const repaint = () => {
    rowsData.forEach((data, index) => context.updateRow(rowNodes[index], data));
  };
  api.configure({
    isEnabled: () => state.settings.detailTokensUseCompactUnits === true,
    getUnitSystem: () => state.settings.compactTokenUnits,
    getLocale: () => state.settings.locale,
    formatExact: formatNumber,
    formatCompact,
    onToggle: repaint
  });

  // Setting off: exact numbers, non-interactive token elements, clicking value bubbles to open session detail.
  repaint();
  assert.equal(rowNodes[0].querySelector('.row-value').textContent, '150,000');
  assert.equal(rowNodes[1].querySelector('.row-value').textContent, '2,500,000');
  assert.equal(rowNodes[0].querySelector('.row-value').getAttribute('role'), null);
  assert.equal(rowNodes[0].querySelector('.row-value').getAttribute('tabindex'), null);
  assert.equal(rowNodes[0].querySelector('.row-value').getAttribute('aria-label'), null);
  assert.equal(rowNodes[0].querySelector('.row-value').classList.contains('detail-token-toggle'), false);
  rowNodes[0].querySelector('.row-value').dispatch('click');
  assert.equal(openedSessions, 1);

  // Turn setting on: localized compact values, button semantics, tooltip, exact aria-label.
  state.settings.detailTokensUseCompactUnits = true;
  repaint();
  const value0 = rowNodes[0].querySelector('.row-value');
  const value1 = rowNodes[1].querySelector('.row-value');
  assert.equal(value0.textContent, '15万');
  assert.equal(value1.textContent, '250万');
  assert.equal(value0.classList.contains('detail-token-toggle'), true);
  assert.equal(value0.getAttribute('role'), 'button');
  assert.equal(value0.getAttribute('tabindex'), '0');
  assert.equal(value0.getAttribute('aria-pressed'), 'false');
  assert.equal(value0.getAttribute('aria-label'), '150,000');
  assert.equal(value1.getAttribute('aria-label'), '2,500,000');
  assert.equal(value0.getAttribute('title'), '单击查看精确值');

  // Click first row token: BOTH rows switch to exact, session detail is NOT opened.
  const clickEvent = value0.dispatch('click');
  assert.equal(clickEvent.propagationStopped, true);
  assert.equal(openedSessions, 1);
  assert.equal(value0.textContent, '150,000');
  assert.equal(value1.textContent, '2,500,000');
  assert.equal(value0.getAttribute('aria-pressed'), 'true');
  assert.equal(value0.getAttribute('title'), '单击切回简写单位');

  // Keyboard Enter toggles back to compact without invoking row click.
  rowNodes[0].click = () => { openedSessions += 1; };
  const enterEvent = value0.dispatch('keydown', { key: 'Enter' });
  assert.equal(enterEvent.defaultPrevented, true);
  assert.equal(enterEvent.propagationStopped, true);
  assert.equal(openedSessions, 1);
  assert.equal(value0.textContent, '15万');
  assert.equal(value1.textContent, '250万');

  // Keyboard Space also toggles to exact without invoking row click.
  const spaceEvent = value1.dispatch('keydown', { key: ' ' });
  assert.equal(spaceEvent.defaultPrevented, true);
  assert.equal(spaceEvent.propagationStopped, true);
  assert.equal(openedSessions, 1);
  assert.equal(value0.textContent, '150,000');
  assert.equal(value1.textContent, '2,500,000');

  // Clicking the row outside the token number still opens session detail.
  rowNodes[0].querySelector('.row-title').dispatch('click');
  assert.equal(openedSessions, 2);

  // Accordion sub-rows: project tools, device tools/models, tool breakdown.
  api.reset();
  state.breakdown = 'project';
  const projectRow = context.rowTemplate({ key: 'proj:a', name: 'Project A' });
  context.updateRow(projectRow, {
    name: 'Project A', value: 250_000, cost: 2, max: 250_000, barValue: 250_000, color: '#6ab4f0',
    accordionRows: [{ name: 'Claude Code', value: 150_000, percent: 60, color: '#cc7c5e' }]
  });
  assert.equal(projectRow.querySelector('.row-value').textContent, '25万');
  assert.equal(projectRow.querySelector('.accordion-value').textContent, '15万');
  assert.equal(projectRow.querySelector('.accordion-value').getAttribute('aria-label'), '150,000');
  assert.match(projectRow.querySelector('.row-head').getAttribute('aria-label'), /250,000/);

  const deviceRow = context.rowTemplate({ key: 'dev:a', name: 'Workstation' });
  context.updateRow(deviceRow, {
    name: 'Workstation', value: 500_000, cost: 5, max: 500_000, barValue: 500_000, color: '#6ab4f0',
    deviceDetail: {
      emptyText: '', metaParts: [],
      tools: [{ key: 'codex', client: 'codex', name: 'Codex', value: 320_000, percent: 64, color: '#6ab4f0',
        models: [{ key: 'gpt-5', name: 'gpt-5', value: 120_000 }] }]
    }
  });
  assert.equal(deviceRow.querySelector('.device-tool-metrics').textContent, '32万');
  assert.equal(deviceRow.querySelector('.device-tool-metrics').getAttribute('aria-label'), '320,000');
  assert.equal(deviceRow.querySelector('.device-model-value').textContent, '12万');
  assert.equal(deviceRow.querySelector('.device-model-value').getAttribute('aria-label'), '120,000');
  api.toggleTransientExact();
  context.updateRow(deviceRow, {
    name: 'Workstation', value: 500_000, cost: 5, max: 500_000, barValue: 500_000, color: '#6ab4f0',
    deviceDetail: {
      emptyText: '', metaParts: [],
      tools: [{ key: 'codex', client: 'codex', name: 'Codex', value: 320_000, percent: 64, color: '#6ab4f0',
        models: [{ key: 'gpt-5', name: 'gpt-5', value: 120_000 }] }]
    }
  });
  assert.equal(deviceRow.querySelector('.device-tool-metrics').textContent, '320,000');
  assert.equal(deviceRow.querySelector('.device-model-value').textContent, '120,000');
});

test('session detail, session group header, sessionRows tooltips, and row animations follow detailTokenDisplay', () => {
  const api = freshDetailTokenDisplay();
  const document = fakeDocument();
  const formatNumber = (value) => Math.round(Number(value || 0)).toLocaleString('en-US');
  const formatCompact = (value) => compactTokens.formatCompactTokens(value, 'western', 'en');
  api.configure({
    isEnabled: () => true,
    getUnitSystem: () => 'western',
    getLocale: () => 'en',
    formatExact: formatNumber,
    formatCompact
  });

  // sessionRows model tooltip entries follow options.formatTokens and cache key.
  const session = {
    client: 'claude',
    sessionId: 's1',
    totalTokens: 150_000,
    models: { 'claude-sonnet': 100_000, 'claude-haiku': 50_000 }
  };
  const compactEntries = sessionRows.sessionModelTooltipEntries(session, {
    formatTokens: (value) => api.formatDetailTokens(value)
  });
  assert.deepEqual(compactEntries.map((entry) => entry[1]), ['100K', '50K']);
  api.toggleTransientExact();
  const exactEntries = sessionRows.sessionModelTooltipEntries(session, {
    formatTokens: (value) => api.formatDetailTokens(value)
  });
  assert.deepEqual(exactEntries.map((entry) => entry[1]), ['100,000', '50,000']);
  api.reset();

  // exchangeNode + turnNode + renderSessionGroupDetail.
  const groupStart = appSource.indexOf('function renderSessionGroupDetail(');
  const turnEnd = appSource.indexOf('let contentReadySignaled', groupStart);
  const context = {
    document,
    rendererDom,
    els: {
      sessionToolFilter: document.createElement('div'),
      sessionSearchHost: document.createElement('div'),
      sessionSortToggle: document.createElement('div'),
      sessionSearchToggle: document.createElement('div'),
      breakdown: document.createElement('div'),
      sessionDetail: document.createElement('div'),
      sessionDetailHead: document.createElement('div')
    },
    t: (key) => i18n.translate('en', key),
    closeSessionDetail() {},
    sessionDetailBackArrow: () => document.createElement('span'),
    bindHoverMarquee() {},
    formatNumber,
    formatDetailTokens: (value) => api.formatDetailTokens(value),
    decorateDetailTokenElement: (el, value, options = {}) => {
      const exactText = options.exactText !== undefined ? String(options.exactText) : formatNumber(value);
      api.decorateTokenElement(el, exactText, {
        exactHint: 'Click for exact count',
        compactHint: 'Click for compact units'
      });
    },
    formatCost: (value) => `$${Number(value || 0).toFixed(2)}`,
    sessionGroupRunNode: () => document.createElement('div'),
    rowWidth: () => 50,
    applyBarScale() {}
  };
  vm.runInNewContext(`
    ${appSource.slice(groupStart, turnEnd)}
    globalThis.renderSessionGroupDetail = renderSessionGroupDetail;
    globalThis.exchangeNode = exchangeNode;
    globalThis.turnNode = turnNode;
  `, context);

  // Session group header tokens.
  context.renderSessionGroupDetail({
    summary: { subagentGroup: true, name: 'Thread', value: 250_000, cost: 3.5, subagentCount: 1, groupRows: [{ key: 'm1', groupRole: 'main', value: 250_000 }] }
  });
  const groupTokens = context.els.sessionDetail.querySelector('.session-group-tokens');
  assert.equal(groupTokens.textContent, '250K');
  assert.equal(groupTokens.getAttribute('aria-label'), '250,000');

  // Exchange & turn nodes, plus stopPropagation on .detail-ex-value so clicking it does not toggle turns.
  const exchange = context.exchangeNode({
    key: 'ex1', isPrompt: true, title: 'Hello', subtitle: '12:00 · 1 turn', value: 120_000, cost: 1.2,
    turns: [{ key: 't1', label: 'Reply #1', value: 120_000, cost: 1.2, tokens: { input: 80_000, output: 15_000, cacheRead: 25_000, cacheWrite: 0 }, tools: '' }]
  }, 120_000, false);
  const exValue = exchange.querySelector('.detail-ex-value');
  assert.equal(exValue.textContent, '120K');
  assert.equal(exValue.getAttribute('aria-label'), '120,000');
  const turnValue = exchange.querySelector('.detail-turn-value');
  assert.equal(turnValue.textContent, '120K');
  assert.equal(turnValue.getAttribute('aria-label'), '120,000');
  const turnSplit = exchange.querySelector('.detail-turn-split');
  assert.equal(turnSplit.textContent, 'in 80K · out 15K · cache 25K');
  assert.equal(turnSplit.getAttribute('aria-label'), 'in 80,000 · out 15,000 · cache 25,000');

  exValue.dispatch('click');
  assert.equal(exchange.classList.contains('expanded'), false, 'clicking exchange token must not toggle turns');
  assert.equal(api.isTransientExact(), true);

  // Row number animation uses formatDetailTokens (no flash of exact count in compact mode).
  api.reset();
  const frames = [];
  const rowStart = appSource.indexOf('function animateRowNumber(');
  const rowEnd = appSource.indexOf('function cancelRowNumberAnimation(', rowStart);
  const animContext = {
    state: { settings: { tokenNumberAnimation: 'count' } },
    tokenNumberAnimationApi: require('../../src/electron/tokenNumberAnimation'),
    rowNumberAnimations: new Map(),
    prefersReducedMotion: () => false,
    performance: { now: () => 0 },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelAnimationFrame() {},
    easeOutQuart: (t) => 1 - (1 - t) ** 4,
    formatDetailTokens: (value) => api.formatDetailTokens(value)
  };
  vm.runInNewContext(`${appSource.slice(rowStart, rowEnd)}\nglobalThis.animateRowNumber = animateRowNumber;`, animContext);
  const animEl = document.createElement('div');
  animContext.animateRowNumber(animEl, 10_000, 50_000, 420);
  assert.equal(animEl.textContent, '10K');
  frames.shift()(420);
  assert.equal(animEl.textContent, '50K');
});

test('regression: Edge Dock detail cards and TOTAL TOKENS remain unaffected by detailTokensUseCompactUnits', () => {
  assert.doesNotMatch(dockSource, /detailTokensUseCompactUnits|TokenMonitorDetailTokenDisplay/);
  const formatCardTokens = Function(`return (${dockSource.match(/function formatCardTokens\(value\) \{[^}]+\}/)[0]})`)();
  assert.equal(formatCardTokens(216_935_653), '216,935,653');

  const totalCompactBody = appSource.slice(
    appSource.indexOf('function updateTotalCompact('),
    appSource.indexOf('function hideTotalCompact(')
  );
  assert.match(totalCompactBody, /state\.settings\?\.showCompactTotalTokens !== true/);
  assert.doesNotMatch(totalCompactBody, /detailTokensUseCompactUnits/);
  const animateTotalBody = appSource.slice(
    appSource.indexOf('function animateNumber('),
    appSource.indexOf('function animateTotalNumber(')
  );
  assert.match(animateTotalBody, /formatNumber\(to\)/);
  assert.doesNotMatch(animateTotalBody, /formatDetailTokens/);
});
