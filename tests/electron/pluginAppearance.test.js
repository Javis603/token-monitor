'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeAppearance } = require('../../src/shared/plugins/appearance');
test('skin tokens cannot carry markup, arbitrary CSS or network assets', () => {
  const value = normalizeAppearance({ css: 'body{display:none}', fontUrl: 'https://example.test/a.woff', colors: { text: '#ffffff', arbitrary: 'url(x)' } });
  assert.deepEqual(Object.keys(value).sort(), ['colors','corners','density','font','panel']);
  assert.deepEqual(value.colors, { text: '#ffffff' });
});
