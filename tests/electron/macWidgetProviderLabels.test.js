'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { LIMIT_PROVIDER_IDS, LIMIT_PROVIDER_LABELS } = require('../../src/shared/limitProviders');
const { buildMacWidgetSnapshot } = require('../../src/shared/macWidgetSnapshot');
const { CLIENT_IDS, CLIENT_LABELS } = require('../../src/shared/clientCatalog');

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

// ---------------------------------------------------------------------------
// Tracked tools, not just limits providers.
//
// A tracked-tool row is a different surface from a limits row and is not covered
// by the provider assertions above. AGENTS.md requires an explicit case in
// WidgetFormat.provider there, kept complete rather than leaning on the default,
// because that fallback is value.capitalized: it renders "Codebuddy", "Qodercn"
// and "Dsh" instead of the catalog's "CodeBuddy", "Qoder CN" and "DeepSeek"
// "Harness". The widget draws tool rows through WidgetFormat.provider($0.id)
// with no displayName to prefer, so the fallback is the shipped label.
//
// The colour table has the same shape of hole and the same failure mode: an id
// in neither `colors` nor `adaptiveInk` quietly takes the shared default blue,
// which reads as a real vendor colour rather than as a missing entry.
//
// The two lists are not interchangeable, and the difference is why this asserts
// membership of either rather than of `colors` alone. `colors` is the palette a
// PercentageBar is painted with, so an id only belongs there when its mark is a
// colour worth painting with. A near-black mark goes in `adaptiveInk` instead:
// putting "#000000" in `colors` would make that bar invisible on the dark
// widget, which is a worse outcome than the fallback it was meant to fix.
function labelCasesForTrackedTool() {
  const swift = read('native', 'macos', 'TokenMonitorWidget', 'WidgetViewModel.swift');
  const start = swift.indexOf('static func provider(_ value: String) -> String {');
  assert.notEqual(start, -1, 'WidgetFormat.provider should exist');
  const body = swift.slice(start, swift.indexOf('default:', start));
  const cases = new Map();
  for (const match of body.matchAll(/case ([^:\n]+): "([^"]+)"/g)) {
    for (const id of match[1].matchAll(/"([^"]+)"/g)) cases.set(id[1], match[2]);
  }
  return cases;
}

// Anchored on the declaration rather than the first bracket, so a type
// annotation such as [String: String] cannot be mistaken for the table.
function widgetColouredIds() {
  const swift = read('native', 'macos', 'TokenMonitorWidget', 'WidgetDashboardViews.swift');
  const start = swift.indexOf('static func color(for vendorID: String) -> Color {');
  assert.notEqual(start, -1, 'WidgetVendorIdentity.color should exist');
  const anchor = swift.indexOf('let colors: [String: String] = [', start);
  assert.notEqual(anchor, -1, 'the colour table declaration should exist');
  const end = swift.indexOf('\n        ]', anchor);
  assert.notEqual(end, -1, 'the colour table should close');
  const ids = new Set();
  for (const match of swift.slice(anchor, end).matchAll(/"([a-z0-9-]+)":\s*"#/g)) ids.add(match[1]);
  // The adaptive-ink list also resolves a colour, so an id there is not missing.
  const inkAnchor = swift.indexOf('let adaptiveInk = [', start);
  assert.notEqual(inkAnchor, -1, 'the adaptive-ink list should exist');
  const inkEnd = swift.indexOf(']', inkAnchor);
  for (const match of swift.slice(inkAnchor, inkEnd).matchAll(/"([a-z0-9-]+)"/g)) ids.add(match[1]);
  return ids;
}

test('every tracked tool has an explicit Widget label case', () => {
  const cases = labelCasesForTrackedTool();
  const missing = CLIENT_IDS.filter((id) => !cases.has(id));
  assert.deepEqual(
    missing,
    [],
    'these tracked tools fall through to the capitalized default instead of a real label: ' + missing.join(', ')
  );
});

test('tracked tool labels agree with the label its own surface uses', () => {
  // WidgetFormat.provider serves BOTH surfaces through one switch: a tool row
  // passes the catalog id, a limits row passes the provider id. They agree for
  // most ids, but a genuinely dual-namespace id carries two names — the app
  // calls the tracked client "Claude Code" while its quota window is "Claude",
  // and "Grok Build" vs "Grok". A limits row never reads this case (the
  // snapshot stamps displayName), so the shared case has to carry the provider
  // label; the tool row for that same id is labelled from the provider side too,
  // which is what the app already ships. Everything else must match the catalog,
  // because that is where a tool's own name lives.
  const cases = labelCasesForTrackedTool();
  for (const id of CLIENT_IDS) {
    const expected = LIMIT_PROVIDER_IDS.includes(id) ? LIMIT_PROVIDER_LABELS[id] : CLIENT_LABELS[id];
    assert.equal(cases.get(id), expected, 'WidgetFormat.provider("' + id + '")');
  }
});

test('every tracked tool resolves to a widget colour or adaptive ink', () => {
  const coloured = widgetColouredIds();
  const missing = CLIENT_IDS.filter((id) => !coloured.has(id));
  assert.deepEqual(
    missing,
    [],
    'these tracked tools would silently take the shared default blue: ' + missing.join(', ')
  );
});

// ---------------------------------------------------------------------------
// The same two surfaces from the provider side.
//
// `droid` and `factory` are two ids for one product: `droid` is the tracked
// client, `factory` is the limits provider that reads its quota. The colour and
// icon assertions above start from CLIENT_IDS, so neither covers `factory` —
// which is how it shipped resolving to a factory.svg that does not exist, and
// rendering the Circle fallback instead of the Droid mark its quota row is
// meant to carry. Starting from LIMIT_PROVIDER_IDS is what closes that gap.
function iconAliasesForProviders() {
  const swift = read('native', 'macos', 'TokenMonitorWidget', 'WidgetDashboardViews.swift');
  const start = swift.indexOf('static func iconName(for vendorID: String) -> String {');
  assert.notEqual(start, -1, 'WidgetVendorIdentity.iconName should exist');
  const end = swift.indexOf('default:', start);
  assert.notEqual(end, -1, 'the icon switch should have a default');
  const aliases = new Map();
  for (const match of swift.slice(start, end).matchAll(/case ([^:\n]+): "([^"]+)"/g)) {
    for (const id of match[1].matchAll(/"([^"]+)"/g)) aliases.set(id[1], match[2]);
  }
  return aliases;
}

test('every limits provider resolves to an icon asset that exists', () => {
  // Resolved through the alias the widget actually applies, so the invariant is
  // "this row renders a mark", not "a file is named after the id". Sharing
  // artwork is normal (factory -> droid, zaiteam -> zai, micode -> xiaomi).
  const aliases = iconAliasesForProviders();
  const missing = [];
  for (const id of LIMIT_PROVIDER_IDS) {
    const name = aliases.get(id) || id;
    const asset = path.join(rootDir, 'assets', 'icons', name + '.svg');
    if (!fs.existsSync(asset)) missing.push(id + ' -> ' + name + '.svg');
  }
  assert.deepEqual(
    missing,
    [],
    'these providers would render the Circle fallback instead of a mark: ' + missing.join(', ')
  );
});

test('every limits provider resolves to a widget colour or adaptive ink', () => {
  // The provider half of the colour guard above. Without this, a provider id
  // that is not also a tracked client could take the shared default blue and
  // read as a real vendor colour.
  const coloured = widgetColouredIds();
  const missing = LIMIT_PROVIDER_IDS.filter((id) => !coloured.has(id));
  assert.deepEqual(
    missing,
    [],
    'these providers would silently take the shared default blue: ' + missing.join(', ')
  );
});
