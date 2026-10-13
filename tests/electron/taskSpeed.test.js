'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { if (this.contains(document.activeElement)) document.activeElement = document.body; this.children = nodes; }
    setAttribute() {}
    addEventListener(type, listener) { this.listeners[type] = listener; }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = document.body; }
    querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  }
  const document = { activeElement: null, createElement: tag => new Element(tag), body: new Element('body') };
  const window = {};
  let now = 10000;
  let tick;
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/electron/renderer/taskSpeed'), 'utf8'), {
    window, document, Date: class extends Date { static now() { return now; } },
    setTimeout: callback => { tick = callback; return 1; }, clearTimeout() {}
  });
  const container = new Element('div');
  const text = node => [node.textContent || '', ...node.children.map(text)].join(' ');
  return { create: options => window.TokenMonitorTaskSpeed.createPanel({ container,
    visible: () => true, t: key => key, formatTokens: String, ...options }), text: () => text(container),
    document, nodes: () => container.querySelectorAll(), tick: async () => { now += 5000; tick(); await new Promise(setImmediate); } };
}

test('a new task panel with no sessions displays empty instead of loading', async () => {
  const { create, text } = harness();
  let calls = 0;
  const panel = create({ getSessions: () => [], fetchStats: async () => { calls++; } });
  panel.render();
  await panel.refresh(true);
  assert.match(text(), /detailEmpty/);
  assert.doesNotMatch(text(), /detailLoading/);
  assert.equal(calls, 0);
});

test('an empty session snapshot preserves a previously loaded result', async () => {
  const { create, text } = harness();
  let sessions = [{ key: 'codex:fixture' }];
  const panel = create({ getSessions: () => sessions,
    fetchStats: async () => ({ sessions: [{ key: 'codex:fixture', client: 'codex', title: 'saved result',
      speed: 25, tasks: [], measuredCount: 1, taskCount: 1, outputTokens: 50, durationMs: 2000 }] }) });
  await panel.refresh(true);
  const loaded = text();
  assert.match(loaded, /25 tok\/s/);
  sessions = [];
  await panel.refresh(true);
  assert.equal(text(), loaded);
});

test('five-second refresh keeps keyboard focus on tabs and selectable conversation rows while updating rates', async () => {
  const h = harness();
  let rate = 25;
  const panel = h.create({ getSessions: () => [{ client: 'codex', sessionId: 'fixture' }],
    fetchStats: async () => ({ overall: { speed: rate }, sessions: [{ key: 'codex:fixture', client: 'codex',
      title: 'fixture', speed: rate, tasks: [], measuredCount: 1, taskCount: 1, outputTokens: 50, durationMs: 2000 }] }) });
  await panel.refresh(true);
  panel.render();
  const allTab = () => h.nodes().find(node => node.textContent === 'taskSpeed.allSessions');
  allTab().focus();
  allTab().listeners.click();
  rate = 30;
  await h.tick();
  assert.equal(h.document.activeElement.textContent, 'taskSpeed.allSessions');
  assert.match(h.text(), /30 tok\/s/);
  h.nodes().find(node => node.className === 'detail-exchange task-speed-row').focus();
  rate = 35;
  await h.tick();
  assert.equal(h.document.activeElement.className, 'detail-exchange task-speed-row');
  assert.match(h.text(), /35 tok\/s/);
  h.document.activeElement.listeners.keydown({ key: 'Enter' });
  assert.equal(h.document.activeElement.textContent, 'taskSpeed.currentSession');
});
