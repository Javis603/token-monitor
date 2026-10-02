'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

test('open settings hides the fixed-height dashboard rows so a short window cannot squeeze it', () => {
  const rule = css.match(/\.shell\.settings-open > :is\(([^)]*)\)\s*\{\s*display:\s*none;\s*\}/);
  assert.ok(rule, 'settings-open should hide the dashboard rows that cannot shrink');
  const hidden = rule[1].split(',').map((selector) => selector.trim());
  for (const selector of ['.total-panel', '.view-back-row', '.detail-head', '.session-pager-host']) {
    assert.ok(hidden.includes(selector), `${selector} keeps its height, so it should step aside while settings is open`);
  }
});
