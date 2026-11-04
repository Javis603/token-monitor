'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createCardLayout } = require('../../src/electron/renderer/cardLayout');

test('shared card layout reports hidden content synchronously and cancels superseded or closed updates', () => {
  const frames = [], reports = [];
  const layout = createCardLayout({ measure: content => content.height, report: (height, content) => reports.push([height, content.id]),
    requestFrame: callback => { frames.push(callback); return frames.length; }, cancelFrame() {} });
  layout.prepare({ id: 'first', height: 300 }, { opening: true, afterPaint: true });
  assert.deepEqual(reports, [[300, 'first']]);
  layout.prepare({ id: 'stale', height: 400 }, { afterPaint: true });
  layout.prepare({ id: 'current', height: 350 }, { opening: true, afterPaint: true });
  frames.shift()();
  assert.deepEqual(reports, [[300, 'first'], [350, 'current']]);
  layout.prepare({ id: 'closed', height: 500 }, { afterPaint: true });
  frames.shift()();
  layout.cancel();
  frames.shift()();
  assert.equal(reports.length, 2, 'closing invalidates even an already queued second paint');
});

test('both card renderers load the shared layout before their renderer script', () => {
  for (const [html, script] of [['edgeDock/index.html', 'dock.js'], ['limits/history.html', 'history.js']]) {
    const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer', html), 'utf8');
    const shared = source.indexOf('<script src="../cardLayout.js">');
    assert.ok(shared >= 0 && shared < source.indexOf(`<script src="${script}">`), html);
  }
});
