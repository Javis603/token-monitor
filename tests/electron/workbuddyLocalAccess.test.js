'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWorkbuddyLocalAccess,
  disabledStatus
} = require('../../src/electron/workbuddyLocalAccess');

test('disabled WorkBuddy Local App access performs no auth reads or app operations', async () => {
  let enabled = false;
  const calls = { status: 0, session: 0, open: 0 };
  const access = createWorkbuddyLocalAccess({
    isEnabled: () => enabled,
    auth: {
      status: () => { calls.status += 1; return { status: 'connected' }; },
      getSessionInfo: () => { calls.session += 1; return { userId: 'private' }; },
      openApp: async () => { calls.open += 1; return { ok: true }; }
    }
  });

  assert.deepEqual(access.status(), disabledStatus());
  assert.deepEqual(access.getSessionInfo(), {});
  await assert.rejects(access.openApp(), /not enabled/);
  assert.deepEqual(calls, { status: 0, session: 0, open: 0 });

  enabled = true;
  assert.deepEqual(access.status(), { status: 'connected' });
  assert.deepEqual(access.getSessionInfo(), { userId: 'private' });
  await access.openApp();
  assert.deepEqual(calls, { status: 1, session: 1, open: 1 });

  enabled = false;
  assert.deepEqual(access.status(), disabledStatus());
  assert.deepEqual(access.getSessionInfo(), {});
  assert.deepEqual(calls, { status: 1, session: 1, open: 1 });
});
