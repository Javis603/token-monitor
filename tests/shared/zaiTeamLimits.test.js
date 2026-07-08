'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { zaiTeamToken, ZAI_TEAM_QUOTA_URL, fetchZaiTeamLimits } = require('../../src/shared/zaiTeamLimits');
const { hashKey } = require('../../src/shared/hashKey');

test('zaiTeamToken accepts team-specific API key env names', () => {
  assert.equal(zaiTeamToken({ ZAI_TEAM_API_KEY: '  "team-key"  ' }), 'team-key');
  assert.equal(zaiTeamToken({ BIGMODEL_TEAM_API_KEY: 'bm-team-key' }), 'bm-team-key');
  assert.equal(zaiTeamToken({}, 'settings-key'), 'settings-key');
  // The personal-plan key must NOT satisfy the team provider (keys are decoupled).
  assert.equal(zaiTeamToken({ ZAI_API_KEY: 'personal-key' }), '');
});

test('team quota URL targets BigModel CN with the team type parameter', () => {
  assert.equal(
    ZAI_TEAM_QUOTA_URL,
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2'
  );
});

test('fetchZaiTeamLimits returns notConfigured when any credential is missing', async () => {
  const updatedAt = Date.parse('2026-07-06T00:00:00Z');
  const deps = { env: {}, now: () => updatedAt };
  const missingKey = await fetchZaiTeamLimits(
    { zaiTeamOrganizationId: 'org-1', zaiTeamProjectId: 'proj-1' },
    deps
  );
  assert.equal(missingKey.provider, 'zaiteam');
  assert.equal(missingKey.status, 'notConfigured');
  assert.equal(missingKey.region, 'bigmodel-cn');

  const missingOrg = await fetchZaiTeamLimits(
    { zaiTeamApiKey: 'team-key', zaiTeamProjectId: 'proj-1' },
    deps
  );
  assert.equal(missingOrg.status, 'notConfigured');

  const missingProject = await fetchZaiTeamLimits(
    { zaiTeamApiKey: 'team-key', zaiTeamOrganizationId: 'org-1' },
    deps
  );
  assert.equal(missingProject.status, 'notConfigured');
});

test('fetchZaiTeamLimits sends team headers and derives accountKey from org:project', async () => {
  const urls = [];
  const headers = [];
  const provider = await fetchZaiTeamLimits(
    { zaiTeamApiKey: 'team-key', zaiTeamOrganizationId: 'org-xxx', zaiTeamProjectId: 'proj_xxx' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async (url, init) => {
        urls.push(String(url));
        headers.push(init.headers);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 200,
            data: {
              level: 'max',
              limits: [
                { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 2, remaining: 3998, percentage: 1 },
                { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 26 },
                { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 5 }
              ]
            },
            success: true
          })
        };
      }
    }
  );

  assert.equal(provider.provider, 'zaiteam');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.region, 'bigmodel-cn');
  assert.equal(provider.accountLabel, 'Max');
  assert.equal(provider.accountKey, hashKey('zaiteam', 'org-xxx', 'proj_xxx'));
  assert.deepEqual(urls, [ZAI_TEAM_QUOTA_URL]);
  assert.deepEqual(headers, [{
    Authorization: 'Bearer team-key',
    'bigmodel-organization': 'org-xxx',
    'bigmodel-project': 'proj_xxx',
    Accept: 'application/json'
  }]);

  // parseZaiUsage is reused: same window kinds as the personal plan.
  assert.equal(provider.windows.length, 3);
  const session = provider.windows.find((window) => window.kind === 'session');
  const weekly = provider.windows.find((window) => window.kind === 'weekly');
  const billing = provider.windows.find((window) => window.kind === 'billing');
  assert.equal(session.label, '5-hour');
  assert.equal(session.usedPercent, 26);
  assert.equal(weekly.label, 'Weekly');
  assert.equal(weekly.usedPercent, 5);
  assert.equal(billing.label, 'MCP');
});

test('fetchZaiTeamLimits surfaces an invalid key as unauthorized', async () => {
  const provider = await fetchZaiTeamLimits(
    { zaiTeamApiKey: 'bad-key', zaiTeamOrganizationId: 'org-1', zaiTeamProjectId: 'proj-1' },
    {
      env: {},
      now: () => Date.parse('2026-07-06T00:00:00Z'),
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) })
    }
  );
  assert.equal(provider.provider, 'zaiteam');
  assert.equal(provider.status, 'unauthorized');
  assert.equal(provider.region, 'bigmodel-cn');
});

test('fetchZaiTeamLimits falls back to ZAI_TEAM_* env vars', async () => {
  const urls = [];
  const provider = await fetchZaiTeamLimits({}, {
    env: {
      ZAI_TEAM_API_KEY: 'env-team-key',
      ZAI_TEAM_ORGANIZATION_ID: 'org-env',
      ZAI_TEAM_PROJECT_ID: 'proj-env'
    },
    now: () => Date.parse('2026-07-06T00:00:00Z'),
    fetch: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 7 }] } })
      };
    }
  });
  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountKey, hashKey('zaiteam', 'org-env', 'proj-env'));
  assert.deepEqual(urls, [ZAI_TEAM_QUOTA_URL]);
});
