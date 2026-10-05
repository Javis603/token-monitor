'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('Worker stores and removes authenticated ActivityKit registrations', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const entries = new Map();
  const storage = {
    async list({ prefix }) {
      return new Map(Array.from(entries.entries()).filter(([key]) => key.startsWith(prefix)));
    },
    async put(key, value) { entries.set(key, value); },
    async delete(key) { entries.delete(key); }
  };
  const hub = new worker.HubDO({ storage }, { TOKEN_MONITOR_SECRET: 'secret' });
  const payload = {
    activityID: 'activity-1',
    token: 'c'.repeat(64),
    locale: 'en-US',
    preferences: { liveActivityEnabled: true }
  };
  const headers = {
    authorization: 'Bearer secret',
    'content-type': 'application/json'
  };

  const register = await hub.fetch(new Request(
    'https://example.com/api/live-activities/register',
    { method: 'POST', headers, body: JSON.stringify(payload) }
  ));
  assert.equal(register.status, 200);
  assert.deepEqual(await register.json(), {
    ok: true,
    activityID: 'activity-1',
    pushEnabled: false
  });
  assert.equal(entries.has('activity:activity-1'), true);

  const remove = await hub.fetch(new Request(
    'https://example.com/api/live-activities/activity-1',
    { method: 'DELETE', headers }
  ));
  assert.equal(remove.status, 200);
  assert.equal(entries.has('activity:activity-1'), false);
});
