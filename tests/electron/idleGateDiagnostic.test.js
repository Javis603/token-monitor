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
  vm.runInNewContext(`${source}\nthis.appIsIdleForHeapCollection = appIsIdleForHeapCollection;`, context);
  return { isIdle: context.appIsIdleForHeapCollection, warnings };
}

test('a Linux session that reports zero idle time logs once after three checks', () => {
  const { isIdle, warnings } = gate('linux', 0);
  assert.equal(isIdle(), false);
  assert.equal(isIdle(), false);
  assert.equal(warnings.length, 0, 'a single zero can be real user input');
  assert.equal(isIdle(), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /stayed 0 on three consecutive idle checks/);
  assert.equal(isIdle(), false);
  assert.equal(warnings.length, 1, 'the diagnostic is one-time');
});

test('real idle time resets the zero counter and allows collection', () => {
  let idle = 0;
  const warnings = [];
  const context = {
    process: { platform: 'linux' },
    console: { warn: (...args) => warnings.push(args.join(' ')) },
    quitRequested: false,
    focusedAppWindow: () => null,
    powerMonitor: { getSystemIdleTime: () => idle }
  };
  vm.runInNewContext(`${source}\nthis.appIsIdleForHeapCollection = appIsIdleForHeapCollection;`, context);
  assert.equal(context.appIsIdleForHeapCollection(), false);
  assert.equal(context.appIsIdleForHeapCollection(), false);
  idle = 10;
  assert.equal(context.appIsIdleForHeapCollection(), true);
  idle = 0;
  assert.equal(context.appIsIdleForHeapCollection(), false);
  assert.equal(context.appIsIdleForHeapCollection(), false);
  assert.equal(warnings.length, 0, 'two zeros after a reset are not enough');
  assert.equal(context.appIsIdleForHeapCollection(), false);
  assert.equal(warnings.length, 1);
});

test('non-Linux zero idle time stays silent', () => {
  const { isIdle, warnings } = gate('darwin', 0);
  for (let i = 0; i < 4; i++) assert.equal(isIdle(), false);
  assert.equal(warnings.length, 0);
});
