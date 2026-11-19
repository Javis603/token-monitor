'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const prefs = require('../../src/electron/renderer/serviceStatusProviderPreferences');

const OPTIONS = [{ id: 'openai' }, { id: 'claude' }, { id: 'cursor' }, { id: 'deepseek' }];

test('normalizeOrder keeps known ids, drops unknown/dupes, appends missing in catalog order', () => {
  assert.deepEqual(prefs.normalizeOrder('cursor,cursor,ghost,claude', OPTIONS), ['cursor', 'claude', 'openai', 'deepseek']);
  assert.deepEqual(prefs.normalizeOrder('', OPTIONS), ['openai', 'claude', 'cursor', 'deepseek']);
});

test('hasCustomOrder is true only when a non-empty order is stored', () => {
  assert.equal(prefs.hasCustomOrder(''), false);
  assert.equal(prefs.hasCustomOrder('openai'), true);
});

test('normalizeHidden keeps only valid ids, deduped', () => {
  assert.equal(prefs.normalizeHidden('deepseek,ghost,deepseek,cursor', OPTIONS), 'deepseek,cursor');
  assert.equal(prefs.normalizeHidden('', OPTIONS), '');
});

test('orderedOptions returns option objects in stored order', () => {
  assert.deepEqual(prefs.orderedOptions(OPTIONS, 'cursor,openai'), [{ id: 'cursor' }, { id: 'openai' }, { id: 'claude' }, { id: 'deepseek' }]);
});

test('moveOrder shifts one step and clamps at the ends', () => {
  assert.equal(prefs.moveOrder('', OPTIONS, 'claude', 'up'), 'claude,openai,cursor,deepseek');
  assert.equal(prefs.moveOrder('', OPTIONS, 'openai', 'up'), 'openai,claude,cursor,deepseek');
  assert.equal(prefs.moveOrder('', OPTIONS, 'deepseek', 'down'), 'openai,claude,cursor,deepseek');
});

test('reorderOrder moves an id to a clamped target index', () => {
  assert.equal(prefs.reorderOrder('', OPTIONS, 'deepseek', 0), 'deepseek,openai,claude,cursor');
  assert.equal(prefs.reorderOrder('', OPTIONS, 'openai', 99), 'claude,cursor,deepseek,openai');
});

test('visibleOrder excludes hidden, respects order, and hide-all yields empty', () => {
  assert.deepEqual(prefs.visibleOrder(OPTIONS, 'cursor,openai', 'openai'), ['cursor', 'claude', 'deepseek']);
  assert.deepEqual(prefs.visibleOrder(OPTIONS, '', 'openai,claude,cursor,deepseek'), []);
});
