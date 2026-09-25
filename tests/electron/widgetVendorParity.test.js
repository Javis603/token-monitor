'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { widgetVendorPalette } = require('../../src/shared/vendorPresentation');

const root = path.resolve(__dirname, '..', '..');
const chartSource = fs.readFileSync(path.join(root, 'src', 'electron', 'renderer', 'usageCharts.js'), 'utf8');
const widgetSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetDashboardViews.swift'),
  'utf8'
);

// The macOS widget colours its own breakdown rows from a second copy of the chart's
// model→vendor resolver. There is no way to share the code (one side is Swift), so the two
// are kept in step by copying each pattern verbatim — which makes the guard here list
// equality rather than a behavioural comparison of two hand-written forms. Re-expressing a
// pattern as substring tests is exactly what drifted before (`qwq`/`qvq` and the unanchored
// `o[134]-(mini|pro|preview)` alternative went missing, so those models fell through to
// "default" on the widget) and it fails here now: a rule the widget states any other way
// simply is not parsed, so the counts stop matching.
function sliceFunction(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `could not find ${JSON.stringify(start)} — resolver shape changed`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `could not find the end of ${JSON.stringify(start)}`);
  return source.slice(from, to);
}

function chartRules() {
  const body = sliceFunction(chartSource, 'function modelVendorFor(model) {', '\n  }\n');
  return [...body.matchAll(/if \(\/(.+?)\/\.test\(name\)\) return '([^']+)';/g)]
    .map(([, pattern, vendor]) => [pattern, vendor]);
}

function widgetRules() {
  const body = sliceFunction(
    widgetSource,
    'static func modelVendor(for model: String) -> String {',
    '\n    }'
  );
  return [...body.matchAll(/if matches\("((?:[^"\\]|\\.)*)"\) \{ return "([^"]+)" \}/g)]
    .map(([, pattern, vendor]) => [pattern.replace(/\\\\/g, '\\'), vendor]);
}

// Ids the widget can render without falling back to its "default" colour: the palette the
// app writes into the snapshot, from the vendor presentation table.
function widgetPalette() {
  const palette = widgetVendorPalette();
  return new Set(Object.keys(palette).filter((id) => id !== 'default' && (palette[id].color || palette[id].ink)));
}

test('the widget resolver mirrors the chart resolver rule for rule', () => {
  const chart = chartRules();
  const widget = widgetRules();
  assert.ok(chart.length > 0, 'parsed no chart rules — the chart resolver shape changed');
  assert.equal(
    widget.length,
    chart.length,
    `the widget resolved ${widget.length} rules against the chart's ${chart.length}`
  );
  assert.deepEqual(widget, chart);
});

test('every vendor the chart resolver can return has a widget colour', () => {
  const palette = widgetPalette();
  const missing = [...new Set(chartRules().map(([, vendor]) => vendor))].filter((id) => !palette.has(id));
  assert.deepEqual(missing, [], `no widget colour for ${missing.join(', ')} — those models render as "default"`);
});
