'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// app.js requires a renderer DOM, so the wiring is guarded at the source level.
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

test('plugin settings guide links follow the resolved app locale', () => {
  const start = source.indexOf('createPluginSettingsPanel({');
  assert.ok(start >= 0, 'plugin settings panel is created');
  const options = source.slice(start, source.indexOf('\n  })', start));
  // state.locale is never assigned; reading it produced ?lang=undefined.
  assert.match(options, /getLocale: currentLocale,/);
  assert.match(source, /function currentLocale\(\) \{\s*return i18n\.resolveLocale\(/);
});
