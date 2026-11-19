'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function read(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('the renderer loads the polish and insights layers after app.js', () => {
  const html = read('index.html');
  // app.js is a classic script at the end of the body; deferred scripts in the
  // head run after parsing, so the layer executes after app.js without sharing
  // its crowded tail. Keep both orderings explicit in this test.
  assert.match(html, /<script src="motion.js" defer><\/script>/);
  assert.match(html, /<script src="insights.js" defer><\/script>/);
  assert.match(html, /<script src="app.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="motion.css" \/>/);
  assert.match(html, /<link rel="stylesheet" href="insights.css" \/>/);
  const headEnd = html.indexOf('</head>');
  assert.ok(html.indexOf('motion.js') < headEnd && html.indexOf('insights.js') < headEnd,
    'deferred scripts belong in the head');
  assert.ok(html.indexOf('app.js') > headEnd, 'app.js stays at the end of the body');
});

test('the session strip follows the same stats/settings pushes as the app', () => {
  const insights = read('insights.js');
  assert.match(insights, /onStatsPush\(/);
  assert.match(insights, /onSettingsPush\?\.\(/);
  assert.match(insights, /getSettings\(\)/);
  // The card must not build rows with untrusted HTML.
  assert.doesNotMatch(insights, /innerHTML/);
  // No polling and no second fetch: the strip rides the app's push cadence.
  assert.doesNotMatch(insights, /setInterval|setTimeout\(/);
  assert.doesNotMatch(insights, /getStats\(\)/);
  // The latest session comes from today first, then the broader periods.
  assert.match(insights, /\['today', 'month', 'allTime'\]/);
  // Context display follows the existing used/remaining preference.
  assert.match(insights, /sessionContextMetric/);
  // The provider quota is reduced to its most constrained window.
  assert.match(insights, /remainingPercent/);
});

test('the strip exposes an accessible popover and keeps motion opt-out', () => {
  const insights = read('insights.js');
  const css = read('insights.css');
  assert.match(insights, /aria-haspopup', 'dialog'/);
  assert.match(insights, /aria-expanded/);
  assert.match(insights, /event\.key !== 'Escape'/);
  assert.match(css, /\.session-status\b/);
  assert.match(css, /\.session-insight-card\b/);
  assert.match(css, /@container/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /data-reduce-motion="on"/);
});

test('view transitions and scroll memory stay passive and opt out cleanly', () => {
  const motion = read('motion.js');
  const css = read('motion.css');
  assert.match(motion, /is-surface-entering/);
  assert.match(motion, /scrollMemory/);
  assert.match(motion, /addEventListener\('scroll'/);
  assert.doesNotMatch(motion, /setInterval/);
  assert.match(css, /polish-surface-rise/);
  assert.match(css, /\.is-surface-entering > \*/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
