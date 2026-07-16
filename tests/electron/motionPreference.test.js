'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const motionPreference = require(path.join(rendererDir, '..', 'motionPreference.js'));

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
  assert.match(main, /require\('\.\/motionPreference'\)/);
  assert.doesNotMatch(main, /function normalizeReduceMotion|REDUCE_MOTION_VALUES/);
  assert.match(main, /motionPreferenceApi\.normalize\(patch\.reduceMotion \?\? settings\.reduceMotion\)/);
  assert.match(main, /merged\.reduceMotion = motionPreferenceApi\.normalize\(merged\.reduceMotion\)/);
});

test('enabling reduced motion settles active row counters immediately', () => {
  const app = read('app.js');
  assert.match(app, /const rowNumberAnimationHandles = new Map\(\)/);
  assert.match(app, /for \(const \[el, handle\] of rowNumberAnimationHandles\)[\s\S]*?cancelAnimationFrame\(handle\)[\s\S]*?rowNumberAnimationHandles\.clear\(\)/);
  assert.match(app, /el\.dataset\.motionTarget = String\(to\)/);
});

test('system reduced motion receives the same catch-all CSS as explicit On', () => {
  const css = read('styles.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?:root:not\(\[data-reduce-motion="off"\]\) \*[\s\S]*?animation-duration: 0\.01ms !important[\s\S]*?transition-delay: 0s !important/);
  assert.match(css, /:root\[data-reduce-motion="on"\] \*[\s\S]*?transition-delay: 0s !important/);
});

test('main window and dashboard load the shared preference before their renderer', () => {
  const index = read('index.html');
  const dashboard = read('dashboard.html');

  const indexMotion = index.indexOf('../motionPreference.js');
  const indexApp = index.indexOf('app.js');
  const dashboardMotion = dashboard.indexOf('../motionPreference.js');
  const dashboardApp = dashboard.indexOf('dashboard.js');
  assert.notEqual(indexMotion, -1, 'main window should load the shared motion preference');
  assert.notEqual(indexApp, -1, 'main window should load app.js');
  assert.notEqual(dashboardMotion, -1, 'dashboard should load the shared motion preference');
  assert.notEqual(dashboardApp, -1, 'dashboard should load dashboard.js');
  assert.ok(indexMotion < indexApp, 'main window should load motion preference before app.js');
  assert.ok(dashboardMotion < dashboardApp, 'dashboard should load motion preference before dashboard.js');
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
