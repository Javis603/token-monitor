'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const ink = vm.runInNewContext(`(${app.match(/function customTrayTextColor[\s\S]*?\n\}/)[0]})`);

test('only floating-bubble task-rate text stays opaque white when available or unavailable', () => {
  const colors = ['rgba(12, 34, 56, 0.92)', 'rgba(12, 34, 56, 0.22)'];
  const task = { metric: 'liveTokenRate', rateMode: 'task', available: false };
  assert.equal(ink(task, ...colors, { taskSpeedWhite: true }), '#ffffff');
  assert.equal(ink({ ...task, available: true }, ...colors, { taskSpeedWhite: true }), '#ffffff');
  assert.equal(ink({ ...task, rateMode: 'speed' }, ...colors, { taskSpeedWhite: true }), colors[1]);
  assert.equal(ink({ ...task, rateMode: 'speed', available: true }, ...colors, { taskSpeedWhite: true }), colors[0]);
  assert.equal(ink(task, ...colors, { taskSpeedWhite: false }), colors[1]);
  assert.equal(ink({ metric: 'percent', available: false }, ...colors, { taskSpeedWhite: true }), colors[1]);
});
