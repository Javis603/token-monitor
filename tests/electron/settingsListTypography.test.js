'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

function cssRule(source, selector) {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

// `html, body` set a font family but no size, so anything that neither declares
// a font-size nor inherits one renders at the browser's 16px default — twice the
// panel's type size, and unmistakable on screen. Each settings list row must
// therefore own its size rather than leave it to an optional child.
test('each settings list row owns its type size rather than an optional child', () => {
  const css = readRendererFile('styles.css');
  assert.match(cssRule(css, '.settings-panel .limit-provider-row'), /font-size:\s*11px/);
  assert.match(cssRule(css, '.tool-preference-name'), /font-size:\s*11px/);
});

// The disclosure button only exists for providers that have something to
// expand. While it was the only thing declaring the size, every provider
// without options rendered its name at 16px.
test('the limit provider disclosure button does not re-declare the type size', () => {
  const css = readRendererFile('styles.css');
  assert.doesNotMatch(cssRule(css, '.limit-provider-main'), /font-size/);
  const app = readRendererFile('app.js');
  assert.match(app, /const hasOptions = Boolean\(accountGroup \|\| settings \|\| connectionDetailKey\);/);
  assert.match(app, /\} else \{\n\s*row\.append\(wrap, copy, actions\);/);
});
