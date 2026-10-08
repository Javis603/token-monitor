'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Home moves narrow columns below and gives an orphan final module the complete row', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/styles.css'), 'utf8');
  const start = css.indexOf('#homePanel { display: flex;');
  const end = css.indexOf('\n.home-module {', start);
  assert.ok(start >= 0 && end > start);
  const home = css.slice(start, end);
  assert.match(home, /@media \(min-width: 816px\)/);
  assert.match(home, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(home, /:last-child:nth-child\(odd\) \{ grid-column: 1 \/ -1;/);
  assert.doesNotMatch(home, /repeat\(3|grid-auto-flow:\s*dense|order:/);
  assert.match(home, /flex-direction: column/);
});
