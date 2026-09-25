'use strict';

// What the macOS widget names and paints each row with. The widget keeps no
// label, colour or icon table of its own: the snapshot stamps displayName on
// tool and quota rows and carries a `vendors` palette derived from
// src/shared/vendorPresentation.js. So these guards read the snapshot the app
// writes — the thing the widget actually renders — starting from the catalogs,
// which is what catches an id that never reached the vendor table.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { LIMIT_PROVIDER_IDS, LIMIT_PROVIDER_LABELS } = require('../../src/shared/limitProviders');
const { buildMacWidgetSnapshot } = require('../../src/shared/macWidgetSnapshot');
const { CLIENT_IDS, CLIENT_LABELS } = require('../../src/shared/clientCatalog');
const { widgetVendorPalette } = require('../../src/shared/vendorPresentation');

const rootDir = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), 'utf8');
const OPTIONS = {
  now: '2026-07-17T10:00:05Z',
  history: { daily: [], monthly: [], summary: {} }
};

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
  }, OPTIONS);
  return snapshot.quota[0];
}

// Same reason: buildTools keeps the top ten.
function toolRowFor(client) {
  const snapshot = buildMacWidgetSnapshot({
    updatedAt: '2026-07-17T10:00:00Z',
    periods: { today: { totalTokens: 1, clients: { [client]: 1 } } }
  }, OPTIONS);
  return snapshot.periods.day.tools[0];
}

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

test('the snapshot names every tracked tool row', () => {
  // The Swift fallback for an unnamed row is value.capitalized, which would
  // print "Codebuddy" and "Qodercn", so every tool row has to arrive named. An
  // id that is both a tool and a limits provider takes the limits name, so the
  // two rows for it agree: "Claude" and "Grok", where the app's usage rows say
  // "Claude Code" and "Grok Build".
  for (const id of CLIENT_IDS) {
    const row = toolRowFor(id);
    assert.equal(row?.id, id, `"${id}" should reach the snapshot`);
    const expected = LIMIT_PROVIDER_IDS.includes(id) ? LIMIT_PROVIDER_LABELS[id] : CLIENT_LABELS[id];
    assert.equal(row.displayName, expected, `tool row displayName for "${id}"`);
  }
});

// An id missing from the palette quietly takes the shared default blue, which
// reads as a real vendor colour rather than as a missing entry. A near-black
// mark has to arrive as `ink` rather than as its brand colour: "#000000" would
// make its bar invisible on the dark widget.
test('every tracked tool and limits provider has a widget colour or adaptive ink', () => {
  const palette = widgetVendorPalette();
  for (const id of [...new Set([...CLIENT_IDS, ...LIMIT_PROVIDER_IDS])]) {
    const style = palette[id];
    assert.ok(style && (style.ink || style.color), `${id} would silently take the shared default blue`);
    if (style.color) {
      assert.doesNotMatch(style.color, /^#0{3}(?:0{3})?$/, `${id} is black on a dark widget; mark it widgetInk`);
    }
  }
});

test('every tracked tool and limits provider resolves to an icon asset that exists', () => {
  // Resolved through the icon the widget applies, so sharing artwork is fine
  // (factory -> droid, zaiteam -> zai, mimo -> xiaomi).
  const palette = widgetVendorPalette();
  const missing = [];
  for (const id of [...new Set([...CLIENT_IDS, ...LIMIT_PROVIDER_IDS])]) {
    const name = palette[id]?.icon || id;
    if (!fs.existsSync(path.join(rootDir, 'assets', 'icons', `${name}.svg`))) missing.push(`${id} -> ${name}.svg`);
  }
  assert.deepEqual(missing, [], 'these rows would render the Circle fallback instead of a mark');
});

test('the widget gallery placeholder paints its sample ids with the real palette', () => {
  // The gallery renders without an app to write a palette, so the placeholder
  // snapshot carries a few entries of its own. They must be the real ones.
  const swift = read('native', 'macos', 'TokenMonitorWidget', 'WidgetSnapshot.swift');
  const start = swift.indexOf('static let placeholder = WidgetSnapshot(');
  assert.notEqual(start, -1, 'the placeholder snapshot should exist');
  const open = swift.indexOf('vendors: [', start);
  assert.notEqual(open, -1, 'the placeholder should carry a palette');
  const block = swift.slice(open, swift.indexOf('\n        ]', open));
  const entries = [...block.matchAll(/"([a-z0-9-]+)": WidgetVendorStyle\(([^)]*)\)/g)];
  assert.ok(entries.length > 0, 'the placeholder should carry a palette');
  const palette = widgetVendorPalette();
  for (const [, id, args] of entries) {
    const color = args.match(/color: "([^"]+)"/)?.[1];
    const icon = args.match(/icon: "([^"]+)"/)?.[1];
    const expected = palette[id] || {};
    assert.equal(/ink: true/.test(args), Boolean(expected.ink), `${id} ink`);
    assert.equal(color?.toLowerCase(), expected.color?.toLowerCase(), `${id} colour`);
    assert.equal(icon, expected.icon, `${id} icon`);
  }
});
