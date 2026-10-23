'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const electronDir = path.resolve(__dirname, '../../src/electron');

test('Electron surfaces do not create native HTML or SVG tooltips', () => {
  const files = fs.readdirSync(electronDir, { recursive: true })
    .filter(file => /\.(?:js|html)$/.test(file));
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(electronDir, file), 'utf8');
    if (/\.title\s*=(?!=)|\.setAttribute\(\s*['"]title['"]|\stitle=["']|data-i18n-title/.test(source)
      || file.replaceAll('\\', '/') === 'renderer/usageCharts.js' && /<title>/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'use accessible labels/descriptions or app-owned detail tooltips');
});

test('Edge Dock handle paints and hides without creating a native tooltip', () => {
  const source = fs.readFileSync(path.join(electronDir, 'renderer/edgeDock/dock.js'), 'utf8');
  const start = source.indexOf('function renderPeek(');
  const end = source.indexOf("\nif (surface === 'peek')", start);
  const root = {
    dataset: {}, style: {}, attributes: {}, classes: new Set(),
    setAttribute(name, value) { this.attributes[name] = value; },
    classList: { toggle(name, on) { if (on) root.classes.add(name); else root.classes.delete(name); } }
  };
  const contentLayer = { firstChild: {}, replaceChildren() { this.firstChild = null; } };
  const payload = { side: 'left', peekMode: 'handle', zoom: 1, peeking: true, shape: { width: 10, height: 88 } };
  const context = {
    root, contentLayer, state: { payload }, bridge: { peekPainted() {} },
    requestAnimationFrame: callback => callback(), t: () => 'Edge Dock'
  };
  vm.runInNewContext(`${source.slice(start, end)}\nrenderPeek(state.payload);`, context);
  assert.equal(root.title, undefined);
  assert.equal(root.attributes.title, undefined);
  assert.equal(root.attributes['aria-label'], 'Edge Dock');
  assert.equal(contentLayer.firstChild, null);
  payload.peeking = false;
  context.renderPeek(payload);
  assert.equal(root.classes.has('is-handle-hidden'), true);
  assert.equal(root.title, undefined);
});
