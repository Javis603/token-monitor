'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeView, sanitizeDisplayList, LIMITS } = require('../../src/shared/plugins/viewSpec');
const { createResolver, formatValue, toneFor } = require('../../src/shared/plugins/bindings');
const permissions = require('../../src/shared/plugins/permissions');

const ctx = () => ({ metrics: new Set(['pulse', 'tpm']) });

test('display lists keep only drawing ops with literal colours or theme tones', () => {
  const errors = [];
  const list = sanitizeDisplayList([
    { op: 'rect', x: 0, y: 0, w: 10, h: 5, fill: 'accent', r: 9 },
    { op: 'rect', x: 0, y: 0, w: 10, h: 5, fill: 'url(https://evil.test/x)' },
    { op: 'image', href: 'https://evil.test/pixel.png' },
    { op: 'path', d: 'M0 0 L10 10 Z', stroke: '#ff00ff', sw: 2 },
    { op: 'path', d: 'M0 0 url(https://evil.test)' },
    { op: 'text', x: 1, y: 2, text: 'hi\u0007there', fill: 'warn', size: 400 },
    { op: 'poly', points: [0, 0, 5, 5, 10] }
  ], errors);
  assert.deepEqual(list.map((op) => op.op), ['rect', 'rect', 'path', 'text']);
  assert.equal(list[0].r, 2.5, 'radius clamps to the box');
  assert.equal(list[1].fill, undefined, 'a url() paint is dropped, not passed through');
  assert.equal(list[3].text, 'hi there');
  assert.equal(list[3].size, 48);
  assert.ok(errors.some((error) => /unknown op "image"/.test(error)));
  assert.ok(errors.some((error) => /path data rejected/.test(error)));
});

test('display lists are bounded in ops and path length', () => {
  const many = Array.from({ length: LIMITS.drawOps + 50 }, (_, index) => ({ op: 'circle', cx: index, cy: 1, r: 1 }));
  assert.equal(sanitizeDisplayList(many).length, LIMITS.drawOps);
  const long = 'M0 0 ' + 'L1 1 '.repeat(2000);
  const paths = sanitizeDisplayList([{ op: 'path', d: long }, { op: 'path', d: long }]);
  assert.ok(paths.length <= 1);
});

test('views validate components, drop unknown props and collect their sources', () => {
  const errors = [];
  const view = normalizeView({
    id: 'pulse',
    title: { en: 'Pulse', 'zh-TW': '脈搏' },
    surfaces: ['home', 'notch', 'nowhere'],
    layout: {
      type: 'stack', dir: 'row', onclick: 'alert(1)', style: 'background:url(x)',
      children: [
        { type: 'stat', value: { $: '@tpm', fmt: 'compact' }, label: 'TPM', html: '<b>x</b>' },
        { type: 'iframe', src: 'https://evil.test' },
        { type: 'draw', width: 4000, height: 50, list: { $: '@pulse' } },
        { type: 'sparkline', series: { $: 'sys.cpu', history: 500 } }
      ]
    }
  }, ctx(), errors);
  assert.deepEqual(view.surfaces, ['home', 'notch']);
  assert.equal(view.layout.onclick, undefined);
  assert.equal(view.layout.style, undefined);
  assert.equal(view.layout.children.length, 3);
  assert.equal(view.layout.children[0].html, undefined);
  assert.equal(view.layout.children[1].width, 640);
  assert.equal(view.layout.children[2].series.history, 120);
  assert.deepEqual(view.sources, ['@pulse', '@tpm', 'sys.cpu']);
  assert.ok(errors.some((error) => /unknown component "iframe"/.test(error)));
});

test('trees are bounded in depth and node count', () => {
  let deep = { type: 'text', text: 'leaf' };
  for (let index = 0; index < 12; index += 1) deep = { type: 'stack', children: [deep] };
  const errors = [];
  normalizeView({ id: 'deep', title: 'Deep', surfaces: ['home'], layout: deep }, ctx(), errors);
  assert.ok(errors.some((error) => /nested too deeply/.test(error)));
  const wide = { type: 'stack', children: Array.from({ length: 400 }, () => ({ type: 'divider' })) };
  const view = normalizeView({ id: 'wide', title: 'Wide', surfaces: ['home'], layout: wide }, ctx(), []);
  assert.equal(view.layout.children.length, LIMITS.nodes - 1);
});

test('surface requirements: home and notch need a layout, tray needs tray or compact', () => {
  assert.equal(normalizeView({ id: 'a', title: 'A', surfaces: ['home'] }, ctx(), []), null);
  assert.equal(normalizeView({ id: 'b', title: 'B', surfaces: ['tray'], layout: { type: 'divider' } }, ctx(), []), null);
  assert.ok(normalizeView({ id: 'c', title: 'C', surfaces: ['tray', 'edgeDock'], compact: { value: { $: 'sys.cpu' } } }, ctx(), []));
});

test('resolution formats readings, maps tones and reads only the bus', () => {
  const readings = {
    'sys.cpu': { value: 72.4, at: 1 },
    'sys.memory': { value: { used: 8 * 1024 ** 3, total: 16 * 1024 ** 3, percent: 50 }, at: 1 },
    'plugin.demo.tpm': { value: 125000, at: 1 }
  };
  const resolver = createResolver({
    read: (id) => readings[id] || null,
    history: () => [1, null, 3],
    pluginId: 'demo',
    locale: 'en'
  });
  const tree = resolver.resolveNode({
    type: 'stack',
    children: [
      { type: 'stat', value: { $: 'sys.cpu', fmt: 'percent' }, tone: { $: 'sys.cpu', steps: [[0, 'ok'], [70, 'warn'], [90, 'bad']] } },
      { type: 'text', text: { $: 'sys.memory', field: 'used', fmt: 'bytes' } },
      { type: 'meter', value: { $: 'sys.memory', field: 'percent' } },
      { type: 'stat', value: { $: '@tpm', fmt: 'compact' }, label: { en: 'Rate', 'zh-TW': '速率' } },
      { type: 'sparkline', series: { $: 'sys.cpu', history: 3 } },
      { type: 'text', text: { $: 'tm.today', field: 'tokens', fmt: 'compact' } }
    ]
  });
  const [cpu, memory, meter, tpm, spark, missing] = tree.children;
  assert.equal(cpu.value, '72%');
  assert.equal(cpu.tone, 'warn');
  assert.equal(memory.text, '8 GB');
  assert.equal(meter.value, 50);
  assert.equal(tpm.value, '125K');
  assert.equal(tpm.label, 'Rate');
  assert.deepEqual(spark.series, [1, null, 3]);
  assert.equal(missing.text, '—');
  assert.equal(toneFor(null, [[0, 'ok']]), 'muted');
  assert.equal(formatValue(90061000, { fmt: 'duration' }), '25h 1m');
});

test('permissions: hosts match exactly or by one wildcard label', () => {
  assert.equal(permissions.hostAllowed('api.example.com', ['api.example.com']), true);
  assert.equal(permissions.hostAllowed('evil-api.example.com', ['api.example.com']), false);
  assert.equal(permissions.hostAllowed('a.example.org', ['*.example.org']), true);
  assert.equal(permissions.hostAllowed('example.org', ['*.example.org']), false);
  assert.equal(permissions.hostAllowed('example.org.evil.test', ['*.example.org']), false);
});

test('permissions: a widened manifest is missing from the stored grant', () => {
  const v1 = { permissions: ['sys.cpu'], network: { hosts: [] } };
  const v2 = { permissions: ['network', 'sys.cpu', 'tm.usage'], network: { hosts: ['api.example.com'] } };
  const grant = permissions.grantFor(v1);
  assert.equal(permissions.grantSatisfied(v1, grant), true);
  assert.deepEqual(permissions.missingGrant(v2, grant), { permissions: ['network', 'tm.usage'], hosts: ['api.example.com'] });
  assert.equal(permissions.riskSummary(v2).appDataWarning, true);
  assert.equal(permissions.canReadSource(grant, 'sys.cpu'), true);
  assert.equal(permissions.canReadSource(grant, 'sys.memory'), false);
  assert.equal(permissions.canReadSource(grant, 'credentials'), false);
});

test('interactive views validate unique actions, labels, options and literal numeric bounds', () => {
  const nodes = [
    { type: 'button', action: 'clear', label: 'Clear' },
    { type: 'toggle', action: 'enabled', label: 'Enabled', value: { $: '@tpm' } },
    { type: 'slider', action: 'width', label: 'Width', value: 5, min: 1, max: 20, step: 1 },
    { type: 'select', action: 'color', label: 'Colour', options: [{ value: 'blue', label: { en: 'Blue' } }] },
    { type: 'input', action: 'note', label: 'Note', maxLength: 100 },
    { type: 'draw', action: 'ink', label: 'Drawing canvas', width: 400, height: 200, list: [] }
  ];
  const raw = { id: 'edit', title: 'Edit', surfaces: ['page'], layout: { type: 'stack', children: nodes } };
  const errors = []; const view = normalizeView(raw, { ...ctx(), interactive: true }, errors);
  assert.deepEqual(errors, []); assert.equal(view.layout.children.length, 6);
  for (const bad of [ { ...nodes[0], action: '../clear' }, { ...nodes[0], label: '' }, { ...nodes[2], min: { $: '@tpm' } }, { ...nodes[2], step: 0 }, { ...nodes[3], options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] } ]) {
    const errors = []; normalizeView({ ...raw, layout: bad }, { ...ctx(), interactive: true }, errors); assert.ok(errors.length);
  }
  const duplicate = []; normalizeView({ ...raw, layout: { type: 'stack', children: [nodes[0], nodes[0]] } }, ctx(), duplicate); assert.ok(duplicate.some(e => e.includes('unique')));
  const declarative = []; normalizeView(raw, { ...ctx(), interactive: false }, declarative); assert.ok(declarative.some(e => e.includes('main code')));
});
test('control event validation rejects out-of-contract input and strips unknown fields', () => {
  const { validateInteraction } = require('../../src/shared/plugins/interactions');
  const button = { type: 'button', action: 'go' };
  assert.deepEqual(validateInteraction(button, { action: 'go', type: 'press', extra: new ArrayBuffer(8) }), { action: 'go', type: 'press' });
  assert.equal(validateInteraction({ ...button, disabled: true }, { action: 'go', type: 'press' }), null);
  assert.equal(validateInteraction(button, { action: 'other', type: 'press' }), null);
  assert.equal(validateInteraction({ type: 'input', action: 'note', maxLength: 4 }, { action: 'note', type: 'change', value: '12345' }), null);
  const slider = { type: 'slider', action: 'width', min: 1, max: 10, step: 2 };
  assert.equal(validateInteraction(slider, { action: 'width', type: 'change', value: 4 }).value, 5);
  assert.equal(validateInteraction(slider, { action: 'width', type: 'change', value: NaN }), null);
  assert.equal(validateInteraction(slider, { action: 'width', type: 'change', value: 11 }), null);
  const draw = { type: 'draw', action: 'ink', width: 100, height: 50 };
  assert.equal(validateInteraction(draw, { action: 'ink', type: 'pointermove', x: 101, y: 2 }), null);
  assert.deepEqual(validateInteraction(draw, { action: 'ink', type: 'key', key: 'ArrowRight', secret: 'x' }), { action: 'ink', type: 'key', key: 'ArrowRight' });
});

test('editable input values retain their declared text length instead of display truncation', () => {
  const { normalizeManifest } = require('../../src/shared/plugins/manifest');
  const text = 'A personal note '.repeat(40);
  const result = normalizeManifest({ id: 'long-note', version: '1.0.0', tmApi: '^1', name: 'Notes', main: 'main.js', metrics: [{ id: 'state', kind: 'object' }], views: [{ id: 'note', title: 'Note', surfaces: ['page'], layout: { type: 'input', action: 'edit', label: 'Note', maxLength: 1024, value: { $: '@state', field: 'note' } } }] });
  assert.equal(result.ok, true);
  const resolver = createResolver({ read: () => ({ value: { note: text } }), history: () => [], pluginId: 'long-note' });
  assert.equal(resolver.resolveNode(result.manifest.views[0].layout).value, text);
});


test('motion is an author choice per node and compact readout, with no implicit override', () => {
  const errors = [];
  const view = normalizeView({ id: 'motion', title: 'Motion', surfaces: ['home', 'edgeDock'],
    compact: { value: { $: 'sys.cpu', fmt: 'percent' }, motion: 'none' },
    layout: { type: 'stack', children: [
      { type: 'ring', value: 12, motion: 'none' },
      { type: 'ring', value: 34, motion: 'inherit' },
      { type: 'ring', value: 56 }
    ] }
  }, ctx(), errors);
  assert.deepEqual(errors, []);
  assert.equal(view.compact.motion, 'none');
  assert.deepEqual(view.layout.children.map(n => n.motion), ['none', 'inherit', undefined]);
  const resolver = createResolver({ read: () => null, history: () => [], pluginId: 'demo' });
  assert.deepEqual(resolver.resolveNode(view.layout).children.map(n => n.motion), ['none', 'inherit', undefined]);
  for (const motion of [true, 'roll', {}, null]) {
    const errors = [];
    normalizeView({ id: 'bad', title: 'Bad', surfaces: ['edgeDock'], compact: { value: 1, motion }, layout: { type: 'ring', value: 1, motion } }, ctx(), errors);
    assert.equal(errors.filter(e => e.includes('expected inherit or none')).length, 2);
  }
});

test('compact readouts carry finite numeric metadata without parsing labels or localized output', () => {
  const values = { cpu: 71.6, memory: { percent: 72 }, rate: 842000, id: '42', bad: Infinity };
  const resolver = createResolver({ read: id => id in values ? { value: values[id] } : null, history: () => [], pluginId: 'demo', locale: 'zh-TW' });
  for (const [value, expected] of [
    [{ $: 'cpu', fmt: 'percent' }, 71.6],
    [{ $: 'memory', field: 'percent', scale: 0.01, digits: 2 }, 0.72],
    [{ $: 'rate', fmt: 'compact' }, 842000], [0, 0], [-4, -4]
  ]) assert.equal(resolver.resolveCompact({ value }).valueNumber, expected);
  for (const value of ['Version 42', '42', { $: 'id' }, { $: 'missing' }, { $: 'bad' }, undefined]) {
    assert.equal(Object.hasOwn(resolver.resolveCompact({ value }), 'valueNumber'), false);
  }
  assert.equal(resolver.resolveCompact({ value: { $: 'memory', field: 'percent', fmt: 'percent' }, motion: 'none' }).motion, 'none');
});


test('full-view stat numeric metadata follows the same finite binding rules', () => {
  const resolve = value => createResolver({ read: () => ({ value: 72 }), history: () => [], pluginId: 'demo' }).resolveNode({ type: 'stat', value });
  assert.equal(resolve({ $: 'sys.cpu', fmt: 'percent' }).valueNumber, 72);
  assert.equal(resolve('v72').valueNumber, undefined);
  assert.equal(resolve(0).valueNumber, 0);
});


test('Count descriptors preserve locale, units and scaled values without applying scale twice', () => {
  const { formatValue: formatFrame } = require('../../src/shared/plugins/numberFormat');
  for (const binding of [
    { $: 'sys.cpu', fmt: 'percent', digits: 1 }, { $: 'sys.cpu', fmt: 'compact', scale: 10000 },
    { $: 'sys.cpu', fmt: 'number', scale: 0.01, unit: { en: 'units', 'zh-TW': '單位' } },
    { $: 'sys.cpu', fmt: 'bytes' }, { $: 'sys.cpu', fmt: 'duration' }, { $: 'sys.cpu', fmt: 'rate' }
  ]) {
    const resolver = createResolver({ read: () => ({ value: 12500 }), history: () => [], pluginId: 'demo', locale: 'zh-TW' });
    const compact = resolver.resolveCompact({ value: binding });
    const stat = resolver.resolveNode({ type: 'stat', value: binding });
    for (const resolved of [compact, stat]) {
      assert.equal(formatFrame(resolved.valueNumber, resolved.valueFormat, resolved.valueFormat.locale), resolved.value);
      assert.equal(resolved.valueFormat.scale, undefined);
    }
  }
});

test('explicit ring captions carry their own numeric binding without parsing literal text', () => {
  const resolver = () => createResolver({ read: id => ({ value: id === 'sys.cpu' ? 37 : { percent: 72 } }), history: () => [], pluginId: 'system-monitor', locale: 'en' });
  const manifest = require('../../src/electron/plugins/builtin/system-monitor/manifest.json');
  const rings = [];
  function walk(value) { if (!value || typeof value !== 'object') return; if (value.type === 'ring') rings.push(value); Object.values(value).forEach(v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v); }); }
  walk(manifest.views);
  assert.ok(rings.length >= 2);
  for (const ring of rings) {
    const resolved = resolver().resolveNode(ring);
    assert.equal(resolved.captionNumber, ring.caption.$ === 'sys.cpu' ? 37 : 72);
    assert.equal(resolved.captionFormat.fmt, 'percent');
  }
  assert.equal(resolver().resolveNode({ type: 'ring', value: 50, caption: '72%' }).captionNumber, undefined);
  assert.equal(createResolver({ read: () => null, history: () => [], pluginId: 'demo' }).resolveNode(rings[0]).captionNumber, undefined);
});

test('smooth chart receives measured timestamps and gaps without starting a sampler', () => {
  const { createDataBus } = require('../../src/shared/plugins/dataBus');
  const bus = createDataBus();
  bus.publish('sys.cpu', 10, 1000); bus.publish('sys.cpu', null, 3000); bus.publish('sys.cpu', 30, 25000);
  const points = bus.historyPoints('sys.cpu', 60);
  assert.deepEqual(points, [{ at: 1000, value: 10 }, { at: 3000, value: null }, { at: 25000, value: 30 }]);
  const resolver = createResolver({ read: bus.read, history: bus.history, historyPoints: bus.historyPoints, sourceInterval: () => 2000, pluginId: 'demo' });
  const result = resolver.resolveNode({ type: 'sparkline', smooth: true, windowMs: 120000, series: { $: 'sys.cpu', history: 60 } });
  assert.deepEqual(result.seriesPoints, points); assert.equal(result.seriesIntervalMs, 2000);
  assert.equal(bus.effectiveInterval('sys.cpu'), 0);
  assert.equal(resolver.resolveNode({ type: 'sparkline', series: [1, 2] }).seriesPoints, undefined);
  bus.dispose();
});


test('Surface Studio resolves the production numeric CPU reading in full and compact fallbacks', () => {
  const { normalizeManifest } = require('../../src/shared/plugins/manifest');
  const manifest = require('../../docs/plugins/examples/surface-studio/manifest.json');
  const result = normalizeManifest(manifest);
  assert.deepEqual(result.errors, []);
  const view = result.manifest.views[0];
  for (const value of [37, 0, 100]) {
    const resolver = createResolver({ pluginId: manifest.id, read: () => ({ value, at: 1 }), history: () => [] });
    assert.equal(resolver.resolveNode(view.layout).value, `${value}%`);
    assert.equal(resolver.resolveCompact(view.compact).value, `${value}%`);
  }
  const missing = createResolver({ pluginId: manifest.id, read: () => null, history: () => [] });
  assert.equal(missing.resolveNode(view.layout).value, '—');
});

test('invalid sliders are removed from a loaded manifest, not just reported as warnings', () => {
  const { normalizeManifest } = require('../../src/shared/plugins/manifest');
  const { findAction, validateInteraction } = require('../../src/shared/plugins/interactions');
  for (const bounds of [{ step: 0 }, { step: -1 }, { min: 20, max: 1 }, { step: { $: '@tpm' } }]) {
    const result = normalizeManifest({ id: 'slider-test', name: 'Slider', version: '1.0.0', tmApi: '^1', main: 'main.js', permissions: [], metrics: [{ id: 'tpm', kind: 'number' }],
      views: [{ id: 'edit', title: 'Edit', surfaces: ['home'], layout: { type: 'stack', children: [
        { type: 'slider', action: 'bad', label: 'Invalid', min: 1, max: 20, step: 1, ...bounds },
        { type: 'slider', action: 'good', label: 'Valid', min: 1, max: 20, step: 0.5 }
      ] } }] });
    assert.equal(result.ok, true, 'a bad child must not discard unrelated controls');
    assert.ok(result.errors.some(error => /slider/.test(error)));
    const tree = result.manifest.views[0].layout;
    assert.equal(findAction(tree, 'bad'), null);
    const good = findAction(tree, 'good');
    assert.equal(validateInteraction(good, { action: 'good', type: 'change', value: 4.2 }).value, 4);
  }
});
