'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

function rendererFunction(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return Function(`return (${app.slice(start, end).trim()})`)();
}

test('compact token formatter uses K, M, and B units', () => {
  const formatCompact = rendererFunction('formatCompact', 'updateTotalCompact');
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(1_500), '1.5K');
  assert.equal(formatCompact(2_000_000), '2M');
  assert.equal(formatCompact(3_400_000_000), '3.4B');
});

test('total token panel includes and styles the compact value', () => {
  assert.match(html, /id="totalTokensCompact" class="total-compact hidden"/);
  assert.match(css, /\.total-number-row\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.total-compact\s*\{[^}]*white-space:\s*nowrap/s);
});

test('compact total appears after the exact total finishes animating', () => {
  assert.match(app, /hideTotalCompact\(\);\s*animateNumber\([^;]+\(\) => updateTotalCompact\(nextTotal\)\)/s);
});
