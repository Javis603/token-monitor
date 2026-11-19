'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { canonicalProjectKey, deterministicProjectLabel } = require('../../src/shared/projectKey');

test('project keys normalize Unicode and casing consistently', () => {
  assert.equal(canonicalProjectKey(' Cafe\u0301 '), 'café');
  assert.equal(canonicalProjectKey('CAFÉ'), 'café');
});

test('project display labels use deterministic code-unit ordering', () => {
  assert.equal(deterministicProjectLabel('Café', 'CAFÉ'), 'CAFÉ');
  assert.equal(deterministicProjectLabel('', ' App '), 'App');
});
