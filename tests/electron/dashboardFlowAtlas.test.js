'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDashboardFlowAtlasBuilder, validAtlasBatch } = require('../../src/electron/dashboardFlowAtlas');

function beam(overrides = {}) {
  return {
    d: 'M10.0,15.0 C20.0,15.0 30.0,22.0 40.0,22.0',
    x: 5, y: 10, scale: 2, width: 180, height: 120, duration: 2900,
    strokes: Array.from({length:4}, () => ({stroke:'rgb(116, 200, 243)', width:2})),
    ...overrides
  };
}

test('Live Flow atlas requests admit only bounded local geometry', () => {
  assert.ok(validAtlasBatch([beam(), beam()]));
  assert.ok(!validAtlasBatch([beam({width:1024, height:1024})]));
  assert.ok(!validAtlasBatch([beam({d:'M0,0 L0,0"><script>'})]));
  assert.ok(!validAtlasBatch([beam({strokes:Array.from({length:4}, () => ({stroke:'url(https://example.com/icon.svg)', width:2}))})]));
  assert.ok(!validAtlasBatch(Array.from({length:5}, () => beam())));
});

test('Live Flow rasterizer limits in-flight work and destroys the isolated window', async () => {
  let window;
  let finish;
  const rasterized = new Promise(resolve => { finish = resolve; });
  class BrowserWindow {
    constructor(options) {
      window = this;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        async executeJavaScript() { return rasterized; }
      });
      assert.equal(options.webPreferences.sandbox, true);
      assert.equal(options.webPreferences.nodeIntegration, false);
      assert.ok(options.webPreferences.partition);
    }
    async loadFile() {}
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; }
  }
  const owner = Object.assign(new EventEmitter(), {isDestroyed: () => false});
  const build = createDashboardFlowAtlasBuilder(BrowserWindow);
  const request = build([beam()],owner);
  assert.equal(await build([beam()], owner), null);
  finish([null]);
  assert.deepEqual(await request, [null]);
  assert.equal(window.isDestroyed(), true);
  assert.equal(owner.listenerCount('destroyed'), 0);
});

function atlasPlaybackFixture({ secondY = 90, atlasSize = 20 } = {}) {
  const overlays = new Set();
  const canvas = {};
  const edges = ['steady', 'changing'].map((edgeId, index) => {
    const attrs = new Map();
    const edge = {
      isConnected: true, dataset: { edgeId }, width: '3', active: true,
      classList: { contains: name => name !== 'is-active' || edge.active },
      style: { getPropertyValue: () => '1' },
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: name => attrs.delete(name),
      hasAttribute: name => attrs.has(name),
      append(node) {
        node.parentNode = edge;
        overlays.add(node);
      },
      getAnimations: () => [],
      querySelector: () => ({
        getBBox: () => ({ x: 20, y: index === 0 ? 20 : secondY, width: 60, height: 10 }),
        getAttribute: name => name === 'stroke-width' ? '2' : beam().d
      }),
      querySelectorAll: () => Array.from({ length: 4 }, () => ({ getAttribute: () => edge.width }))
    };
    return edge;
  });
  const svg = {
    getBoundingClientRect: () => ({ width: 150, height: 150 }),
    viewBox: { baseVal: { width: 150, height: 150 } },
    querySelectorAll: () => edges.filter(edge => edge.active)
  };
  const window = {};
  let runScheduled;
  let rejectPlayback = false;
  let failNextBuild = false;
  const source = readFileSync(path.join(__dirname, '../../src/electron/renderer/dashboard/flowAtlas.js'), 'utf8');
  vm.runInNewContext(source, {
    window,
    devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '2.9s', stroke: '#123456' }),
    setTimeout: run => { runScheduled = run; return 1; },
    clearTimeout: () => { runScheduled = undefined; },
    document: {
      createElementNS(namespace, name) {
        assert.equal(namespace, 'http://www.w3.org/2000/svg');
        assert.equal(name, 'foreignObject');
        const overlay = { dataset: {}, setAttribute() {}, append() {}, remove: () => overlays.delete(overlay) };
        return overlay;
      }
    },
    Image: class {
      style = {};
      async decode() {}
      animate() {
        if (rejectPlayback) throw new Error('cannot animate this image');
        return { cancel() {} };
      }
    }
  });

  const batches = [];
  const build = async beams => {
    batches.push(Array.from(beams, ({ strokes }) => strokes[0].width));
    if (failNextBuild) {
      failNextBuild = false;
      return null;
    }
    return beams.map(() => ({ width: atlasSize, height: atlasSize, rows: 7, columns: 8, frameCount: 54, left: 0, top: 0, stop: 870, step: 1000 / 60, png: 'fixture' }));
  };
  const update = () => window.dashboardFlowAtlas.update(canvas, svg, true, false, build);
  async function flush() {
    const task = runScheduled;
    runScheduled = undefined;
    await task?.();
  }
  return {
    overlays, edges, batches, update, flush,
    failBuildOnce: () => { failNextBuild = true; },
    rejectPlayback: () => { rejectPlayback = true; },
    clear: () => window.dashboardFlowAtlas.clear()
  };
}

test('Live Flow keeps steady edges cached when one edge changes or its playback fails', async () => {
  const { overlays, edges, batches, update, flush, rejectPlayback, clear } = atlasPlaybackFixture();
  update();
  await flush();
  const [steadyOverlay, changingOverlay] = overlays;
  assert.ok(steadyOverlay && changingOverlay);

  rejectPlayback();
  edges[1].width = '3.01';
  update();
  assert.deepEqual([...overlays], [steadyOverlay]);
  await flush();
  assert.deepEqual(batches, [[3, 3], [3.01]]);
  assert.deepEqual([...overlays], [steadyOverlay]);
  assert.equal(edges[0].hasAttribute('data-atlas'), true);
  assert.equal(edges[1].hasAttribute('data-atlas'), false);

  clear();
  assert.equal(overlays.size, 0);
});

test('Live Flow keeps atlas frames in each edge when a crossing edge changes or goes idle', async () => {
  const { overlays, edges, batches, update, flush } = atlasPlaybackFixture({ secondY: 26 });
  update();
  await flush();
  const [steady, changing] = overlays;
  assert.equal(steady.parentNode, edges[0]);
  assert.equal(changing.parentNode, edges[1]);
  edges[1].width = '3.01';
  update();
  assert.deepEqual([...overlays], [steady]);
  assert.equal(edges[0].hasAttribute('data-atlas'), true);
  await flush();
  assert.equal([...overlays][1].parentNode, edges[1]);
  assert.equal(edges[0].hasAttribute('data-atlas'), true);
  assert.deepEqual(batches, [[3, 3], [3.01]]);

  edges[1].active = false;
  update();
  await flush();
  assert.deepEqual([...overlays], [steady]);
  assert.equal(edges[0].hasAttribute('data-atlas'), true);
  assert.deepEqual(batches, [[3, 3], [3.01]]);
});

test('Live Flow retries a beam skipped for memory when another atlas retires', async () => {
  const { edges, batches, update, flush } = atlasPlaybackFixture({ atlasSize: 175 });
  update();
  await flush();
  assert.equal(edges[0].hasAttribute('data-atlas'), true);
  assert.equal(edges[1].hasAttribute('data-atlas'), false);
  update();
  await flush();
  assert.deepEqual(batches, [[3, 3]]);

  edges.shift();
  update();
  await flush();
  assert.equal(edges[0].hasAttribute('data-atlas'), true);
  assert.deepEqual(batches, [[3, 3], [3]]);
});

test('Live Flow retries a failed atlas once without rebuilding steady edges', async () => {
  const fixture = atlasPlaybackFixture();
  const { edges, overlays, batches, update, flush } = fixture;
  update();
  await flush();
  const [steady] = overlays;

  edges[1].width = '3.01';
  fixture.failBuildOnce();
  update();
  await flush();
  assert.deepEqual([...overlays], [steady]);
  update();
  await flush();
  assert.equal(edges[1].hasAttribute('data-atlas'), true);
  assert.equal([...overlays][0], steady);
  assert.deepEqual(batches, [[3, 3], [3.01], [3.01]]);

  edges[1].width = '3.02';
  fixture.rejectPlayback();
  for (let i = 0; i < 3; i++) {
    update();
    await flush();
  }
  assert.deepEqual([...overlays], [steady]);
  assert.deepEqual(batches, [[3, 3], [3.01], [3.01], [3.02], [3.02]]);
});
