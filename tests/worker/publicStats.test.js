'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('public stats periods strip every project identity field', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const periods = worker.publicPeriods({ today: {
    projects: {
      'private-client': { label: 'Private-Client', tokens: 1, clients: { codex: 1 } }
    },
    sessions: { 'codex:s1': {
      client: 'codex', sessionId: 's1', totalTokens: 1,
      projectId: 'sha256:secret', projectLabel: 'Private-Client', projectPath: '/Users/alice/Private-Client'
    } }
  } });
  assert.deepEqual(periods.today.sessions['codex:s1'], { client: 'codex', sessionId: 's1', totalTokens: 1 });
  assert.equal(Object.hasOwn(periods.today, 'projects'), false);
  const json = JSON.stringify(periods);
  assert.doesNotMatch(json, /Private-Client/);
  assert.doesNotMatch(json, /private-client/);
});

test('Worker public stats strip every account identity and plan field', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const now = new Date().toISOString();
  const device = {
    deviceId: 'macbook',
    updatedAt: now,
    receivedAt: now,
    limits: {
      updatedAt: now,
      providers: [{
        provider: 'opencode',
        accountKey: 'sha256:private',
        accountEmail: 'work@example.com',
        accountName: 'work',
        accountLabel: 'work',
        planLabel: 'Go',
        status: 'ok',
        source: 'web',
        updatedAt: now,
        windows: []
      }]
    }
  };
  const hub = new worker.HubDO({
    storage: {
      async list(options) {
        assert.deepEqual(options, { prefix: 'dev:' });
        return new Map([['dev:macbook', device]]);
      }
    }
  }, { PUBLIC_STATS_ENABLED: '1' });

  const response = await hub.fetch(new Request('https://example.com/api/public/stats'));
  assert.equal(response.status, 200);
  const payload = await response.json();
  const provider = payload.limits.providers[0];
  assert.equal(provider.provider, 'opencode');
  for (const field of ['accountKey', 'accountEmail', 'accountName', 'accountLabel', 'planLabel']) {
    assert.equal(Object.hasOwn(provider, field), false, `${field} should stay private`);
  }
  assert.equal(Object.hasOwn(payload, 'devices'), false);
});

test('Worker authenticated stats expose the effective staleness threshold', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const hub = new worker.HubDO({
    storage: { async list() { return new Map(); } }
  }, { STALE_AFTER_MS: '7654321' });

  const stats = await hub.getStats();

  assert.equal(stats.staleAfterMs, 7654321);
});
