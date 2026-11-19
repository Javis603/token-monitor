'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { subscribeForegroundChange } = require('../../src/electron/windowsForegroundHook');

function source() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src/electron/windowsForegroundHook.js'), 'utf8');
}

test('nothing is hooked off Windows or without a handler', () => {
  assert.equal(subscribeForegroundChange(() => {}, { platform: 'darwin' }), null);
  assert.equal(subscribeForegroundChange(() => {}, { platform: 'linux' }), null);
  assert.equal(subscribeForegroundChange(null, { platform: 'win32' }), null);
  assert.equal(subscribeForegroundChange(undefined, { platform: 'win32' }), null);
});

// The callback runs from the OS message pump. Calling into Electron from there
// is the crash this file exists to avoid, so the body may only hand off.
test('the native callback only hands off to the next tick', () => {
  const body = source().match(/koffi\.register\(\(\) => \{([\s\S]*?)\}, lib\.koffi\.pointer/);
  assert.ok(body, 'expected a registered callback');
  assert.match(body[1], /setImmediate\(handler\)/);
  assert.doesNotMatch(body[1], /moveTop|mainWindow|BrowserWindow|require\(/);
});

// A hook that cannot be installed has to leave the caller its polling
// fallback rather than throwing out of subscribe.
test('every failure path returns null instead of throwing', () => {
  const text = source();
  assert.match(text, /const lib = loadUser32\(\);\n {2}if \(!lib\) return null;/);
  assert.match(text, /if \(!hook\) throw new Error\('SetWinEventHook returned NULL'\)/);
  assert.match(text, /\} catch \{\n {4}if \(callback\) \{/);
});

test('the hook is scoped to foreground changes outside our own process', () => {
  const text = source();
  assert.match(text, /const EVENT_SYSTEM_FOREGROUND = 0x0003;/);
  assert.match(text, /const WINEVENT_SKIPOWNPROCESS = 0x0002;/);
  assert.match(text, /WINEVENT_OUTOFCONTEXT \| WINEVENT_SKIPOWNPROCESS/);
  assert.match(text, /UnhookWinEvent\(hook\)/);
  assert.match(text, /koffi\.unregister\(callback\)/);
});
