'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { normalizeNotchStyle } = require('../../src/electron/notch/controller');

function shadeFixture(geometry = { notched: true, height: 32 }, zoom = 1) {
  class Node {
    constructor() { this.children = []; this.attributes = {}; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    append(...nodes) { this.children.push(...nodes); }
    querySelector(selector) {
      for (const node of this.children) {
        if (selector[0] === '#' ? node.id === selector.slice(1) : node.attributes.class === selector.slice(1)) return node;
        const nested = node.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const code = source.slice(source.indexOf('function paintHardwareShade('), source.indexOf('function applyNotchMotion('));
  const shapeLayer = new Node();
  let created = 0;
  const context = { shapeLayer, state: { payload: { geometry, appearance: { zoomFactor: zoom } } },
    document: { createElementNS: () => { created++; return new Node(); } } };
  return { context, shapeLayer, paint: vm.runInNewContext(`${code}; paintHardwareShade`, context), created: () => created };
}

test('missing or invalid Notch styles inherit while explicit selections stay unchanged', () => {
  for (const value of [undefined, null, '', 'invalid']) assert.equal(normalizeNotchStyle(value), 'inherit');
  for (const value of ['black', 'inherit', 'vibrancy', 'liquid-glass', 'liquid-glass-clear']) assert.equal(normalizeNotchStyle(value), value);
});

test('the hardware shade shares every outline and remains anchored to camera height through resizing', () => {
  const f = shadeFixture();
  f.paint({ shape: { d: 'closed-shape' }, bodyHeight: 0 });
  const gradient = f.shapeLayer.querySelector('#notch-hardware-gradient');
  const shade = f.shapeLayer.querySelector('.notch-hardware-shade');
  const created = f.created();
  assert.equal(shade.attributes.d, 'closed-shape');
  assert.equal(Number(gradient.attributes.y1), 32);
  for (const [height, zoom] of [[80, 0.85], [143, 1], [240, 1.5]]) {
    f.context.state.payload.appearance.zoomFactor = zoom;
    f.paint({ shape: { d: `shape-${height}` }, bodyHeight: height });
    assert.equal(shade.attributes.d, `shape-${height}`, 'shade cannot lag behind the animated material outline');
    assert.equal(Number(gradient.attributes.y1), 32, 'zoom never rescales the physical camera band');
    assert.ok(Number(gradient.attributes.y2) > 32 && Number(gradient.attributes.y2) < 32 + height, 'the lower body reveals the chosen material');
    assert.equal(f.created(), created, 'animation frames reuse the gradient and path');
  }
});

test('camera-free capsules do not acquire a hardware shade', () => {
  const f = shadeFixture({ notched: false, height: 32 });
  f.paint({ shape: { d: 'capsule' }, bodyHeight: 175 });
  assert.equal(f.created(), 0);
});

test('light widget palettes get readable ink only on the attached glass surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const classes = new Map();
  const create = vm.runInNewContext(`${source};module.exports.createNotchRenderer`, { module: { exports: {} }, ResizeObserver: class { observe() {} disconnect() {} } });
  const window = { addEventListener() {}, TokenMonitorPressActivation: {}, TokenMonitorEdgeDockPresentation: {}, TokenMonitorThemePresets: require('../../src/electron/renderer/themePresets') };
  const deps = { document: { documentElement: { classList: { toggle: (key, value) => classes.set(key, value) } } },
    window, state: {}, root: { classList: { toggle() {} }, addEventListener() {} }, shared: {}, bridge: { onAnimate() {}, onMotion() {} } };
  const renderer = create({ ...deps, surface: 'notch' });
  const payload = { style: 'inherit', geometry: { notched: true }, appearance: { themeColors: { bg: '#f6f1e7' } } };
  renderer.applyAppearance(payload);
  assert.equal(classes.get('notch-hardware-light'), true);
  renderer.applyAppearance({ ...payload, style: 'black' });
  assert.equal(classes.get('notch-hardware-light'), false, 'pure black keeps its own palette');
  renderer.applyAppearance({ ...payload, geometry: { notched: false } });
  assert.equal(classes.get('notch-hardware-light'), false, 'capsules keep the selected theme');
  const detail = create({ ...deps, surface: 'bubble' });
  detail.applyAppearance(payload);
  assert.equal(classes.get('notch-hardware-light'), false, 'detail cards do not get the camera palette');
});
