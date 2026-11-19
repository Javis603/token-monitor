'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { clientStatusTag } = require('../../src/electron/renderer/clientStatusPresentation');

test('active and waiting share labels across clients', () => {
  assert.deepEqual(clientStatusTag('claude', 'active'), { key: 'settings.tools.status.active', tone: 'ok' });
  assert.deepEqual(clientStatusTag('cursor', 'active'), { key: 'settings.tools.status.active', tone: 'ok' });
  assert.deepEqual(clientStatusTag('opencode', 'waiting'), { key: 'settings.tools.status.waiting', tone: 'neutral' });
});

test('missing label is client-aware', () => {
  assert.deepEqual(clientStatusTag('claude', 'missing'), { key: 'settings.tools.status.missing', tone: 'muted' });
  assert.deepEqual(clientStatusTag('codex', 'missing'), { key: 'settings.tools.status.missing', tone: 'muted' });
  assert.deepEqual(clientStatusTag('cursor', 'missing'), { key: 'settings.tools.status.signIn', tone: 'setup' });
  assert.deepEqual(clientStatusTag('antigravity', 'missing'), { key: 'settings.tools.status.openApp', tone: 'setup' });
});

test('missing mapping is case-insensitive on client id', () => {
  assert.deepEqual(clientStatusTag('Cursor', 'missing'), { key: 'settings.tools.status.signIn', tone: 'setup' });
});

test('unknown or absent status yields no tag', () => {
  assert.equal(clientStatusTag('claude', undefined), null);
  assert.equal(clientStatusTag('claude', 'disabled'), null);
  assert.equal(clientStatusTag('claude', ''), null);
});
