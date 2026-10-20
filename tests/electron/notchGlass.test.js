'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { normalizeNotchStyle } = require('../../src/electron/notch/controller');
const { notchGlassGeometry } = require('../../src/electron/renderer/notch/renderer');

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
  const context = { shapeLayer, notchGlassGeometry, state: { payload: { geometry, appearance: { zoomFactor: zoom } } },
    document: { createElementNS: () => { created++; return new Node(); } } };
  return { context, shapeLayer, paint: vm.runInNewContext(`${code}; paintHardwareShade`, context), created: () => created };
}

test('missing or invalid Notch styles inherit while explicit selections stay unchanged', () => {
  for (const value of [undefined, null, '', 'invalid']) assert.equal(normalizeNotchStyle(value), 'inherit');
  for (const value of ['black', 'inherit', 'vibrancy', 'liquid-glass', 'liquid-glass-clear']) assert.equal(normalizeNotchStyle(value), value);
});

test('glass proportions adapt to short, tall and screen-limited bodies without scaling the camera band', () => {
  const baseline = notchGlassGeometry(32, 143);
  const capRatio = (baseline.capEnd - 32) / 143;
  const fadeRatio = (baseline.fadeEnd - baseline.capEnd) / 143;
  for (const camera of [24, 32, 40]) {
    for (const height of [1, 20, 80, 143, 240, 480, 960]) {
      const profile = notchGlassGeometry(camera, height);
      assert.ok(profile.capEnd > camera && profile.capEnd < profile.fadeEnd);
      assert.ok(profile.fadeEnd < camera + height, 'every nonempty body retains a lower glass region');
      assert.ok(Math.abs((profile.capEnd - camera) / height - capRatio) < 1e-12);
      assert.ok(Math.abs((profile.fadeEnd - profile.capEnd) / height - fadeRatio) < 1e-12);
      assert.equal(profile.rimTop, camera);
      assert.equal(profile.rimBottom, camera + height);
    }
  }
  assert.deepEqual(notchGlassGeometry(32, 0), { capEnd: 32, fadeEnd: 32, rimTop: 32, rimBottom: 32 });
});

test('a normal panel reveals glass before the lower content instead of only at its bottom edge', () => {
  const profile = notchGlassGeometry(32, 200);
  assert.equal(profile.capEnd, 80);
  assert.equal(profile.fadeEnd, 180);
  assert.ok(profile.rimBottom - profile.fadeEnd >= 50, 'the final quarter of the body retains the clear material');
});

test('shade proportions use the current frame once, independently of the configured zoom', () => {
  const f = shadeFixture();
  for (const height of [20, 143, 480, 40]) {
    f.paint({ shape: { d: `shape-${height}` }, bodyHeight: height });
    const gradient = f.shapeLayer.querySelector('#notch-hardware-gradient');
    const bounds = [gradient.attributes.y1, gradient.attributes.y2];
    for (const zoom of [0.75, 1, 1.5]) {
      f.context.state.payload.appearance.zoomFactor = zoom;
      f.paint({ shape: { d: `shape-${height}` }, bodyHeight: height });
      assert.deepEqual([gradient.attributes.y1, gradient.attributes.y2], bounds, 'frame dimensions already contain zoom');
    }
  }
});

test('the shade and lower rim follow every outline while a thicker cap always covers the camera', () => {
  const f = shadeFixture();
  f.paint({ shape: { d: 'closed-shape' }, bodyHeight: 0 });
  const gradient = f.shapeLayer.querySelector('#notch-hardware-gradient');
  const shade = f.shapeLayer.querySelector('.notch-hardware-shade');
  const rim = f.shapeLayer.querySelector('.notch-glass-rim');
  const rimGradient = f.shapeLayer.querySelector('#notch-rim-gradient');
  const created = f.created();
  assert.equal(shade.attributes.d, 'closed-shape');
  assert.equal(Number(gradient.attributes.y1), 32);
  for (const [height, zoom] of [[80, 0.85], [143, 1], [240, 1.5]]) {
    f.context.state.payload.appearance.zoomFactor = zoom;
    f.paint({ shape: { d: `shape-${height}` }, bodyHeight: height });
    assert.equal(shade.attributes.d, `shape-${height}`, 'shade cannot lag behind the animated material outline');
    assert.ok(Number(gradient.attributes.y1) > 32, 'the black cap extends below the physical camera');
    assert.ok(Number(gradient.attributes.y1) < 32 + height / 2, 'short panels retain room for glass');
    assert.ok(Number(gradient.attributes.y2) > 32 && Number(gradient.attributes.y2) < 32 + height, 'the lower body reveals the chosen material');
    assert.equal(rim.attributes.d, shade.attributes.d, 'the highlight cannot lag behind the animated outline');
    assert.equal(Number(rimGradient.attributes.y1), 32, 'the rim never rescales the physical camera height');
    assert.equal(Number(rimGradient.attributes.y2), 32 + height, 'the strongest highlight stays on the lower edge');
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
  const window = { addEventListener() {}, TokenMonitorNotchPanel: { createNotchPanel: () => ({}) }, TokenMonitorUsageCharts: { clientColors: {} }, TokenMonitorPressActivation: {}, TokenMonitorEdgeDockPresentation: {}, TokenMonitorThemePresets: require('../../src/electron/renderer/themePresets') };
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
});

test('native shade ownership changes before any deferred panel render', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/notch/renderer.js'), 'utf8');
  const createNotchRenderer = vm.runInNewContext(`${source}; module.exports.createNotchRenderer`, {
    module: { exports: {} }, ResizeObserver: class { observe() {} disconnect() {} }
  });
  const classes = new Map();
  const renderer = createNotchRenderer({
    document: { documentElement: { classList: { toggle() {} } } },
    window: { addEventListener() {}, TokenMonitorNotchPanel: { createNotchPanel: () => ({}) },
      TokenMonitorUsageCharts: { clientColors: {} }, TokenMonitorEdgeDockPresentation: {} },
    state: {}, root: { classList: { toggle: (key, value) => classes.set(key, value) } },
    bridge: { onAnimate() {}, onMotion() {} }, shared: {}
  });
  const payload = { nativeHardwareShade: true, style: 'liquid-glass-clear', geometry: { notched: true }, appearance: {} };
  renderer.applyAppearance(payload);
  assert.equal(classes.get('has-native-hardware-shade'), true);
  renderer.applyAppearance({ ...payload, nativeHardwareShade: false, glass: false, liquidGlass: false });
  assert.equal(classes.get('has-native-hardware-shade'), false, 'SVG fallback is restored even while panel content is held');
});
