'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

function cssBlock(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} should exist`);
  const end = styles.indexOf('\n}', start);
  assert.notEqual(end, -1, `${selector} should have a closing brace`);
  return styles.slice(start, end + 2);
}

test('custom pricing rows keep their two-column layout contract', () => {
  const renderStart = app.indexOf('function renderCustomPricing()');
  const renderEnd = app.indexOf('function setupCustomPricingUI()', renderStart);
  const render = app.slice(renderStart, renderEnd);

  assert.match(render, /row\.className = 'managed-account-row custom-pricing-row'/);
  assert.match(render, /const main = document\.createElement\('button'\);\s*main\.type = 'button'/);
  assert.match(render, /remove\.className = 'managed-account-remove custom-pricing-remove'/);
  assert.match(cssBlock('.custom-pricing-row'), /grid-template-columns: minmax\(0, 1fr\) auto/);
});

test('custom pricing metadata and localized remove action cannot collapse vertically', () => {
  assert.match(cssBlock('.custom-pricing-row .managed-account-meta'), /white-space: nowrap/);
  assert.match(cssBlock('.custom-pricing-row .managed-account-meta'), /text-overflow: ellipsis/);

  const remove = cssBlock('.custom-pricing-row .custom-pricing-remove');
  assert.match(remove, /width: auto/);
  assert.match(remove, /padding: 0 8px/);
});
