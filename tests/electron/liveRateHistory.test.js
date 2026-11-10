'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const tokenRateApi = require('../../src/electron/renderer/tokenRatePresentation');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');

test('dock history survives headline expiry, resets with scope and stops with its feature', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const source = main.slice(main.indexOf('const EDGE_DOCK_RATE_ACTIVE_MS'), main.indexOf('// Week / last-7'));
  let now = 1000;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    tokenRateApi: { ...tokenRateApi, createLiveTokenRateHistory: () => tokenRateApi.createLiveTokenRateHistory({ now: Clock.now }) },
    settings: { edgeDockEnabled: true, edgeDockItems: [{ type: 'stat', metric: 'liveRate' }], hubMode: 'local', deviceId: 'a' },
    mode: 'local', process, Date: Clock, setTimeout: () => 1, clearTimeout() {}, repaintDockSurfaces() {}
  });
  vm.runInContext(source, context);
  const observe = period => { context.stats = { periods: { today: period } }; return vm.runInContext('edgeDockLiveRateSample(stats)', context); };
  const points = () => vm.runInContext('edgeDockRateHistory.getSamples()', context);
  observe({ timedOutputTokens: 100, timedTokens: 1000, timedDurationMs: 1000 });
  assert.equal(points().length, 0);
  now = 2000;
  const period = { timedOutputTokens: 132, timedTokens: 2000, timedDurationMs: 2000 };
  assert.equal(observe(period).speed, 32);
  assert.equal(points().length, 1);
  observe(period);
  assert.equal(points().length, 1);
  now = 182_000;
  assert.equal(observe(period), null);
  assert.equal(points().length, 1);
  const [cell] = buildEdgeDockCells({}, {
    items: [{ type: 'stat', metric: 'liveRate' }], liveRate: null, liveRateHistory: points()
  });
  assert.equal(cell.rate, null);
  assert.equal(cell.rateHistory.length, 1);
  context.settings.deviceId = 'b';
  observe(period);
  assert.equal(points().length, 0);
  now += 1000;
  observe({ timedOutputTokens: 164, timedTokens: 3000, timedDurationMs: 3000 });
  assert.equal(points().length, 1);
  context.settings.edgeDockItems = [{ type: 'stat', metric: 'sessions', cellDetail: 'rate' }];
  assert.equal(observe({ timedOutputTokens: 164, timedTokens: 3000, timedDurationMs: 3000 }).speed, 32);
  assert.equal(points().length, 0, 'a sessions readout uses the sample without retaining a chart');
  context.settings.edgeDockItems = [];
  assert.equal(observe(period), null);
  assert.equal(points().length, 0);
});

test('sparse rate charts form one consistent line with one endpoint', () => {
  const dock = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const source = dock.slice(dock.indexOf('function liveRateChartNode('), dock.indexOf('// Selected measure and recent sample trend'));
  const node = tag => ({ tag, attributes: {}, children: [], setAttribute(key, value) { this.attributes[key] = String(value); }, append(...children) { this.children.push(...children); } });
  const render = vm.runInNewContext(`${source}; liveRateChartNode`, {
    el: tag => node(tag), document: { createElementNS: (_, tag) => node(tag) }, SVG_NS: 'svg',
    window: { TokenMonitorTokenRate: tokenRateApi }, Date: { now: () => 100_000 }, t: key => key
  });
  const chart = render({ rateMode: 'speed', rateHistory: [
    { at: 1000, speed: 37, burn: 390200 },
    { at: 20_000, speed: 32, burn: 380000 },
    { at: 40_000, speed: 36, burn: 400000 },
    { at: 45_000, speed: 37, burn: 390200 },
    { at: 80_000, speed: 37, burn: 390200 }
  ] });
  const svg = chart.children[0];
  const dots = svg.children.filter(child => child.tag === 'circle');
  assert.equal(dots.length, 1, 'isolated old readings must not become a scatter plot');
  assert.equal(Number(dots[0].attributes.cx), 144, 'the latest sample ends at the right edge');
  assert.equal(svg.children.filter(child => child.attributes.class === 'edge-dock-rate-chart-gap').length, 0, 'sample order does not draw faint time-gap connectors');
  const line = svg.children.find(child => child.tag === 'path' && !child.attributes.class);
  assert.equal((line.attributes.d.match(/L/g) || []).length, 4, 'all five real observations form one line');
  assert.equal(render({ rateMode: 'speed', rateHistory: [] }).children[0].children.filter(child => child.tag === 'circle').length, 0);
});
