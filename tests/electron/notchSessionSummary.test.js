'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { Element } = require('../helpers/notchPanel');
const { buildNotchData } = require('../../src/electron/notch/data');
const i18n = require('../../src/electron/renderer/i18n');
const typography = require('../../src/electron/renderer/trayTypography');

const source = fs.readFileSync(require.resolve('../../src/electron/renderer/notch/renderer'), 'utf8');
// Execute the production summary builder without booting an Electron window.
const summarySource = source.slice(source.indexOf('function allocateNotchSummary('), source.indexOf('// Measure complete fields'));
const nowMs = Date.parse('2026-10-26T12:00:00Z');

function render({ running = 0, waiting = 0, clients = ['codex'], mode = 'sessions', camera = true, locale = 'en', light = false, style = 'inherit' } = {}) {
  const document = {};
  document.createElementNS = (_ns, tag) => new Element(tag, document);
  const el = (tag, className = '', value) => {
    const node = new Element(tag, document); node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const sessions = Array.from({ length: running + waiting }, (_, index) => ({
    client: index < running ? clients[index % clients.length] : ['codex', 'claude'][index % 2], sessionId: String(index),
    lastUsedAt: index < running ? new Date(nowMs).toISOString() : null,
    liveActivity: { state: index < running ? 'running' : 'waiting', observedAt: new Date(nowMs).toISOString() }
  }));
  const data = buildNotchData({}, [{ metric: 'sessions', sessions }], { notchSummaryMode: mode }, { nowMs });
  const geometry = { gapWidth: camera ? 180 : 0, summaryRingSize: 0, notched: camera };
  const context = { document, window: { TokenMonitorThemePresets: { isLightHex: value => value === '#fff' } }, el, Set, Map, state: { payload: { geometry } },
    t: (key, params) => i18n.translate(locale, key, params),
    notchIcon: item => { const node = el('span', 'edge-dock-mark'); node.dataset.provider = item.provider; return node; },
    providerLabel: value => value, trayTypographyApi: typography,
    clientColors: { codex: '#4fa5b2', claude: '#d97757' }, limitProviderColor: () => '#aaa',
    notchNumbers: new Map(), positionNotchSummary() {}
  };
  const build = vm.runInNewContext(`${summarySource}; notchSummary`, context);
  return { summary: data.summary, node: build({ ...data, geometry, style, appearance: { themeColors: { bg: light ? '#fff' : '#000' } } }) };
}

test('one running session retains its icon and waveform without a count or waiting badge', () => {
  const { node } = render({ running: 1 });
  assert.equal(node.querySelectorAll('.edge-dock-mark').length, 1);
  assert.equal(node.querySelectorAll('.notch-wave').length, 1);
  assert.equal(node.querySelector('.notch-wave').children.length, 5);
  assert.equal(node.querySelector('.notch-activity-count'), null);
  assert.equal(node.querySelector('.notch-waiting-badge'), null);
  assert.equal(node.querySelector('.notch-activity').getAttribute('aria-label'), '1 running');
});

test('same-client sessions share one mark and use a plain running count', () => {
  const { node } = render({ running: 3 });
  assert.equal(node.querySelectorAll('.edge-dock-mark').length, 1);
  assert.equal(node.querySelector('.notch-session-icons'), null);
  assert.equal(node.querySelector('.notch-wave'), null);
  assert.equal(node.querySelector('.notch-reading-unit'), null);
  assert.equal(node.querySelector('.notch-activity-count').textContent, '3');
  assert.equal(node.querySelector('.notch-activity-count').classList.contains('is-mixed'), false);
});

test('mixed clients stay in one left group and running/waiting counts stay separate on both screen shapes', () => {
  for (const camera of [true, false]) {
    const { node } = render({ running: 12, waiting: 13, clients: ['codex', 'claude', 'gemini', 'opencode'], camera });
    const left = node.querySelector('.notch-left').children[0];
    assert.equal(left.children.length, 1, 'overlapping marks must be fitted as one group');
    assert.equal(left.children[0].className, 'notch-session-icons');
    assert.equal(left.querySelectorAll('.edge-dock-mark').length, 3, 'bounded provider marks');
    const right = node.querySelector('.notch-right');
    assert.equal(right.querySelector('.notch-activity-count').textContent, '12');
    assert.equal(right.querySelector('.notch-activity-count').classList.contains('is-mixed'), true);
    assert.equal(right.querySelector('.notch-waiting-count').textContent, '13');
    assert.equal(right.querySelector('.notch-waiting-badge').querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(right.querySelector('.notch-activity').getAttribute('aria-label'), '12 running · 13 waiting');
    assert.equal(right.querySelector('.notch-wave'), null);
  }
});

test('waiting-only sessions show the exact count without a zero, waveform or legacy waiting dot', () => {
  for (const waiting of [1, 2, 15]) {
    const { node } = render({ waiting, locale: 'zh-TW' });
    assert.equal(node.querySelector('.notch-activity-count'), null);
    assert.equal(node.querySelector('.notch-wave'), null);
    assert.equal(node.querySelector('.notch-waiting-dot'), null);
    assert.equal(node.querySelector('.notch-waiting-count').textContent, String(waiting));
    assert.equal(node.querySelector('.notch-activity').getAttribute('aria-label'), `${waiting} 個等待回覆`);
  }
  const { node } = render({ running: 1, waiting: 1 });
  assert.equal(node.querySelector('.notch-wave'), null, 'mixed states use two counts even with one runner');
  assert.equal(node.querySelector('.notch-activity-count').textContent, '1');
  assert.equal(node.querySelector('.notch-waiting-count').textContent, '1');
});

test('session-only presentation does not change Auto and still withdraws an idle summary', () => {
  const { node, summary } = render({ running: 2, waiting: 1, clients: ['codex', 'claude'], mode: 'auto' });
  assert.equal(summary.sessionOnly, false);
  assert.equal(node.querySelector('.notch-session-icons'), null);
  assert.equal(node.querySelector('.notch-waiting-badge'), null);
  assert.ok(node.querySelector('.notch-waiting-dot'));
  assert.equal(node.querySelector('.notch-reading-unit').textContent, 'running');
  const idle = render();
  assert.equal(idle.summary, null);
  assert.equal(idle.node.querySelector('.notch-activity'), null);
});

test('only a detached light surface uses dark activity ink, never the black camera or black capsule', () => {
  for (const [camera, style, expected] of [[false, 'inherit', true], [true, 'inherit', false], [false, 'black', false]]) {
    const { node } = render({ running: 2, waiting: 1, light: true, camera, style });
    assert.equal(node.classList.contains('is-light-session-summary'), expected);
  }
});
