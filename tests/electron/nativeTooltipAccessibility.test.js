'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { translate } = require('../../src/electron/renderer/i18n');
const renderer = path.resolve(__dirname, '../../src/electron/renderer');
const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8');
const t = (key, values) => translate('en', key, values);

function section(source, name, next) {
  const start = source.indexOf(`function ${name}(`);
  const end = next ? source.indexOf(`function ${next}(`, start) : source.indexOf('\n  return {', start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end);
}

class Element {
  constructor() {
    this.children = []; this.attributes = {}; this.dataset = {}; this.handlers = {};
    this.classes = new Set(); this.style = { setProperty() {} };
    this.classList = {
      add: name => this.classes.add(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
      contains: name => this.classes.has(name)
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  get childElementCount() { return this.children.length; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  querySelectorAll(selector) {
    const name = selector.slice(1);
    return this.children.flatMap(child => [
      ...((child.className || '').split(' ').includes(name) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
}
const document = { createElement: () => new Element(), createTextNode: text => Object.assign(new Element(), { textContent: text }) };

test('tool health disclosures keep an action and client in their name', () => {
  const render = section(app, 'renderToolPreferencesNow', 'connectLimitProviderCheckboxName');
  const start = render.indexOf("      main = document.createElement('button');");
  const end = render.indexOf("const panel = document.createElement('div');", start);
  const disclosure = new Element();
  const button = vm.runInNewContext(`let main;\n${render.slice(start, end)}\nmain;`, { document, disclosure, id: 'codex', label: 'Codex', expanded: false, t });
  assert.equal(button.getAttribute('aria-label'), t('settings.tools.health.open', { name: 'Codex' }));
  assert.equal(disclosure.children[0].className, 'cursor-disclosure-icon');
  assert.equal(button.getAttribute('title'), null);
  // The chevron column is decorative; the button's name says what it opens.
  assert.match(render, /disclosure\.className = 'tool-preference-chevron';\n\s*disclosure\.setAttribute\('aria-hidden', 'true'\);/);
});

test('the OpenCode detected-account checkbox has a localized name and description', async () => {
  const ownerDocument = require('./accountOwnerDom.fixture.cjs').createDocument();
  const createElement = ownerDocument.createElement;
  ownerDocument.createElement = tag => { const node = createElement(tag); node.appendChild = child => node.append(child); return node; };
  const list = ownerDocument.createElement('div'); list.id = 'opencodeProfileList'; ownerDocument.root.append(list);
  list.before = node => ownerDocument.root.insertBefore(node, list);
  const context = {
    document: ownerDocument, initial: {}, getSettings: () => ({}), getAccountContext: () => ({ settings: {} }), preserveScroll: fn => fn(), localProviderStatuses: () => [],
    state: { settings: {} }, accountShellApi: require('../../src/electron/renderer/limits/accountShell'), encodeURIComponent, t, isSettingsSurfaceVisible: () => true,
    renderAccountShellError() {}, renderSettingsSummaries() {}, updateOpenCodeProfilesStatus() {},
    accountProfileRequests: { begin: () => () => true }, accountProfileStatuses: { retire() {}, begin: () => () => true },
    opencodeMergeOffer: () => ({}),
    window: { TokenMonitorLegacyAccountList: require('../../src/electron/renderer/limits/legacyAccountList'), tokenMonitor: { opencode: { getProfiles: async () => ({ profiles: {}, hasAmbientKey: true }), status: async () => ({ profiles: {} }) } } }
  };
  require('../../src/electron/renderer/limits/providerOwners/opencode').create(context).renderOpenCodeProfiles();
  await new Promise(resolve => setImmediate(resolve));
  const checkbox = list.children[0].children[0];
  assert.equal(checkbox.type, 'checkbox');
  assert.equal(checkbox.attributes['aria-label'], t('settings.opencode.ambientName'));
  assert.equal(checkbox.attributes['aria-description'], t('settings.opencode.ambientDetail'));
  assert.equal(checkbox.attributes.title, undefined);
});

test('shortcut names follow the saved value, empty state and recording state', () => {
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const tag = html.match(/<button id="windowToggleShortcutValue"[^>]*>/)[0];
  const value = new Element();
  for (const [, name, text] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) value.setAttribute(name, text);
  const state = { settings: { windowToggleShortcut: 'Control+Shift+T' }, recordingWindowShortcut: false };
  const context = {
    state, t, els: { windowToggleShortcutValue: value, windowToggleShortcutNote: new Element() },
    normalizeWindowToggleShortcutValue: shortcut => shortcut || '',
    windowShortcutApi: { formatWindowToggleShortcut: (shortcut, fallback) => shortcut || fallback }
  };
  vm.runInNewContext(section(app, 'syncWindowShortcutStatus', 'stopWindowShortcutRecording'), context);
  for (const [shortcut, recording, expected] of [
    ['Control+Shift+T', false, 'Control+Shift+T'], ['', false, t('settings.shortcut.record')],
    ['Control+Shift+T', true, t('settings.shortcut.recording')]
  ]) {
    state.settings.windowToggleShortcut = shortcut; state.recordingWindowShortcut = recording;
    context.syncWindowShortcutStatus();
    assert.equal(value.getAttribute('aria-label') || value.textContent, expected);
    assert.equal(value.getAttribute('aria-description'), t('settings.shortcut.record'));
  }
});

test('idle refresh names retain both the action and the last refresh time', () => {
  const button = new Element();
  const context = { t, state: { stats: { updatedAt: '2026-10-22T12:34:00Z' } }, els: { refreshButton: button }, formatTime: () => '12:34' };
  vm.runInNewContext(`${section(app, 'refreshButtonIdleTitle', 'clearRefreshButtonFeedbackTimer')}\n${section(app, 'setRefreshButtonState', 'settleRefreshButtonState')}`, context);
  context.setRefreshButtonState('idle');
  assert.ok(button.getAttribute('aria-label').includes(t('refreshButton.label')));
  assert.ok(button.getAttribute('aria-label').includes('12:34'));
  context.state.stats = null;
  context.setRefreshButtonState('idle');
  assert.equal(button.getAttribute('aria-label'), t('refreshButton.label'));
  for (const [state, key] of [['refreshing', 'refreshing'], ['refreshed', 'refreshed'], ['error', 'failed']]) {
    context.setRefreshButtonState(state);
    assert.equal(button.getAttribute('aria-label'), t(`refreshButton.${key}`));
  }
});

test('service status buttons describe their affected components', () => {
  const panel = new Element();
  const context = {
    document, t, state: { settings: {} }, els: { serviceStatusPanel: panel },
    serviceStatusSurfaceVisible: () => true,
    currentLocale: () => 'en',
    serviceStatusRows: () => [{ id: 'openai', label: 'OpenAI', status: 'degraded', incidentTitle: 'Incident', componentIssues: [{ name: 'API' }, { name: 'ChatGPT' }] }],
    serviceStatusLabel: () => 'Degraded', serviceStatusMeta: () => '2 components',
    serviceStatusPresentationApi: require('../../src/electron/renderer/serviceStatusPresentation')
  };
  // The source boundary also includes the next async function's prefix.
  const source = section(app, 'renderServiceStatus', 'refreshServiceStatus').replace(/async\s*$/, '');
  vm.runInNewContext(`${source}\nrenderServiceStatus();`, context);
  const button = panel.children[0];
  assert.ok(button.getAttribute('aria-description').includes(t('serviceStatus.openPage', { name: 'OpenAI' })));
  assert.ok(button.getAttribute('aria-description').includes('API'));
  assert.ok(button.getAttribute('aria-description').includes('ChatGPT'));
});

test('DeepSeek rerenders its headline and accessible component names after a language switch', () => {
  const panel = new Element();
  let locale = 'zh-CN';
  const context = {
    document, t, state: { settings: {} }, els: { serviceStatusPanel: panel },
    currentLocale: () => locale,
    serviceStatusSurfaceVisible: () => true,
    serviceStatusRows: () => [{
      id: 'deepseek', label: 'DeepSeek', status: 'outage',
      incidentTitle: 'DeepSeek 网页/API 部分中断（DeepSeek Web/API Partially Unavailable）',
      componentIssues: [{ name: 'DeepSeek V4 Pro API服务(API Service)' }]
    }],
    serviceStatusLabel: () => 'Outage', serviceStatusMeta: () => '1 component',
    serviceStatusPresentationApi: require('../../src/electron/renderer/serviceStatusPresentation')
  };
  const source = section(app, 'renderServiceStatus', 'refreshServiceStatus').replace(/async\s*$/, '');
  const render = () => vm.runInNewContext(`${source}\nrenderServiceStatus();`, context);
  render();
  assert.equal(panel.querySelectorAll('.service-status-description')[0].textContent, 'DeepSeek 网页/API 部分中断');
  assert.match(panel.children[0].getAttribute('aria-description'), /DeepSeek V4 Pro API服务/);
  locale = 'zh-TW';
  render();
  assert.equal(panel.querySelectorAll('.service-status-description')[0].textContent, 'DeepSeek Web/API Partially Unavailable');
  assert.match(panel.children[0].getAttribute('aria-description'), /DeepSeek V4 Pro API Service/);
  assert.doesNotMatch(panel.children[0].getAttribute('aria-description'), /服务/);
});

test('named Dock session states are exposed while quiet decorations stay hidden', () => {
  const dock = fs.readFileSync(path.join(renderer, 'edgeDock/dock.js'), 'utf8');
  const context = { t, el: () => new Element(), SESSION_STATE_GLYPHS: '', lastActivityBySession: new Map() };
  vm.runInNewContext(section(dock, 'stateMark', 'sessionsNode'), context);
  for (const [state, key] of [['running', 'running'], ['waiting', 'waiting'], ['ended', 'finished']]) {
    const mark = context.stateMark({}, 'session', state);
    assert.equal(mark.getAttribute('aria-hidden'), 'false');
    assert.equal(mark.getAttribute('role'), 'img');
    assert.equal(mark.getAttribute('aria-label'), t(`session.${key}`));
  }
  const quiet = context.stateMark({}, 'quiet', 'idle');
  assert.equal(quiet.getAttribute('aria-hidden'), 'true');
  assert.equal(quiet.getAttribute('aria-label'), null);
});

test('Home session rows expose named states and keep idle marks decorative', () => {
  const body = new Element();
  const module = new Element();
  module.append(body);
  const context = {
    document, t, els: { homePanel: { querySelector: () => null } }, state: { settings: {} },
    homeModuleShell: () => ({ module, body }), applyHomeListMark() {}, iconKindFor: () => 'codex',
    clientColors: { codex: 'blue' }, bindHoverMarquee() {}, formatCompact: String, homeSessionAgo: () => '', homeSessionAgoShort: () => '',
    limitWindowsView: {}, sessionRowsApi: require('../../src/electron/renderer/sessionRows'),
    homeModulePreferencesApi: require('../../src/electron/renderer/homeModulePreferences'),
    window: {
      TokenMonitorSessionLive: require('../../src/shared/sessionLive'),
      TokenMonitorEdgeDockPresentation: {
        sessionActivityState: row => row.activityState, runningSessionSummary: () => ({ count: 1 })
      }
    }
  };
  vm.runInNewContext(section(app, 'renderHomeSessionModule', 'renderHomeDeviceModule'), context);
  const states = ['running', 'waiting', 'ended', 'idle'];
  context.renderHomeSessionModule(states.map(activityState => ({ key: activityState, client: 'codex', activityState })));
  const marks = module.querySelectorAll('.home-session-state');
  assert.equal(marks.length, states.length);
  for (const [index, key] of ['running', 'waiting', 'finished'].entries()) {
    assert.equal(marks[index].getAttribute('aria-hidden'), 'false');
    assert.equal(marks[index].getAttribute('role'), 'img');
    assert.equal(marks[index].getAttribute('aria-label'), t(`session.${key}`));
    assert.equal(marks[index].getAttribute('title'), null);
  }
  assert.equal(marks[3].getAttribute('aria-hidden'), 'true');
  assert.equal(marks[3].getAttribute('role'), null);
  assert.equal(marks[3].getAttribute('aria-label'), null);
});

test('Home sessions lead with live work, head only the recent group and keep finished ones to one line', () => {
  const body = new Element();
  const module = new Element();
  module.append(body);
  const context = {
    deviceIconsApi: require('../../src/electron/renderer/deviceIcons'),
    document, t, els: { homePanel: { querySelector: () => null } }, state: { settings: {} },
    homeModuleShell: () => ({ module, body }), applyHomeListMark() {}, iconKindFor: () => 'codex',
    clientColors: { codex: 'blue' }, bindHoverMarquee() {}, formatCompact: String,
    homeSessionAgo: value => `${Math.round((Date.now() - value) / 60_000)} minutes ago`,
    homeSessionAgoShort: () => '20m',
    limitWindowsView: {}, sessionRowsApi: require('../../src/electron/renderer/sessionRows'),
    homeModulePreferencesApi: require('../../src/electron/renderer/homeModulePreferences'),
    window: {
      TokenMonitorSessionLive: require('../../src/shared/sessionLive'),
      TokenMonitorEdgeDockPresentation: {
        sessionActivityState: row => row.activityState, runningSessionSummary: () => ({ count: 1 })
      }
    }
  };
  vm.runInNewContext(section(app, 'renderHomeSessionModule', 'renderHomeDeviceModule'), context);
  const render = (states, at) => {
    body.children = [];
    context.renderHomeSessionModule(states.map(activityState => ({
      key: activityState, client: 'codex', activityState,
      lastUsedAt: typeof at === 'object' ? at?.[activityState] : at
    })));
    return body.children;
  };
  const seenAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const freshAt = new Date(Date.now() - 20_000).toISOString();
  // Live rows that have just spoken carry no age; the quiet ones do.
  const rows = render(['idle', 'running', 'ended', 'waiting'], { idle: seenAt, ended: seenAt, running: freshAt, waiting: freshAt });
  assert.deepEqual(rows.map(row => row.dataset.key), ['running', 'waiting', 'idle', 'ended'], 'live sessions lead, each group keeps its order');
  // Only the recent group is headed; live rows show their state, and the module heading counts the running ones.
  assert.deepEqual(rows.map(row => row.dataset.groupLabel), [undefined, undefined, t('session.recent'), undefined]);
  for (const row of rows.slice(0, 2)) {
    assert.ok(!row.className.includes('is-compact'));
    assert.ok(row.children.some(child => child.className === 'home-session-meta'), 'live rows keep their details');
    // A live row that has just spoken leaves the age to its state mark.
    assert.equal(row.textContent.includes('0 minutes ago'), false, 'a fresh live row carries no age');
    assert.equal(row.textContent.includes('<1m'), false, 'and no short age either');
    assert.equal(row.querySelectorAll('.home-session-ago-inline').length, 0);
  }
  for (const row of rows.slice(2)) {
    assert.ok(row.className.includes('is-compact'));
    assert.equal(row.children.some(child => child.className === 'home-session-meta'), false);
    assert.equal(row.children.at(-2).className, 'home-list-aux home-session-ago', 'one line of title, age and amount');
    assert.equal(row.children.at(-2).textContent, '20m');
    assert.equal(row.children.at(-2).getAttribute('role'), 'img', 'a span needs a role to carry the full age as its name');
    assert.equal(row.children.at(-2).getAttribute('aria-label'), '20 minutes ago');
    assert.equal(row.children.at(-1).className, 'home-list-value', 'the amount stays last, aligned with live rows');
  }
  assert.ok(rows[2].classes.has('starts-recent'));
  body.children = [];
  const remoteDevice = { deviceId: 'imac', name: 'imac-m1', deviceKind: 'desktop' };
  context.renderHomeSessionModule([
    { key: 'family', client: 'codex', activityState: 'running', totalTokens: 30, models: { codex: 30 },
      lastUsedAt: new Date(Date.now() - 2 * 60_000).toISOString(), remoteDevice,
      sessionGroup: 'subagents', subagentGroup: true, subagentCount: 2 },
    { key: 'recent', client: 'codex', activityState: 'ended', totalTokens: 10, lastUsedAt: seenAt, remoteDevice }
  ]);
  const [remoteLive, remoteRecent] = body.children;
  assert.equal(remoteLive.querySelectorAll('.home-session-meta')[0].children[0].textContent, 'imac-m1');
  assert.equal(remoteLive.querySelectorAll('.home-session-ago-inline')[0].textContent, '2m');
  assert.doesNotMatch(remoteLive.textContent, /subagents/);
  assert.equal(remoteRecent.children.at(-3).textContent, 'imac-m1');
  assert.equal(remoteRecent.children.at(-2).textContent, '20m');
  assert.equal(remoteRecent.children.at(-1).textContent, '10');
  // A live row that has gone quiet for most of the running window keeps its
  // reading: "8m" is what separates it from one that is actively working.
  const stalledAt = new Date(Date.now() - 8 * 60_000).toISOString();
  const [stalled] = render(['running'], { running: stalledAt });
  const stalledAge = stalled.querySelectorAll('.home-session-ago-inline');
  assert.equal(stalledAge.length, 1, 'a stalled live row keeps its age');
  assert.equal(stalled.textContent.includes('8m'), true);
  assert.equal(stalledAge[0].getAttribute('aria-label'), '8 minutes ago');
  // A single group needs no headings.
  for (const states of [['running', 'waiting'], ['idle', 'ended']]) {
    assert.deepEqual(render(states).map(row => row.dataset.groupLabel), [undefined, undefined]);
  }
  // Detailed gives every session its details, in the order received, under no heading.
  context.state.settings.homeSessionDisplayMode = 'detailed';
  const detailed = render(['idle', 'running', 'ended', 'waiting'], seenAt);
  assert.deepEqual(detailed.map(row => row.dataset.key), ['idle', 'running', 'ended', 'waiting']);
  for (const row of detailed) {
    assert.ok(!row.className.includes('is-compact'));
    assert.ok(row.children.some(child => child.className === 'home-session-meta'));
    assert.equal(row.dataset.groupLabel, undefined);
  }
  // Detailed drops the heading but keeps every row's age, live ones included:
  // running spans up to ten minutes of quiet, so the reading still separates an
  // active session from a stalled one.
  const ageSpan = (row) => row.querySelectorAll('.home-session-ago-inline')[0];
  for (const key of ['idle', 'running', 'ended', 'waiting']) {
    const span = ageSpan(detailed.find((row) => row.dataset.key === key));
    assert.ok(span, `${key} keeps its age`);
    assert.equal(span.textContent, '20m', 'the row shows the short age');
    assert.equal(span.getAttribute('role'), 'img', 'a span needs a role to carry the full age as its name');
    assert.equal(span.getAttribute('aria-label'), '20 minutes ago');
  }
});

test('subscription cost descriptions stay accessible without adding visible disclaimer text', () => {
  const view = fs.readFileSync(path.join(renderer, 'limits/windowsView.js'), 'utf8');
  const note = t('subscription.tooltip.monthUsageNote');
  const context = { document, tooltipHost: { hasOpened: () => false }, attachLimitDetailTooltip() {} };
  vm.runInNewContext(section(view, 'subscriptionCardNode', 'subscriptionCardForRow'), context);
  const card = context.subscriptionCardNode([{ label: 'Month usage', value: '$12.00', title: note }]);
  assert.equal(card.textContent, 'Month usage$12.00');
  assert.equal(card.getAttribute('aria-description'), note);
  context.subscriptionCardForRow = () => card;
  vm.runInNewContext(section(view, 'decoratePlanWithSubscription'), context);
  const plan = Object.assign(new Element(), { textContent: 'Pro' });
  const trigger = context.decoratePlanWithSubscription(plan, {}, false);
  assert.equal(trigger.getAttribute('aria-description'), note);
  assert.equal(trigger.tabIndex, 0);
  assert.equal(trigger.getAttribute('title'), null);
});
