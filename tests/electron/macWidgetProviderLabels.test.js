'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { LIMIT_PROVIDER_IDS, LIMIT_PROVIDER_LABELS } = require('../../src/shared/limitProviders');
const { buildMacWidgetSnapshot } = require('../../src/shared/macWidgetSnapshot');

const rootDir = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), 'utf8');

function widgetFallbackLabels() {
  const swift = read('native', 'macos', 'TokenMonitorWidget', 'WidgetViewModel.swift');
  const start = swift.indexOf('static func provider(_ value: String) -> String {');
  assert.notEqual(start, -1, 'WidgetFormat.provider should exist');
  const body = swift.slice(start, swift.indexOf('default:', start));
  const labels = new Map();
  for (const match of body.matchAll(/case ([^:\n]+): "([^"]+)"/g)) {
    for (const id of match[1].matchAll(/"([^"]+)"/g)) labels.set(id[1], match[2]);
  }
  return labels;
}

// One provider per snapshot on purpose: buildQuota caps the rendered rows, so a
// single snapshot listing all of them would silently drop the tail.
function quotaRowFor(provider) {
  const snapshot = buildMacWidgetSnapshot({
    updatedAt: '2026-07-17T10:00:00Z',
    periods: { today: { totalTokens: 1, costUsd: 1 } },
    limits: {
      providers: [{
        provider,
        status: 'ok',
        accountKey: `${provider}-account`,
        windows: [{ kind: 'weekly', usedPercent: 10 }]
      }]
    }
  }, {
    now: '2026-07-17T10:00:05Z',
    history: { daily: [], monthly: [], summary: {} }
  });
  return snapshot.quota[0];
}

// This is the name the widget actually renders: buildQuota stamps displayName
// onto every quota row and the Swift view prefers it over WidgetFormat.provider,
// so a guard that only compares the Swift map passes while the shipped snapshot
// still carries stale names.
test('the snapshot names every limits provider exactly as the app does', () => {
  for (const id of LIMIT_PROVIDER_IDS) {
    const row = quotaRowFor(id);
    assert.equal(row?.provider, id, `"${id}" should reach the snapshot`);
    assert.equal(
      row.displayName,
      LIMIT_PROVIDER_LABELS[id],
      `snapshot displayName for "${id}" should match the shared label`
    );
  }
});

// The Swift map only runs for rows without a displayName, but it is what those
// rows fall back to, so it must not disagree with the source above it.
test('the Widget fallback map agrees with the snapshot labels', () => {
  const fallback = widgetFallbackLabels();

  const missing = LIMIT_PROVIDER_IDS.filter((id) => !fallback.has(id));
  assert.deepEqual(missing, [], 'every provider id needs an explicit case');

  for (const id of LIMIT_PROVIDER_IDS) {
    assert.equal(fallback.get(id), LIMIT_PROVIDER_LABELS[id], `WidgetFormat.provider("${id}")`);
  }
});
