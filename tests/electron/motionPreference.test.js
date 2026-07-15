'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const motionPreference = require(path.join(rendererDir, 'motionPreference.js'));

function read(name) {
  return fs.readFileSync(path.join(rendererDir, name), 'utf8');
}

test('motion preference normalizes unknown values to system', () => {
  assert.equal(motionPreference.normalize('system'), 'system');
  assert.equal(motionPreference.normalize('on'), 'on');
  assert.equal(motionPreference.normalize('off'), 'off');
  assert.equal(motionPreference.normalize('unknown'), 'system');
});

test('motion preference uses reduce-motion semantics for all three states', () => {
  assert.equal(motionPreference.shouldReduceMotion('system', true), true);
  assert.equal(motionPreference.shouldReduceMotion('system', false), false);
  assert.equal(motionPreference.shouldReduceMotion('on', false), true);
  assert.equal(motionPreference.shouldReduceMotion('off', true), false);
});

test('appearance exposes and persists the three-state motion control', () => {
  const html = read('index.html');
  const app = read('app.js');
  const main = fs.readFileSync(path.join(rendererDir, '..', 'main.js'), 'utf8');

  assert.match(html, /<select id="reduceMotionInput">[\s\S]*?value="system"[\s\S]*?value="on"[\s\S]*?value="off"/);
  assert.match(app, /reduceMotion: els\.reduceMotionInput\?\.value \|\| 'system'/);
  assert.match(app, /document\.documentElement\.dataset\.reduceMotion = preference/);
  assert.match(main, /reduceMotion: 'system'/);
  assert.match(main, /normalizeReduceMotion\(patch\.reduceMotion \?\? settings\.reduceMotion\)/);
});

test('main window and dashboard load the shared preference before their renderer', () => {
  const index = read('index.html');
  const dashboard = read('dashboard.html');

  assert.ok(index.indexOf('motionPreference.js') < index.indexOf('app.js'));
  assert.ok(dashboard.indexOf('motionPreference.js') < dashboard.indexOf('dashboard.js'));
});

test('motion preference labels exist in every bundled locale', () => {
  const { MESSAGES } = require(path.join(rendererDir, 'i18n.js'));
  const keys = [
    'settings.appearance.reduceMotion',
    'settings.appearance.reduceMotionNote',
    'settings.appearance.motion.system',
    'settings.appearance.motion.on',
    'settings.appearance.motion.off'
  ];
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    for (const key of keys) assert.ok(messages[key], `${locale} should define ${key}`);
  }
});
