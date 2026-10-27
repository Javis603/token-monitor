'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDisplayPreview } = require('../../src/electron/displayPreview');
const { MESSAGES, LANGUAGE_OPTIONS } = require('../../src/electron/renderer/i18n');

test('preview works while disabled without mutating settings or exposing credentials', () => {
  const settings = { notchEnabled: false, edgeDockEnabled: false, secret: 'private-secret', language: 'zh-TW', notchShape: 'pill', notchSize: 'medium' };
  const before = structuredClone(settings);
  for (const surface of ['notch', 'edgeDock']) {
    for (const phase of ['closed', 'hover', 'open']) {
      const result = buildDisplayPreview(settings, surface, phase, 'darwin', 1792900800000);
      assert.ok(result.width > 0 && result.height > 0);
      assert.equal(result.payload.appearance.reduceMotion, 'on');
      assert.equal(result.payload.refreshEnabled, false);
      assert.ok(!JSON.stringify(result).includes(settings.secret));
    }
  }
  assert.deepEqual(settings, before);
  assert.equal(buildDisplayPreview(settings, 'unknown', 'open'), null);
  assert.equal(buildDisplayPreview(settings, 'notch', 'unknown'), null);
});

test('the same surface is projected into collapsed, hover and expanded states', () => {
  const settings = { notchSummaryMode: 'sessions', notchShape: 'notch' };
  const read = phase => buildDisplayPreview(settings, 'notch', phase, 'darwin', 1792900800000).payload;
  const closed = read('closed'), hover = read('hover'), open = read('open');
  assert.equal(closed.expanded, false);
  assert.equal(open.expanded, true);
  assert.equal(open.motion.progress, 1);
  assert.ok(hover.motion.summaryHeight > closed.motion.summaryHeight);
  assert.notEqual(closed.shape.d, hover.shape.d);
  assert.notEqual(closed.shape.d, open.shape.d);
  assert.ok(closed.summary?.items.length, 'session preview must not be an empty camera notch');
  assert.deepEqual(closed.cells, open.cells);
  const pill = buildDisplayPreview({ ...settings, notchShape: 'pill' }, 'notch', 'open').payload;
  assert.equal(pill.geometry.notched, false);
  assert.equal(pill.geometry.gapWidth, 0);
  const withoutSummary = buildDisplayPreview({ ...settings, notchSummaryEnabled: false }, 'notch', 'closed').payload;
  assert.equal(withoutSummary.summary, null);
});

test('edge preview respects side, custom scale and explicitly empty content', () => {
  const preview = buildDisplayPreview({ edgeDockSide: 'left', edgeDockSize: 'custom', edgeDockCustomScale: 1.3, edgeDockItems: [] }, 'edgeDock', 'open');
  assert.equal(preview.align, 'left'); assert.equal(preview.scale, 1.3);
  assert.equal(preview.payload.surface, 'rail'); assert.deepEqual(preview.payload.cells, []);
  assert.equal(buildDisplayPreview({}, 'edgeDock', 'closed').payload.surface, 'peek');
  assert.equal(buildDisplayPreview({}, 'edgeDock', 'closed').payload.peeking, true);
});

test('pill summary grows around provider rings only when the summary uses them', () => {
  const settings = { notchShape: 'pill', notchSummaryMode: 'tray', trayContent: 'tokens', notchRunningIndicatorEnabled: true };
  const ring = buildDisplayPreview(settings, 'notch').payload.geometry;
  assert.equal(ring.summaryRingSize, 42);
  assert.equal(ring.height, Math.ceil(42 * ring.summaryZoom + 8));
  const hidden = buildDisplayPreview({ ...settings, notchSummaryEnabled: false }, 'notch').payload.geometry;
  assert.equal(hidden.summaryRingSize, 0);
  assert.ok(hidden.height < ring.height);
  const sessions = buildDisplayPreview({ ...settings, notchSummaryMode: 'sessions' }, 'notch').payload.geometry;
  assert.equal(sessions.summaryRingSize, 0);
  const camera = buildDisplayPreview({ ...settings, notchShape: 'notch' }, 'notch').payload.geometry;
  assert.equal(camera.summaryRingSize, 0);
});

test('every display-navigation string has a translation in every locale', () => {
  const keys = Object.keys(MESSAGES.en).filter(key => key.startsWith('settings.displayModes.'));
  assert.ok(keys.length > 15);
  for (const { value } of LANGUAGE_OPTIONS.filter(locale => locale.value !== 'auto')) {
    for (const key of keys) assert.ok(MESSAGES[value][key], `${value}: ${key}`);
  }
});


test('measured summary widths replace the placeholder without changing panel content', () => {
  const settings = { notchSummaryMode: 'sessions' }, now = 1792900800000;
  const initial = buildDisplayPreview(settings, 'notch', 'closed', 'darwin', now).payload;
  const measured = buildDisplayPreview(settings, 'notch', 'closed', 'darwin', now, { left: 240, right: 140 }).payload;
  assert.equal(initial.summaryMeasurement.measuring, true);
  assert.equal(measured.summaryMeasurement.measuring, false);
  assert.ok(measured.geometry.headerWidth > initial.geometry.headerWidth);
  assert.deepEqual(measured.summary, initial.summary);
  const invalid = buildDisplayPreview(settings, 'notch', 'closed', 'darwin', now, { left: Infinity, right: -1 }).payload;
  assert.equal(invalid.summaryMeasurement.measuring, true);
});

test('notch preview exposes the visible height instead of the transparent window padding', () => {
  for (const phase of ['closed', 'open']) {
    const result = buildDisplayPreview({}, 'notch', phase);
    assert.equal(result.contentHeight, result.payload.motion.summaryHeight);
    assert.ok(result.contentHeight < result.height);
  }
});

test('notch preview reserves the same expanded height across phase changes', () => {
  for (const notchShape of ['auto', 'notch', 'pill']) {
    const opened = buildDisplayPreview({ notchShape }, 'notch', 'open');
    const closed = buildDisplayPreview({ notchShape }, 'notch', 'closed');
    assert.equal(closed.previewHeight, opened.previewHeight);
    assert.equal(opened.previewHeight, opened.contentHeight);
    assert.ok(closed.contentHeight < closed.previewHeight);
  }
});

test('sample appearance carries effective rates and display preferences without private settings', () => {
  const settings = { currency: 'TWD', currencyRatesEffective: { TWD: 40 }, showCompactTotalTokens: true,
    sessionContextMetric: 'remaining', tokenNumberAnimation: 'count', showCodexAdditionalLimits: true, limitProviderHiddenItems: { codex: ['weekly'] }, secret: 'private-value' };
  for (const surface of ['notch', 'edgeDock']) {
    const { appearance } = buildDisplayPreview(settings, surface, 'open').payload;
    for (const key of Object.keys(settings).filter(key => key !== 'secret')) assert.deepEqual(appearance[key], settings[key], key);
    assert.equal(appearance.secret, undefined);
  }
});


test('preview resolves custom and inherited fonts exactly like the live renderer', () => {
  const { resolveEffectiveFontSettings } = require('../../src/shared/fontSettings');
  for (const surface of ['edgeDock', 'notch']) {
    for (const displayFontFamily of ['Menlo, monospace', '']) {
      const settings = { interfaceFontFamily: 'Georgia, serif', displayFontFamily };
      const { appearance } = buildDisplayPreview(settings, surface, 'open').payload;
      assert.deepEqual(resolveEffectiveFontSettings(appearance), resolveEffectiveFontSettings(settings));
    }
  }
});
