'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { emptyPeriod, extractUsageFromTokscale, normalizePeriod, mergePeriods, applyPeriodDelta } = require('../../src/shared/usage');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');
const rate = require('../../src/electron/renderer/tokenRatePresentation');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
const { translate } = require('../../src/electron/renderer/i18n');

function period(codex = 100, antigravity = 120) {
  return extractUsageFromTokscale({ entries: [
    { client: 'codex', model: 'shared-model', input: 40, output: codex, performance: { timedTokens: codex + 40, totalDurationMs: codex * 20 } },
    { client: 'antigravity-extension', model: 'shared-model', input: 50, output: antigravity, performance: { timedTokens: antigravity + 50, totalDurationMs: antigravity * 1000 / 60 } },
    { client: 'claude', model: 'untimed', input: 100, output: 900 }
  ] });
}

function group(clock) {
  const tracker = rate.createLiveTokenRateGroupTracker({ now: () => clock.value });
  tracker.reset([{ id: 'local', period: emptyPeriod() }]);
  return tracker;
}

test('tools sharing a model retain independent matched throughput counters and exclude untimed output', () => {
  const value = period();
  assert.deepEqual(value.clientThroughput.codex, { timedTokens: 140, timedOutputTokens: 100, timedDurationMs: 2000 });
  assert.deepEqual(value.clientThroughput.antigravity, { timedTokens: 170, timedOutputTokens: 120, timedDurationMs: 2000 });
  assert.equal(value.clientThroughput.claude, undefined);
  assert.equal(value.timedOutputTokens, 220);
  assert.equal(value.outputTokens, 1120);
  assert.equal(rate.tokenRatePerSecond(value), 55);
});

test('tool timing survives normalization, device merging and warm deltas without manufacturing legacy attribution', () => {
  const first = period();
  const second = period(200, 240);
  assert.deepEqual(normalizePeriod(first).clientThroughput, first.clientThroughput);
  assert.equal(mergePeriods(first, second).clientThroughput.antigravity.timedOutputTokens, 360);
  assert.equal(applyPeriodDelta(first, second, first).clientThroughput.antigravity.timedOutputTokens, 240);
  const legacy = { ...first };
  delete legacy.clientThroughput;
  assert.equal(normalizePeriod(legacy).clientThroughput, undefined);
  assert.equal(mergePeriods(first, legacy).clientThroughput, undefined);
  assert.equal(mergePeriods(legacy, first).clientThroughput, undefined);
  assert.equal(applyPeriodDelta(first, second, legacy).clientThroughput, undefined);
});

test('sync preserves optional source counters and drops oversized attribution before session detail', () => {
  const today = period();
  const summary = { deviceId: 'local', today, month: today, allTime: today };
  assert.deepEqual(serializeSyncPayload(summary).payload.today.clientThroughput, today.clientThroughput);
  const crowded = { ...today, clientThroughput: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
    'client-' + index, { timedTokens: 1, timedOutputTokens: 1, timedDurationMs: 1 }
  ])), sessions: { 'codex:s1': { client: 'codex', sessionId: 's1', totalTokens: 100 } } };
  const packed = serializeSyncPayload({ ...summary, today: crowded }, { maxBytes: 6000 });
  assert.equal(packed.payload.today.clientThroughput, undefined);
  assert.equal(packed.payload.today.modelThroughput, undefined);
  assert.deepEqual(packed.payload.today.sessions, crowded.sessions);
  assert.equal(Object.keys(crowded.clientThroughput).length, 1000);
  assert.equal(packed.payload.today.totalTokens, today.totalTokens);
});

test('source readings retain independent activity and expire without another scan', () => {
  const clock = { value: 100 };
  const tracker = group(clock);
  tracker.observe([{ id: 'local', period: period() }]);
  assert.equal(tracker.getSample().speed, 55);
  assert.equal(rate.selectLiveTokenRateSample(tracker.getSample(), 'codex').speed, 50);
  assert.equal(rate.selectLiveTokenRateSample(tracker.getSample(), 'antigravity').speed, 60);
  clock.value = 4000;
  tracker.observe([{ id: 'local', period: period(200) }]);
  assert.equal(tracker.getSample().speed, 50);
  assert.equal(rate.selectLiveTokenRateSample(tracker.getSample(), 'antigravity').speed, 60);
  assert.equal(tracker.nextExpiryAt(), 8100);
  clock.value = 8200;
  assert.equal(rate.selectLiveTokenRateSample(tracker.getSample(), 'antigravity').idle, true);
  assert.equal(rate.selectLiveTokenRateSample(tracker.getSample(), 'codex').idle, false);
  clock.value = 180200;
  assert.equal(rate.selectLiveTokenRateSample(tracker.getSample(), 'antigravity'), null);
  assert.ok(rate.selectLiveTokenRateSample(tracker.getSample(), 'codex'));
  assert.equal(rate.liveTokenRateTooltipEntries(tracker.getSample(), 'speed', String).some(entry => entry[2] === 'antigravity'), false);
});

test('unknown attribution and historical reassignment cannot become fresh tool rates', () => {
  const clock = { value: 100 };
  const tracker = group(clock);
  const legacy = emptyPeriod();
  delete legacy.clientThroughput;
  tracker.reset([{ id: 'local', period: legacy }]);
  tracker.observe([{ id: 'local', period: period() }]);
  assert.equal(tracker.getSample().speed, 55);
  assert.equal(rate.selectLiveTokenRateSample(tracker.getSample(), 'antigravity'), null);
  tracker.reset([{ id: 'local', period: emptyPeriod() }]);
  tracker.observe([{ id: 'local', period: period() }]);
  const reassigned = period();
  reassigned.clientThroughput.antigravity = { timedTokens: 85, timedOutputTokens: 60, timedDurationMs: 1000 };
  assert.equal(tracker.observe([{ id: 'local', period: reassigned }]).changed, true);
  assert.equal(rate.selectLiveTokenRateSample(tracker.getSample(), 'antigravity'), null);
});

test('merged, separate and single-source displays share the same samples and keep missing readings unavailable', () => {
  const clock = { value: 100 };
  const tracker = group(clock);
  tracker.observe([{ id: 'local', period: period() }]);
  const sample = tracker.getSample();
  assert.equal(rate.liveTokenRateReadouts(sample, 'all')[0].sample.speed, 55);
  assert.deepEqual(rate.liveTokenRateReadouts(sample, 'separate').map(entry => [entry.client, entry.sample.speed]), [['codex', 50], ['antigravity', 60]]);
  assert.equal(rate.liveTokenRateReadouts(sample, 'antigravity')[0].sample.speed, 60);
  assert.equal(rate.liveTokenRateReadouts(null, 'separate')[1].sample, null);
  assert.equal(rate.normalizeLiveTokenRateDisplay('unsupported'), 'all');
});

test('tool throughput adds per-device live rates while legacy devices retain only a combined reading', () => {
  const clock = { value: 100 };
  const tracker = rate.createLiveTokenRateGroupTracker({ now: () => clock.value });
  tracker.reset([{ id: 'one', period: emptyPeriod() }, { id: 'two', period: emptyPeriod() }]);
  tracker.observe([{ id: 'one', period: period() }, { id: 'two', period: period() }]);
  assert.equal(tracker.getSample().speed, 110);
  assert.equal(rate.selectLiveTokenRateSample(tracker.getSample(), 'antigravity').speed, 120);
  const entries = rate.liveTokenRateTooltipEntries(tracker.getSample(), 'speed', String, { clientLabel: client => client === 'codex' ? 'GPT' : client });
  assert.equal(entries.filter(entry => entry[2] === 'antigravity').length, 2);
  assert.ok(entries.some(entry => entry[0] === 'GPT' && entry[1] === '50 tok/s'));
});

test('dock source selection preserves every tool in the hover details', () => {
  const clock = { value: 100 };
  const tracker = group(clock);
  tracker.observe([{ id: 'local', period: period() }]);
  const raw = tracker.getSample();
  const cells = buildEdgeDockCells({ periods: {} }, {
    items: [{ type: 'stat', metric: 'liveRate' }], limitsEnabled: false,
    liveRate: rate.selectLiveTokenRateSample(raw, 'antigravity'), liveRateDetails: raw, liveRateClient: 'antigravity'
  });
  const cell = cells.find(entry => entry.metric === 'liveRate');
  assert.equal(cell.rate, 60);
  assert.equal(cell.rateClient, 'antigravity');
  const entries = rate.liveTokenRateTooltipEntries({ devices: cell.rateDevices }, cell.rateMode, String);
  assert.ok(entries.some(entry => entry[2] === 'codex' && entry[1] === '50 tok/s'));
  assert.ok(entries.some(entry => entry[2] === 'antigravity' && entry[1] === '60 tok/s'));
});

test('the existing footer renders all display choices and switches both tools to TPM together', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const functionSource = name => {
    const start = source.indexOf('function ' + name + '(');
    return source.slice(start, source.indexOf('\nfunction ', start + 1));
  };
  const clock = { value: 100 };
  const tracker = group(clock);
  tracker.observe([{ id: 'local', period: period() }]);
  const value = { textContent: '' };
  const classes = new Set();
  const button = { dataset: {}, classList: {
    toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key),
    add: key => classes.add(key), remove: key => classes.delete(key)
  }, setAttribute() {}, querySelectorAll: () => [] };
  let tooltip;
  const context = {
    state: { settings: { showLiveTokenRate: true, liveTokenRateDisplay: 'all' } },
    els: { liveTokenRate: button, liveTokenRateValue: value },
    tokenRateApi: rate, liveTokenRateTracker: tracker, clientLabels: { antigravity: 'Antigravity' },
    liveTokenRateRenderedRevision: 0, liveTokenRateAnimationTimer: null,
    syncLiveTokenRateFooterState() {}, effectiveLiveTokenRateScope: () => 'device',
    formatLiveTokenRate: String, t: (key, params) => translate('zh-CN', key, params),
    limitWindowsView: { setDetailTooltip: (_button, entries) => { tooltip = entries; } },
    setTimeout: () => 1, clearTimeout() {}
  };
  vm.runInNewContext(functionSource('liveTokenRateClientLabel') + functionSource('renderLiveTokenRate'), context);
  context.renderLiveTokenRate();
  assert.equal(value.textContent, '55 tok/s');
  context.state.settings.liveTokenRateDisplay = 'separate';
  context.renderLiveTokenRate();
  assert.equal(value.textContent, 'GPT 50 tok/s\nAntigravity 60 tok/s');
  assert.equal(classes.has('is-separated'), true);
  context.state.settings.liveTokenRateDisplay = 'codex';
  context.renderLiveTokenRate();
  assert.equal(value.textContent, 'GPT 50 tok/s');
  context.state.settings.tokenRateMode = 'burn';
  context.state.settings.liveTokenRateDisplay = 'antigravity';
  context.renderLiveTokenRate();
  assert.equal(value.textContent, 'Antigravity 5100 TPM');
  assert.ok(tooltip.some(entry => entry[0] === 'GPT'));
  assert.ok(tooltip.some(entry => entry[0] === 'Antigravity'));
  assert.ok(tooltip.filter(Array.isArray).every(entry => entry.length === 2), 'tool IDs are metadata, not extra visible cells');
});
