'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { paint } = require('../../src/electron/renderer/limits/svgPaint');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

test('quota charts paint through the CSSOM so CSP keeps every series colour', () => {
  const applied = [];
  const node = { style: { setProperty: (property, value) => applied.push([property, value]) } };
  assert.equal(paint(node, { stroke: '#6366f1', 'stroke-width': 2, opacity: 0.78, fill: null }), node);
  assert.deepEqual(applied, [['stroke', '#6366f1'], ['stroke-width', '2'], ['opacity', '0.78']]);
});

test('the history page loads the CSP-safe painter before the chart script', () => {
  const html = read('src/electron/renderer/limits/history.html');
  assert.match(html, /<script src="svgPaint\.js"><\/script><script src="history\.js"><\/script>/);
  assert.match(read('src/electron/renderer/limits/history.js'), /window\.TokenMonitorLimitSvgPaint\.paint/);
});
