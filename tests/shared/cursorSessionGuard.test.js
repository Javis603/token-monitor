'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isCursorEventScopedSession } = require('../../src/shared/providers/cursor/sessionGuard');

test('Cursor event-scoped IDs match tokscale cursor-active timestamps only', () => {
  assert.equal(isCursorEventScopedSession({
    client: 'cursor',
    sessionId: 'cursor-active-2026-08-13T02:42:39.510Z'
  }), true);
  assert.equal(isCursorEventScopedSession(
    { client: 'cursor' },
    'cursor:cursor-active-2026-08-13T02:42:39.510Z'
  ), true);
  assert.equal(isCursorEventScopedSession({
    client: 'cursor',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  }), false);
  assert.equal(isCursorEventScopedSession({
    client: 'cursor',
    sessionId: 'cursor-active-legacy-row'
  }), false);
  assert.equal(isCursorEventScopedSession({
    client: 'codex',
    sessionId: 'cursor-active-2026-08-13T02:42:39.510Z'
  }), false);
});
