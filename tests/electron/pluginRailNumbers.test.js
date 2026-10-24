'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const railApi = require('../../src/electron/renderer/edgeDock/railNumberRoll');
const pluginApi = require('../../src/electron/renderer/edgeDock/pluginRailNumbers');

function harness() {
  const views = new Map(), calls = [], settled = [], timers = [];
  let enabled = true;
  const animation = { duration: 900, capture: node => node.glyphs,
    beginRoll(node, from, to, increasing, _prepare, glyphs) {
      const call = { node, from, to, increasing, glyphs }; calls.push(call);
      return () => settled.push(call);
    } };
  const railNumbers = { ...railApi, create: options => railApi.create({ ...options, schedule: cb => timers.push(cb) }) };
  const adapter = pluginApi.create({ railNumbers, animation, viewFor: ref => views.get(ref), enabled: () => enabled });
  const container = { cells: [], querySelectorAll(selector) {
    if (selector === '[data-plugin-ref]') return this.cells;
    const nodes = this.cells.map(cell => cell.value);
    return selector === '[data-plugin-roll]' ? nodes.filter(n => Object.hasOwn(n.dataset, 'pluginRoll')) : [];
  } };
  function render(specs) {
    container.cells = specs.map(({ ref = 'demo/memory', value = 72, text = `${value}%`, motion, revision = 1, status = 'ok' }) => {
      views.set(ref, { status, revision, compact: { valueNumber: value, motion } });
      const node = { dataset: {}, textContent: text };
      return { dataset: { pluginRef: ref }, value: node, querySelector: () => node };
    });
  }
  const push = (specs, options) => { const before = adapter.capture(container); render(specs); adapter.update(container, before, options); };
  return { adapter, container, calls, settled, timers, push, setEnabled: value => { enabled = value; } };
}

test('two readouts from one plugin independently inherit or opt out of the existing roller', () => {
  const h = harness();
  h.push([{ value: 71 }, { ref: 'demo/cpu', value: 10, motion: 'none' }]);
  assert.equal(h.calls.length, 0, 'first reading is static');
  h.push([{ value: 72 }, { ref: 'demo/cpu', value: 11, motion: 'none' }]);
  assert.deepEqual(h.calls.map(c => [c.from, c.to, c.increasing]), [['71%', '72%', true]]);
  assert.equal(h.container.cells[1].value.dataset.pluginRoll, undefined);
});

test('reduced/hidden/non-roll mode, reveal, revision and unavailable readings never roll', () => {
  for (const kind of ['disabled', 'reveal', 'revision', 'missing', 'text', 'status']) {
    const h = harness(); h.push([{ value: 71 }]);
    if (kind === 'disabled') h.setEnabled(false);
    h.push([{ value: kind === 'missing' ? null : kind === 'text' ? '72' : 72,
      revision: kind === 'revision' ? 2 : 1, status: kind === 'status' ? 'unavailable' : 'ok' }], { revealing: kind === 'reveal' });
    assert.equal(h.calls.length, 0, kind);
  }
});

test('rapid plugin updates retarget visible glyphs and settling releases active work', () => {
  const h = harness(); h.push([{ value: 71 }]); h.push([{ value: 72 }]);
  h.container.cells[0].value.glyphs = [{ char: '2', opacity: 0.5 }];
  h.push([{ value: 70 }]);
  assert.equal(h.settled.length, 1);
  assert.deepEqual(h.calls[1].glyphs, [{ char: '2', opacity: 0.5 }]);
  assert.equal(h.calls[1].increasing, false);
  h.adapter.settle(); assert.equal(h.settled.length, 2);
});

test('numeric comparisons use metadata while localized text remains the final display', () => {
  const h = harness(); h.push([{ value: 842000, text: '84.2萬' }]); h.push([{ value: 841000, text: '84.1萬', motion: 'inherit' }]);
  assert.deepEqual(h.calls.map(c => [c.from, c.to, c.increasing]), [['84.2萬', '84.1萬', false]]);
});

test('rail plugin cells refresh their spoken label when a value repaints in place', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const start = source.indexOf('function pluginCellLabel('), end = source.indexOf('function pluginCellNode(');
  const views = new Map([['demo/cpu', { title: 'CPU', compact: { value: '12%' } }]]);
  const node = { dataset: { pluginRef: 'demo/cpu' }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const empty = { dataset: { pluginRef: 'demo/gone' }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const rail = { querySelectorAll: selector => selector === '.edge-dock-cell-plugin[data-plugin-ref]' ? [node, empty] : [] };
  const context = { pluginHost: { state: (_surface, ref) => views.get(ref) } };
  vm.runInNewContext(source.slice(start, end), context);
  context.refreshPluginCellLabels(rail);
  assert.equal(node.attributes['aria-label'], 'CPU 12%');
  views.set('demo/cpu', { title: 'CPU', compact: { value: '87%' } });
  context.refreshPluginCellLabels(rail);
  assert.equal(node.attributes['aria-label'], 'CPU 87%');
  assert.equal(empty.attributes['aria-label'], 'demo/gone', 'a view without state falls back to its ref');
  assert.doesNotThrow(() => context.refreshPluginCellLabels(null));
  assert.match(source, /pluginHost\?\.update\(payload\);\n\s+surfaceWeb\?\.refresh\(\);\n\s+if \(surface === 'rail'\) \{ refreshPluginCellLabels\(railNode\);/);
});
