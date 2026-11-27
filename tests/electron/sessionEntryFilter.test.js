'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const start = app.indexOf('function sessionEntryValues(');
const end = app.indexOf('\n}', app.indexOf('function renderSessionEntryFilter(')) + 2;

function setup(rows, { sessionEntryFilter = '', focusedEntry } = {}) {
  const document = { activeElement: null };
  function element() {
    return {
      dataset: {}, attributes: {}, children: [], hidden: true,
      textContent: '',
      classList: { toggle(name, enabled) { if (name === 'hidden') host.hidden = enabled; } },
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      append(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      contains(node) { return this.children.includes(node); },
      addEventListener(_type, handler) { this.click = handler; },
      focus() { document.activeElement = this; }
    };
  }
  const host = element();
  document.createElement = element;
  if (focusedEntry !== undefined) {
    document.activeElement = { dataset: { entry: focusedEntry } };
    host.children.push(document.activeElement);
  }
  const state = { sessionEntryFilter, sessionPage: 2, rowSignature: 'x' };
  const els = { sessionEntryFilter: host, breakdown: { scrollTop: 42 } };
  let scheduled = 0;
  const timers = [];
  const filter = Function('state', 'els', 'document', 'currentLocale', 't',
    'sessionEntryLabels', 'render', 'setTimeout',
    `${app.slice(start, end)}; return { filter: renderSessionEntryFilter, values: sessionEntryValues };`)(
    state, els, document, () => 'en', key => key,
    () => ({ t3: 'T3 Code', 'codex-cli': 'Codex CLI', 'antigravity-cli': 'Antigravity CLI' }),
    () => { throw new Error('render must not run synchronously'); },
    (handler) => { scheduled += 1; timers.push(handler); return timers.length; });
  return { state, els, document, host, filter: filter.filter, values: filter.values, scheduled: () => scheduled, timers, runTimer: () => { const fn = timers.shift(); if (fn) fn(); } };
}

test('summary rows speak only through their members so fully attributed groups offer no Unknown', () => {
  const summaryAllAttributed = { kind: 'summary', client: 'codex', groupRows: [
    { client: 'codex', sessionEntry: 'codex-cli' },
    { client: 'codex', sessionEntry: 'codex-cli' }
  ] };
  const ui = setup([summaryAllAttributed]);
  ui.filter([summaryAllAttributed]);
  assert.deepEqual(ui.host.children.map(button => button.dataset.entry), ['', 'codex-cli'],
    'no unknown chip without an unattributed member');
  assert.deepEqual(ui.values(summaryAllAttributed), ['codex-cli', 'codex-cli']);

  const summaryWithUnattributed = { kind: 'summary', client: 'codex', groupRows: [
    { client: 'codex', sessionEntry: 'codex-cli' },
    { client: 'codex' }
  ] };
  const ui2 = setup([summaryWithUnattributed]);
  ui2.filter([summaryWithUnattributed]);
  assert.ok(ui2.host.children.some(button => button.dataset.entry === 'unknown'));
  assert.deepEqual(ui2.values(summaryWithUnattributed), ['codex-cli', '']);
});

test('session rows keep their own entry beside their folded members', () => {
  const group = { kind: 'session', client: 'codex', sessionEntry: 't3', groupRows: [
    { client: 'codex', sessionEntry: 't3' },
    { client: 'codex' }
  ] };
  const ui = setup([group]);
  ui.filter([group]);
  assert.deepEqual(ui.values(group), ['t3', 't3', '']);
  assert.ok(ui.host.children.some(button => button.dataset.entry === 'unknown'));
});

test('a stale selection is cleared and one rebuild is scheduled, not run inline', () => {
  const rows = [{ kind: 'session', client: 'codex', sessionEntry: 'codex-cli' }];
  const ui = setup(rows, { sessionEntryFilter: 't3' });
  ui.filter(rows);
  assert.equal(ui.state.sessionEntryFilter, '');
  assert.equal(ui.state.sessionPage, 0);
  assert.equal(ui.scheduled(), 1, 'exactly one rebuild scheduled');
  // The timer decides whether a render is due; render itself is never called
  // synchronously from inside the filter pass.
  ui.runTimer();
});

test('keyboard focus returns to the replacement button for the same entry', () => {
  const rows = [{ kind: 'session', client: 'codex', sessionEntry: 't3' },
    { kind: 'session', client: 'codex', sessionEntry: 'codex-cli' }];
  const ui = setup(rows, { sessionEntryFilter: 't3', focusedEntry: 't3' });
  ui.filter(rows);
  assert.equal(ui.document.activeElement.dataset.entry, 't3');
  assert.equal(ui.document.activeElement.getAttribute('aria-pressed'), 'true');
});
