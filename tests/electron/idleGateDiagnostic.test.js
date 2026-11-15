'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const source = main.slice(
  main.indexOf('let idleTimeZeroChecks = 0;'),
  main.indexOf('\napp.whenReady().then')
);

function gate(platform, idleSeconds) {
  const warnings = [];
  const context = {
    process: { platform },
    console: { warn: (...args) => warnings.push(args.join(' ')) },
    quitRequested: false,
    focusedAppWindow: () => null,
    powerMonitor: { getSystemIdleTime: () => idleSeconds }
  };
  vm.runInNewContext(`${source}\nthis.appIsIdleForHeapCollection = appIsIdleForHeapCollection; this.noteIdleTimeZero = noteIdleTimeZero;`, context);
  return { isIdle: context.appIsIdleForHeapCollection, noteIdleTimeZero: context.noteIdleTimeZero, powerMonitor: context.powerMonitor, warnings };
}

test('ordinary active zero idle time stays silent', () => {
  const { isIdle, warnings } = gate('linux', 0);
  for (let i = 0; i < 5; i++) assert.equal(isIdle(), false);
  assert.equal(warnings.length, 0, 'input in another app also reports zero');
});

test('a locked Linux screen that reports zero idle time logs once after three checks', () => {
  const { noteIdleTimeZero, warnings } = gate('linux', 0);
  noteIdleTimeZero(true);
  noteIdleTimeZero(true);
  assert.equal(warnings.length, 0, 'two checks are not enough');
  noteIdleTimeZero(true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /while the screen was locked/);
  noteIdleTimeZero(true);
  assert.equal(warnings.length, 1, 'the diagnostic is one-time');
});

test('real idle time resets the zero counter and allows collection', () => {
  let idle = 0;
  const g = gate('linux', 0);
  g.noteIdleTimeZero(true);
  g.noteIdleTimeZero(true);
  idle = 10;
  g.powerMonitor.getSystemIdleTime = () => idle;
  assert.equal(g.isIdle(), true);
  idle = 0;
  g.powerMonitor.getSystemIdleTime = () => idle;
  g.noteIdleTimeZero(true);
  g.noteIdleTimeZero(true);
  assert.equal(g.warnings.length, 0, 'two zeros after a reset are not enough');
  g.noteIdleTimeZero(true);
  assert.equal(g.warnings.length, 1);
});

test('non-Linux zero idle time stays silent', () => {
  const { noteIdleTimeZero, warnings } = gate('darwin', 0);
  for (let i = 0; i < 4; i++) noteIdleTimeZero(true);
  assert.equal(warnings.length, 0);
});
