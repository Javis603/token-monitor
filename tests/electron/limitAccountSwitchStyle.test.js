const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '../../src/electron/renderer');

function readRendererFile(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

test('Codex account switch hover action stays visually secondary', () => {
  const css = readRendererFile('styles.css');
  const rule = cssRule(css, '.limit-account-switch-button');
  const hoverRule = cssRule(css, '.limit-account-switch-button:hover,\n.limit-account-switch-button:focus-visible');

  assert.match(rule, /height:\s*22px/);
  assert.match(rule, /padding:\s*0 6px/);
  assert.match(rule, /font-size:\s*9px/);
  assert.doesNotMatch(rule, /min-width/);
  assert.doesNotMatch(rule, /0 5px 12px/);
  assert.doesNotMatch(hoverRule, /outline:/);
});

test('Codex active-account badge stays quieter than the switch action', () => {
  const css = readRendererFile('styles.css');
  const rule = cssRule(css, '.limit-account-active-popover');

  assert.match(rule, /padding:\s*0 6px/);
  assert.match(rule, /border-radius:\s*6px/);
  assert.match(rule, /background:\s*rgba\(var\(--overlay-rgb\), 0\.075\)/);
  assert.match(rule, /font-size:\s*9px/);
  assert.match(rule, /line-height:\s*22px/);
  assert.doesNotMatch(rule, /cursor:\s*pointer/);
});
