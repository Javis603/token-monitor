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

test('icon-only tool health disclosures keep an action and client in their name', () => {
  const render = section(app, 'renderToolPreferencesNow', 'connectLimitProviderCheckboxName');
  const start = render.indexOf("const main = document.createElement('button');");
  const end = render.indexOf("const panel = document.createElement('div');", start);
  const button = vm.runInNewContext(`${render.slice(start, end)}\nmain;`, { document, id: 'codex', label: 'Codex', expanded: false, t });
  assert.equal(button.getAttribute('aria-label'), t('settings.tools.health.open', { name: 'Codex' }));
  assert.equal(button.children[0].getAttribute('aria-hidden'), 'true');
  assert.equal(button.getAttribute('title'), null);
});

test('the OpenCode detected-account checkbox has a localized name and description', async () => {
  const list = new Element();
  const context = {
    document: { ...document, getElementById: id => id === 'opencodeProfileList' ? list : null },
    state: { settings: {} }, t, isSettingsSurfaceVisible: () => true,
    renderAccountShellError() {}, renderSettingsSummaries() {}, updateOpenCodeProfilesStatus() {},
    accountProfileRequests: { begin: () => () => true }, accountProfileStatuses: { retire() {} },
    opencodeMergeOffer: () => ({}),
    window: { tokenMonitor: { opencode: { getProfiles: async () => ({ profiles: {}, hasAmbientKey: true }) } } }
  };
  vm.runInNewContext(`${section(app, 'renderOpenCodeProfiles', 'opencodeSaveErrorText')}\nrenderOpenCodeProfiles();`, context);
  await new Promise(resolve => setImmediate(resolve));
  const checkbox = list.children[0].children[0];
  assert.equal(checkbox.type, 'checkbox');
  assert.equal(checkbox.getAttribute('aria-label'), t('settings.opencode.ambientName'));
  assert.equal(checkbox.getAttribute('aria-description'), t('settings.opencode.ambientDetail'));
  assert.equal(checkbox.getAttribute('title'), null);
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
    serviceStatusRows: () => [{ id: 'openai', label: 'OpenAI', status: 'degraded' }],
    serviceStatusLabel: () => 'Degraded', serviceStatusMeta: () => '2 components',
    serviceStatusPresentationApi: { statusHeadline: () => 'Incident', affectedComponentNames: () => ({ all: ['API', 'ChatGPT'] }) }
  };
  // The source boundary also includes the next async function's prefix.
  const source = section(app, 'renderServiceStatus', 'refreshServiceStatus').replace(/async\s*$/, '');
  vm.runInNewContext(`${source}\nrenderServiceStatus();`, context);
  const button = panel.children[0];
  assert.ok(button.getAttribute('aria-description').includes(t('serviceStatus.openPage', { name: 'OpenAI' })));
  assert.ok(button.getAttribute('aria-description').includes('API'));
  assert.ok(button.getAttribute('aria-description').includes('ChatGPT'));
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
    clientColors: { codex: 'blue' }, bindHoverMarquee() {}, formatCompact: String, homeSessionAgo: () => '',
    limitWindowsView: {}, sessionRowsApi: require('../../src/electron/renderer/sessionRows'),
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
