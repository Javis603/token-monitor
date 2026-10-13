'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

test('Linux and Windows selects keep the glass control and readable popup colors', () => {
  assert.match(
    app,
    /document\.documentElement\.classList\.toggle\('is-windows', isWindows\)/,
    'the renderer should expose the Windows platform class on the root element'
  );
  assert.match(
    css,
    /\.settings-panel select\s*\{[^}]*appearance:\s*none;[^}]*background:\s*rgba\(var\(--overlay-rgb\), 0\.05\);/s,
    'the closed select should retain the light glass treatment on every platform'
  );
  assert.doesNotMatch(
    css,
    /html\.is-windows \.settings-panel select\s*\{/,
    'Windows should not replace the closed glass control with a native field'
  );
  assert.match(
    css,
    /^html\.is-linux select option,\s*html\.is-linux select optgroup\s*\{[^}]*background-color:\s*rgb\(var\(--panel-rgb\)\);[^}]*color:\s*var\(--text\);/ms,
    'Linux popup options should have an explicit readable theme pair'
  );
});

test('the Linux popup fix preserves the upstream Windows rule and does not style macOS', () => {
  assert.match(app, /document\.documentElement\.classList\.toggle\('is-linux', isLinux\)/);
  assert.match(css, /^html\.is-windows \.settings-panel select option\s*\{[^}]*background-color:\s*rgb\(var\(--panel-rgb\)\);[^}]*color:\s*var\(--text\);/ms);
  assert.doesNotMatch(css, /^select (?:option|optgroup)/m);
});
