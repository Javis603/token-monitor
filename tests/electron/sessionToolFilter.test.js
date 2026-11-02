'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const start = app.indexOf('function renderSessionToolFilter(');
const end = app.indexOf('\n}', start) + 2;

function setup() {
  const document = { activeElement: null };
  function element() {
    return {
      dataset: {}, attributes: {}, children: [], hidden: true,
      get textContent() { return this._text || ''; },
      set textContent(value) { this._text = value; this.children = []; },
      classList: { toggle(name, enabled) { if (name === 'hidden') host.hidden = enabled; } },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      contains(node) { return this.children.includes(node); },
      addEventListener(_type, handler) { this.click = handler; },
      focus() { document.activeElement = this; }
    };
  }
  const host = element();
  const strip = element();
  strip.scrollLeft = 0;
  strip.clientWidth = 200;
  strip.scrollWidth = 300;
  document.createElement = element;
  const state = { sessionToolFilter: '', sessionPage: 4, settings: {showToolIcons:true} };
  const els = { sessionToolFilter: host, sessionToolFilterItems: strip,
    sessionToolPrevious: element(), sessionToolNext: element(), breakdown: { scrollTop: 42 } };
  let renders = 0;
  const filter = Function('state', 'els', 'document', 'KNOWN_CLIENTS', 'clientLabels', 'clientsWithIcon',
    'currentLocale', 't', 'render', 'updateSessionToolScrollButtons', 'limitWindowsView', 'sessionToolClients', 'toolIconsEnabled', `${app.slice(start, end)}; return renderSessionToolFilter;`)(
    state, els, document, [{ id: 'claude' }, { id: 'codex' }], { claude: 'Claude Code', codex: 'Codex' },
    new Set(['claude', 'codex']), () => 'en', key => key, () => renders++, () => {}, { setDetailTooltip(button) { button.append({className:'limit-detail-tooltip'}); } }, appFunction('sessionToolClients', [], []), value => value === true);
  return { state, els, document, host, strip, filter, renders: () => renders };
}

const rows = [
  { key: 'codex-review', kind: 'summary', client: 'codex', groupRows: [{ client: 'codex' }] },
  { key: 'claude-1', kind: 'session', client: 'claude' },
  { key: 'codex-1', kind: 'session', client: 'codex' }
];

test('tool buttons include grouped sessions, follow catalog order and toggle the filter', () => {
  const ui = setup();
  assert.equal(ui.filter(rows), rows);
  assert.deepEqual(ui.strip.children.map(button => button.dataset.client), ['', 'claude', 'codex']);
  const codex = ui.strip.children[2];
  assert.equal(codex.attributes['aria-label'], 'Codex');
  codex.focus();
  codex.click();
  assert.equal(ui.state.sessionPage, 0);
  assert.equal(ui.els.breakdown.scrollTop, 0);
  assert.equal(ui.renders(), 1);
  assert.deepEqual(ui.filter(rows).map(row => row.key), ['codex-review', 'codex-1']);
  assert.equal(ui.strip.children[2].attributes['aria-pressed'], 'true');
  assert.equal(ui.document.activeElement, ui.strip.children[2]);
  // A live update must keep both the selection and new matching rows.
  assert.equal(ui.filter([...rows, { key: 'new', kind: 'session', client: 'codex' }]).length, 3);
  ui.strip.children[2].click();
  assert.equal(ui.filter(rows), rows);
  ui.strip.children[1].click();
  ui.filter(rows);
  ui.strip.children[0].click();
  assert.equal(ui.filter(rows), rows);
});

test('a changed period with no matching tool resets selection and fallback rows have no toolbar', () => {
  const ui = setup();
  ui.state.sessionToolFilter = 'codex';
  const claudeOnly = [rows[1]];
  assert.equal(ui.filter(claudeOnly), claudeOnly);
  assert.equal(ui.state.sessionToolFilter, '');
  assert.equal(ui.state.sessionPage, 0);
  assert.equal(ui.host.hidden, true, 'one tool needs no filter');
  ui.state.sessionToolFilter = 'claude';
  ui.filter(claudeOnly);
  assert.equal(ui.state.sessionToolFilter, '', 'also clear a still-present sole tool');
  assert.equal(ui.host.hidden, true);
  ui.filter(rows);
  assert.equal(ui.host.hidden, false, 'show the toolbar when multiple tools return');
  const fallback = [{ key: 'model', name: 'model', value: 100 }];
  assert.equal(ui.filter(fallback), fallback);
  assert.equal(ui.host.hidden, true);
  ui.filter([]);
  assert.equal(ui.host.hidden, true);
});

function appFunction(name, parameters, values) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf('\n}', start) + 2;
  return Function(...parameters, `${app.slice(start, end)}; return ${name};`)(...values);
}

test('overflow arrows follow native scroll position and viewport size', () => {
  const classes = new Set();
  const strip = { scrollLeft: 0, clientWidth: 200, scrollWidth: 500 };
  const els = { sessionToolFilterItems: strip,
    sessionToolFilter: { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } },
    sessionToolPrevious: {}, sessionToolNext: {} };
  const update = appFunction('updateSessionToolScrollButtons', ['els'], [els]);
  update();
  assert.equal(classes.has('has-overflow'), true);
  assert.equal(els.sessionToolPrevious.disabled, true);
  assert.equal(els.sessionToolNext.disabled, false);
  strip.scrollLeft = 150;
  update();
  assert.equal(els.sessionToolPrevious.disabled, false);
  assert.equal(els.sessionToolNext.disabled, false);
  strip.scrollLeft = 299.5;
  update();
  assert.equal(els.sessionToolNext.disabled, true);
  strip.scrollLeft = 0;
  strip.clientWidth = 600;
  update();
  assert.equal(classes.has('has-overflow'), false);
  assert.equal(els.sessionToolPrevious.disabled, true);
  assert.equal(els.sessionToolNext.disabled, true);
});

test('arrow clicks request native scrolling and respect reduced motion', () => {
  for (const reduced of [false, true]) {
    const requests = [];
    const els = { sessionToolFilterItems: { clientWidth: 200, scrollBy: options => requests.push(options) } };
    const scroll = appFunction('scrollSessionTools', ['els', 'prefersReducedMotion', 'reducedMotionMedia'], [els, () => reduced, {matches:false}]);
    scroll(1);
    scroll(-1);
    assert.deepEqual(requests, [
      { left: 150, behavior: reduced ? 'instant' : 'smooth' },
      { left: -150, behavior: reduced ? 'instant' : 'smooth' }
    ]);
  }
  assert.doesNotMatch(app, /scrollSessionToolsWithWheel/);
});


test('cross-tool groups remain reachable from every member tool', () => {
  const ui = setup();
  const group = {key:'mixed', kind:'summary', client:'codex', groupRows:[{client:'codex'},{client:'claude'}]};
  assert.equal(ui.filter([group]).length, 1);
  assert.equal(ui.host.hidden, false, 'two tools within one group still offer a filter');
  assert.deepEqual(ui.strip.children.map(button => button.dataset.client), ['', 'claude', 'codex']);
  ui.strip.children[1].click();
  assert.deepEqual(ui.filter([group]), [group]);
});

test('turning off tool icons renders tool labels and invalidates existing buttons', () => {
  const ui = setup();
  ui.filter(rows);
  assert.equal(ui.strip.children[1].children.filter(node=>node.className.includes('row-icon')).length, 1);
  ui.state.settings.showToolIcons = false;
  ui.filter(rows);
  assert.equal(ui.strip.children[1].children.filter(node=>node.className.includes('row-icon')).length, 0);
  assert.equal(ui.strip.children.every(button=>button.children.some(node=>node.className==='limit-detail-tooltip')), true);
  assert.equal(ui.strip.children[1].textContent, 'Claude Code');
});

test('both direct detail render paths hide the list filter immediately', () => {
  for (const name of ['renderSessionDetail', 'renderSessionGroupDetail']) {
    const start = app.indexOf(`function ${name}(`);
    const end = app.indexOf('  const head =', start);
    const hidden = new Set();
    const node = {classList:{add(name) {hidden.add(name);},remove(){}}};
    const els = {sessionToolFilter:node,breakdown:{classList:{add(){}}},sessionDetail:node,sessionDetailHead:node};
    Function('els', `${app.slice(start, end)}\n}; return ${name};`)(els)();
    assert.equal(hidden.has('hidden'), true, name);
  }
});


test('All keeps its attached tooltip when its label is rendered', () => {
  const ui = setup();
  ui.filter(rows);
  assert.equal(ui.strip.children[0].children.some(node=>node.className==='limit-detail-tooltip'), true);
});
