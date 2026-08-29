'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { publicStats } = require('../../src/shared/publicStats');
const { publicDevices, publicPeriods } = require('../../src/shared/usage');

const NOW = '2026-08-28T09:00:00.000Z';

function sampleStats() {
  return {
    updatedAt: NOW,
    staleAfterMs: 600000,
    historyRevision: 'rev-1',
    deviceHistoryRevision: 'dev-rev-1',
    subscriptionsUpdatedAt: NOW,
    historyPreview: { daily: [{ date: '2026-08-28', totalTokens: 10 }] },
    projectsIncomplete: false,
    devices: [{
      deviceId: 'macbook',
      hostname: 'macbook.local',
      platform: 'darwin-arm64',
      osName: 'macOS',
      osVersion: '26.0',
      agentVersion: '0.49.0',
      agentRuntime: 'headless-agent',
      updatedAt: NOW,
      receivedAt: NOW,
      ageMs: 1200,
      stale: false,
      trackedClients: ['codex'],
      periodWindows: { timeZone: 'Asia/Hong_Kong', today: { key: '2026-08-28' } },
      clientStatus: { codex: 'active' },
      clientHealth: {
        version: 1,
        observedAt: NOW,
        clients: { antigravity: { source: { state: 'missing' }, overall: 'unavailable' } }
      },
      wslStatus: { distros: [] },
      syncUploadIntervalMs: 1200000,
      periods: {
        today: {
          totalTokens: 1200,
          costUsd: 0.5,
          projects: { 'acme-vault': { label: 'Acme Vault', tokens: 1200, costUsd: 0.5 } },
          sessions: { 'codex:s1': {
            client: 'codex', sessionId: 's1', totalTokens: 1200,
            projectId: 'sha256:secret', projectLabel: 'Acme Vault', projectPath: '/Users/alice/Acme Vault'
          } }
        },
        month: { totalTokens: 5000, costUsd: 2 },
        allTime: { totalTokens: 9000, costUsd: 4 }
      },
      limits: {
        updatedAt: NOW,
        refreshMs: 300000,
        providers: [{
          provider: 'opencode',
          accountKey: 'sha256:private',
          webAccountKey: 'sha256:private-web',
          accountKeyAliases: ['sha256:private-legacy'],
          accountEmail: 'work@example.com',
          accountName: 'work',
          accountLabel: 'work',
          planLabel: 'Zen',
          workspaceKind: 'personal',
          status: 'ok',
          source: 'web',
          updatedAt: NOW,
          windows: [{ kind: 'weekly', usedPercent: 30, remainingPercent: 70 }],
          balance: { amount: 12.5, currency: 'USD', tranches: [{ amount: 12.5, currency: 'USD' }], quotaGroup: 'team-a' },
          usageSummary: { period: 'month', requests: 12, standardCost: 8 }
        }]
      }
    }],
    periods: {
      today: { totalTokens: 1200, costUsd: 0.5, projects: { 'acme-vault': { label: 'Acme Vault', tokens: 1200 } } },
      month: { totalTokens: 5000, costUsd: 2 },
      allTime: { totalTokens: 9000, costUsd: 4 }
    },
    limits: {
      updatedAt: NOW,
      refreshMs: 300000,
      providers: [{
        provider: 'opencode',
        accountKey: 'sha256:private',
        accountEmail: 'work@example.com',
        status: 'ok',
        updatedAt: NOW,
        windows: [{ kind: 'weekly', usedPercent: 30, remainingPercent: 70 }]
      }]
    }
  };
}

test('public stats strip every account identity field', () => {
  const view = publicStats(sampleStats());
  const provider = view.limits.providers[0];
  for (const field of ['accountKey', 'webAccountKey', 'accountKeyAliases', 'accountEmail', 'accountName', 'accountLabel', 'planLabel', 'workspaceKind']) {
    assert.equal(Object.hasOwn(provider, field), false, `${field} must not be public`);
  }
  assert.equal(Object.hasOwn(provider, 'usageSummary'), false);
  // What the view is for: the quota itself.
  assert.equal(provider.windows[0].usedPercent, 30);
});

test('public stats strip per-grant credit detail and custom group labels', () => {
  const view = publicStats(sampleStats());
  const balance = view.devices[0].limits.providers[0].balance;
  assert.equal(Object.hasOwn(balance, 'tranches'), false);
  assert.equal(Object.hasOwn(balance, 'quotaGroup'), false);
  // The headline money value stays: it is the number a viewer is watching.
  assert.equal(balance.amount, 12.5);
});

test('public stats carry no client diagnostics', () => {
  const view = publicStats(sampleStats());
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /clientHealth/);
  assert.doesNotMatch(json, /antigravity/);
  assert.doesNotMatch(json, /wslStatus/);
  assert.doesNotMatch(json, /clientStatus/);
  assert.doesNotMatch(json, /periodWindows/);
  assert.doesNotMatch(json, /trackedClients/);
  assert.doesNotMatch(json, /agentRuntime/);
  assert.doesNotMatch(json, /syncUploadIntervalMs/);
});

test('public stats strip project identity but keep the usage', () => {
  const view = publicStats(sampleStats());
  assert.equal(Object.hasOwn(view.periods.today, 'projects'), false);
  assert.equal(view.periods.today.totalTokens, 1200);
  assert.equal(view.periods.today.costUsd, 0.5);
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /Acme Vault/);
  assert.doesNotMatch(json, /acme-vault/);
  assert.doesNotMatch(json, /Users\/alice/);
});

test('public sessions keep their session fields and drop the project ones', () => {
  const periods = publicPeriods({ today: { sessions: { 'codex:s1': {
    client: 'codex', sessionId: 's1', totalTokens: 7,
    projectId: 'sha256:x', projectLabel: 'Secret', projectPath: '/home/alice/Secret'
  } } } });
  assert.deepEqual(periods.today.sessions['codex:s1'], { client: 'codex', sessionId: 's1', totalTokens: 7 });
});

// The point of the filtered row: "which machine burned what" is the whole
// feature, while the diagnostics that ride alongside it are the part that
// must not leave the authenticated surface.
test('public devices keep identity and usage and drop everything else', () => {
  const view = publicStats(sampleStats());
  const device = view.devices[0];
  assert.deepEqual(Object.keys(device).sort(), [
    'ageMs', 'deviceId', 'hostname', 'limits', 'osName', 'osVersion', 'periods', 'platform', 'receivedAt', 'stale', 'updatedAt'
  ]);
  assert.equal(device.periods.today.totalTokens, 1200);
  assert.equal(view.deviceCount, 1);
});

test('public stats never leak the subscription document version', () => {
  const view = publicStats(sampleStats());
  assert.equal(Object.hasOwn(view, 'subscriptionsUpdatedAt'), false);
  assert.equal(Object.hasOwn(view, 'deviceHistoryRevision'), false);
  // Yet the aggregate history a viewer does get to see is intact.
  assert.equal(view.historyPreview.daily[0].totalTokens, 10);
});

// The failure mode this guards: spreading getStats() and deleting what we know
// about makes every future top-level field public by default.
test('public stats do not forward unknown top-level fields', () => {
  const view = publicStats({ ...sampleStats(), someFutureField: { secret: true }, devices: [] });
  assert.equal(Object.hasOwn(view, 'someFutureField'), false);
  assert.equal(Object.hasOwn(view, 'devices'), true);
});

test('public stats tolerate an empty hub', () => {
  const view = publicStats({ updatedAt: NOW, periods: {}, limits: { providers: [] } });
  assert.equal(view.deviceCount, 0);
  assert.deepEqual(view.devices, []);
  assert.deepEqual(view.limits.providers, []);
});

test('public stats tolerate a nullish snapshot', () => {
  for (const input of [null, undefined, {}]) {
    const view = publicStats(input);
    assert.equal(view.deviceCount, 0);
    assert.equal(view.ok, true);
  }
});

test('public devices tolerate malformed rows without throwing', () => {
  assert.deepEqual(publicDevices(null), []);
  // Limits normalize to an empty summary rather than being omitted: a renderer
  // reading `row.limits.providers` must never have to null-check the middle.
  for (const row of publicDevices([null, undefined, {}])) {
    assert.deepEqual(row.periods, {});
    assert.deepEqual(row.limits.providers, []);
  }
});
