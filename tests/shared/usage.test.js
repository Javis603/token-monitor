'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { aggregateDevices, extractUsageFromTokscale, mergeDeviceRecord } = require('../../src/shared/usage');

function recordWithLimits(extra = {}) {
  return {
    deviceId: 'macbook',
    hostname: 'macbook.local',
    platform: 'darwin',
    updatedAt: '2026-05-27T00:00:00.000Z',
    receivedAt: '2026-05-27T00:00:00.000Z',
    today: { totalTokens: 1, costUsd: 0, clients: { cursor: 1 }, clientCosts: {} },
    month: { totalTokens: 1, costUsd: 0, clients: {}, clientCosts: {} },
    allTime: { totalTokens: 1, costUsd: 0, clients: {}, clientCosts: {} },
    limits: {
      updatedAt: '2026-05-27T00:00:00.000Z',
      refreshMs: 300000,
      providers: [
        {
          provider: 'cursor',
          accountKey: 'sha256:cursor',
          accountLabel: 'Free',
          status: 'ok',
          source: 'web',
          updatedAt: '2026-05-27T00:00:00.000Z',
          windows: [{ kind: 'billing', label: 'Total', usedPercent: 12 }]
        }
      ]
    },
    ...extra
  };
}

test('mergeDeviceRecord preserves existing limits when incoming payload omits limits', () => {
  const existing = recordWithLimits();
  const incoming = {
    deviceId: 'macbook',
    hostname: 'macbook.local',
    platform: 'darwin',
    updatedAt: '2026-05-27T00:01:00.000Z',
    receivedAt: '2026-05-27T00:01:00.000Z',
    today: { totalTokens: 5, costUsd: 0, clients: { cursor: 5 }, clientCosts: {} }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.equal(merged.periods.today.totalTokens, 5);
  assert.equal(merged.limits.providers.length, 1);
  assert.equal(merged.limits.providers[0].provider, 'cursor');
  assert.equal(merged.limits.providers[0].status, 'ok');
});

test('mergeDeviceRecord allows explicit empty limits to clear stale provider state', () => {
  const existing = recordWithLimits();
  const incoming = {
    deviceId: 'macbook',
    updatedAt: '2026-05-27T00:01:00.000Z',
    receivedAt: '2026-05-27T00:01:00.000Z',
    limits: { updatedAt: '2026-05-27T00:01:00.000Z', refreshMs: 300000, providers: [] }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.deepEqual(merged.limits.providers, []);
});

test('mergeDeviceRecord supports limitsOnly updates without wiping usage periods', () => {
  const existing = recordWithLimits();
  const incoming = {
    deviceId: 'macbook',
    receivedAt: '2026-05-27T00:02:00.000Z',
    limitsOnly: true,
    limits: {
      updatedAt: '2026-05-27T00:02:00.000Z',
      refreshMs: 300000,
      providers: [{ provider: 'cursor', status: 'unauthorized', source: 'web', updatedAt: '2026-05-27T00:02:00.000Z', windows: [] }]
    }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.equal(merged.periods.today.totalTokens, 1);
  assert.equal(merged.limits.providers[0].status, 'unauthorized');
});

test('mergeDeviceRecord keeps widget Copilot limits when a headless agent reports no local token', () => {
  const existing = recordWithLimits({
    agentRuntime: 'electron-widget',
    limits: {
      updatedAt: '2026-06-26T08:00:00.000Z',
      refreshMs: 300000,
      providers: [
        {
          provider: 'copilot',
          accountKey: 'sha256:copilot-token',
          accountLabel: 'Pro',
          status: 'ok',
          source: 'api',
          updatedAt: '2026-06-26T08:00:00.000Z',
          windows: [{ kind: 'billing', label: 'Premium requests', usedPercent: 20 }]
        }
      ]
    }
  });
  const incoming = {
    deviceId: 'macbook',
    agentRuntime: 'headless-agent',
    updatedAt: '2026-06-26T08:01:00.000Z',
    receivedAt: '2026-06-26T08:01:00.000Z',
    limits: {
      updatedAt: '2026-06-26T08:01:00.000Z',
      refreshMs: 300000,
      providers: [{ provider: 'copilot', status: 'notConfigured', source: 'api', updatedAt: '2026-06-26T08:01:00.000Z', windows: [] }]
    }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.equal(merged.limits.providers.length, 1);
  assert.equal(merged.limits.providers[0].provider, 'copilot');
  assert.equal(merged.limits.providers[0].status, 'ok');
  assert.equal(merged.limits.providers[0].accountKey, 'sha256:copilot-token');
});

test('mergeDeviceRecord allows the same runtime to clear Copilot limits', () => {
  const existing = recordWithLimits({
    agentRuntime: 'electron-widget',
    limits: {
      updatedAt: '2026-06-26T08:00:00.000Z',
      refreshMs: 300000,
      providers: [
        { provider: 'copilot', accountKey: 'sha256:copilot-token', status: 'ok', source: 'api', updatedAt: '2026-06-26T08:00:00.000Z', windows: [] }
      ]
    }
  });
  const incoming = {
    deviceId: 'macbook',
    agentRuntime: 'electron-widget',
    updatedAt: '2026-06-26T08:01:00.000Z',
    receivedAt: '2026-06-26T08:01:00.000Z',
    limits: {
      updatedAt: '2026-06-26T08:01:00.000Z',
      refreshMs: 300000,
      providers: [{ provider: 'copilot', status: 'notConfigured', source: 'api', updatedAt: '2026-06-26T08:01:00.000Z', windows: [] }]
    }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.equal(merged.limits.providers.length, 1);
  assert.equal(merged.limits.providers[0].provider, 'copilot');
  assert.equal(merged.limits.providers[0].status, 'notConfigured');
});

test('mergeDeviceRecord preserves distinct Codex and OpenCode accounts from the same incoming limits payload', () => {
  const existing = recordWithLimits({
    limits: {
      updatedAt: '2026-06-26T08:00:00.000Z',
      refreshMs: 300000,
      providers: []
    }
  });
  const incoming = {
    deviceId: 'macbook',
    updatedAt: '2026-06-26T08:01:00.000Z',
    receivedAt: '2026-06-26T08:01:00.000Z',
    limits: {
      updatedAt: '2026-06-26T08:01:00.000Z',
      refreshMs: 300000,
      providers: [
        { provider: 'codex', accountKey: 'sha256:codex-a', accountEmail: 'a@example.com', status: 'ok', source: 'rpc', updatedAt: '2026-06-26T08:01:00.000Z', windows: [] },
        { provider: 'codex', accountKey: 'sha256:codex-b', accountEmail: 'b@example.com', status: 'ok', source: 'rpc', updatedAt: '2026-06-26T08:01:00.000Z', windows: [] },
        { provider: 'opencode', accountKey: 'sha256:opencode-a', accountLabel: 'work', status: 'ok', source: 'web', updatedAt: '2026-06-26T08:01:00.000Z', windows: [] },
        { provider: 'opencode', accountKey: 'sha256:opencode-b', accountLabel: 'personal', status: 'ok', source: 'web', updatedAt: '2026-06-26T08:01:00.000Z', windows: [] }
      ]
    }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.deepEqual(
    merged.limits.providers.map((provider) => `${provider.provider}:${provider.accountKey}`),
    ['codex:sha256:codex-a', 'codex:sha256:codex-b', 'opencode:sha256:opencode-a', 'opencode:sha256:opencode-b']
  );
});

test('mergeDeviceRecord preserves usage for clients omitted by the active tracked-client list', () => {
  const existing = {
    deviceId: 'macbook',
    trackedClients: ['codex', 'hermes'],
    updatedAt: '2026-05-30T12:00:00.000Z',
    today: {
      totalTokens: 150,
      costUsd: 1.5,
      clients: { hermes: 100, codex: 50 },
      clientCosts: { hermes: 1.25, codex: 0.25 },
      models: { 'claude-3-5-sonnet': 100, 'gpt-5': 50 },
      modelCosts: { 'claude-3-5-sonnet': 1.25, 'gpt-5': 0.25 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 100 }, codex: { 'gpt-5': 50 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 1.25 }, codex: { 'gpt-5': 0.25 } },
      sessions: {
        'hermes:h1': {
          client: 'hermes',
          sessionId: 'h1',
          totalTokens: 100,
          costUsd: 1.25,
          messageCount: 4,
          models: { 'claude-3-5-sonnet': 100 },
          modelCosts: { 'claude-3-5-sonnet': 1.25 }
        },
        'codex:c1': {
          client: 'codex',
          sessionId: 'c1',
          totalTokens: 50,
          costUsd: 0.25,
          messageCount: 2,
          models: { 'gpt-5': 50 },
          modelCosts: { 'gpt-5': 0.25 }
        }
      }
    }
  };
  const incoming = {
    deviceId: 'macbook',
    trackedClients: ['codex'],
    updatedAt: '2026-05-30T12:01:00.000Z',
    today: {
      totalTokens: 75,
      costUsd: 0.5,
      clients: { codex: 75 },
      clientCosts: { codex: 0.5 },
      models: { 'gpt-5': 75 },
      modelCosts: { 'gpt-5': 0.5 },
      clientModels: { codex: { 'gpt-5': 75 } },
      clientModelCosts: { codex: { 'gpt-5': 0.5 } }
    }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.equal(merged.trackedClients.join(','), 'codex');
  assert.equal(merged.periods.today.totalTokens, 175);
  assert.equal(merged.periods.today.clients.codex, 75);
  assert.equal(merged.periods.today.clients.hermes, 100);
  assert.equal(merged.periods.today.models['gpt-5'], 75);
  assert.equal(merged.periods.today.models['claude-3-5-sonnet'], 100);
  assert.equal(merged.periods.today.clientModels.hermes['claude-3-5-sonnet'], 100);
  assert.equal(merged.periods.today.sessions['hermes:h1'].totalTokens, 100);
  assert.equal(merged.periods.today.sessions['codex:c1'], undefined);
});

test('mergeDeviceRecord preserves omitted-client day and month usage only inside matching calendar periods', () => {
  const existing = {
    deviceId: 'macbook',
    trackedClients: ['codex', 'hermes'],
    updatedAt: '2026-05-30T12:00:00.000Z',
    today: {
      totalTokens: 150,
      costUsd: 1.5,
      clients: { hermes: 100, codex: 50 },
      clientCosts: { hermes: 1.25, codex: 0.25 },
      models: { 'claude-3-5-sonnet': 100, 'gpt-5': 50 },
      modelCosts: { 'claude-3-5-sonnet': 1.25, 'gpt-5': 0.25 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 100 }, codex: { 'gpt-5': 50 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 1.25 }, codex: { 'gpt-5': 0.25 } }
    },
    month: {
      totalTokens: 450,
      costUsd: 4.5,
      clients: { hermes: 300, codex: 150 },
      clientCosts: { hermes: 3.75, codex: 0.75 },
      models: { 'claude-3-5-sonnet': 300, 'gpt-5': 150 },
      modelCosts: { 'claude-3-5-sonnet': 3.75, 'gpt-5': 0.75 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 300 }, codex: { 'gpt-5': 150 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 3.75 }, codex: { 'gpt-5': 0.75 } }
    },
    allTime: {
      totalTokens: 1200,
      costUsd: 12,
      clients: { hermes: 900, codex: 300 },
      clientCosts: { hermes: 11.25, codex: 0.75 },
      models: { 'claude-3-5-sonnet': 900, 'gpt-5': 300 },
      modelCosts: { 'claude-3-5-sonnet': 11.25, 'gpt-5': 0.75 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 900 }, codex: { 'gpt-5': 300 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 11.25 }, codex: { 'gpt-5': 0.75 } }
    }
  };
  const incoming = {
    deviceId: 'macbook',
    trackedClients: ['codex'],
    updatedAt: '2026-05-31T00:01:00.000Z',
    today: {
      totalTokens: 75,
      costUsd: 0.5,
      clients: { codex: 75 },
      clientCosts: { codex: 0.5 },
      models: { 'gpt-5': 75 },
      modelCosts: { 'gpt-5': 0.5 },
      clientModels: { codex: { 'gpt-5': 75 } },
      clientModelCosts: { codex: { 'gpt-5': 0.5 } }
    },
    month: {
      totalTokens: 175,
      costUsd: 0.75,
      clients: { codex: 175 },
      clientCosts: { codex: 0.75 },
      models: { 'gpt-5': 175 },
      modelCosts: { 'gpt-5': 0.75 },
      clientModels: { codex: { 'gpt-5': 175 } },
      clientModelCosts: { codex: { 'gpt-5': 0.75 } }
    },
    allTime: {
      totalTokens: 350,
      costUsd: 1,
      clients: { codex: 350 },
      clientCosts: { codex: 1 },
      models: { 'gpt-5': 350 },
      modelCosts: { 'gpt-5': 1 },
      clientModels: { codex: { 'gpt-5': 350 } },
      clientModelCosts: { codex: { 'gpt-5': 1 } }
    }
  };

  const nextDay = mergeDeviceRecord(existing, incoming);
  assert.equal(nextDay.periods.today.clients.hermes, undefined);
  assert.equal(nextDay.periods.today.models['claude-3-5-sonnet'], undefined);
  assert.equal(nextDay.periods.month.clients.hermes, 300);
  assert.equal(nextDay.periods.month.models['claude-3-5-sonnet'], 300);
  assert.equal(nextDay.periods.allTime.clients.hermes, 900);
  assert.equal(nextDay.periods.allTime.models['claude-3-5-sonnet'], 900);

  const nextMonth = mergeDeviceRecord(existing, {
    ...incoming,
    updatedAt: '2026-06-01T00:01:00.000Z',
    month: incoming.today
  });
  assert.equal(nextMonth.periods.today.clients.hermes, undefined);
  assert.equal(nextMonth.periods.month.clients.hermes, undefined);
  assert.equal(nextMonth.periods.month.models['claude-3-5-sonnet'], undefined);
  assert.equal(nextMonth.periods.allTime.clients.hermes, 900);
});

test('extractUsageFromTokscale normalizes Antigravity client names', () => {
  const period = extractUsageFromTokscale([
    { client: 'Google Antigravity', model: 'gemini-3-pro', totalTokens: 42, costUsd: 0.125 }
  ]);

  assert.equal(period.clients.antigravity, 42);
  assert.equal(period.clientCosts.antigravity, 0.125);
});

test('extractUsageFromTokscale normalizes Kimi, Qwen, and Grok Build client names', () => {
  const period = extractUsageFromTokscale([
    { client: 'Kimi CLI', model: 'kimi-code/kimi-for-coding', totalTokens: 11 },
    { client: 'Kimi Code', model: 'kimi-code/kimi-for-coding', totalTokens: 13 },
    { client: 'Qwen CLI', model: 'qwen3.5-plus', totalTokens: 17 },
    { client: 'Grok Build', model: 'grok-composer-2.5-fast', totalTokens: 19 }
  ]);

  assert.equal(period.clients.kimi, 24);
  assert.equal(period.clients.qwen, 17);
  assert.equal(period.clients.grok, 19);
});

test('extractUsageFromTokscale normalizes GitHub Copilot client names', () => {
  const period = extractUsageFromTokscale([
    { client: 'GitHub Copilot', model: 'gpt-4.1', totalTokens: 21 },
    { client: 'Copilot CLI', model: 'gpt-4.1', totalTokens: 9 }
  ]);

  assert.equal(period.clients.copilot, 30);
});

test('extractUsageFromTokscale normalizes Pi, Zed, and Kilo Code, keeping Copilot distinct', () => {
  const period = extractUsageFromTokscale([
    { client: 'pi', model: 'claude-opus-4-8', totalTokens: 11 },
    { client: 'copilot', model: 'gpt-5.5', totalTokens: 13 },
    { client: 'zed', model: 'claude-opus-4-8', totalTokens: 17 },
    { client: 'kilocode', model: 'gpt-5.5', totalTokens: 19 }
  ]);

  assert.equal(period.clients.pi, 11);
  assert.equal(period.clients.copilot, 13);
  assert.equal(period.clients.zed, 17);
  assert.equal(period.clients.kilocode, 19);
});

test('extractUsageFromTokscale normalizes MiMo Code and ZCode client ids', () => {
  const period = extractUsageFromTokscale([
    { client: 'micode', model: 'mimo-v2.5-pro', totalTokens: 23 },
    { client: 'ZCode', model: 'glm-4.7', totalTokens: 29 }
  ]);

  assert.equal(period.clients.micode, 23);
  assert.equal(period.clients.zcode, 29);
});

test('extractUsageFromTokscale passes zcode input straight through (tokscale normalizes cache upstream)', () => {
  // tokscale >= 4.0.11 emits zcode rows whose `input` already excludes cache
  // overlap (junhoyeo/tokscale#825), so zcode is aggregated like any other
  // client with no local subtraction. If the removed workaround still ran it
  // would subtract cache a second time (200 - 800 clamped to 0) and under-count.
  const period = extractUsageFromTokscale({
    groupBy: 'client,session,model',
    entries: [
      {
        client: 'ZCode',
        sessionId: 'sess-z1',
        model: 'glm-5.2',
        provider: 'zhipu',
        input: 200,
        output: 50,
        cacheRead: 800,
        cacheWrite: 0,
        reasoning: 10,
        messageCount: 1,
        cost: 0.1,
        timestamp: '2026-07-05T00:00:00.000Z'
      }
    ]
  });

  assert.equal(period.clients.zcode, 1050);
  assert.equal(period.totalTokens, 1050);
  assert.equal(period.cacheReadTokens, 800);
  assert.equal(period.clientCacheReads.zcode, 800);
  assert.equal(period.clientOutputs.zcode, 50);

  const session = period.sessions['zcode:sess-z1'];
  assert.equal(session.totalTokens, 1050);
  assert.equal(session.inputTokens, 200);
  assert.equal(session.cacheReadTokens, 800);
  assert.equal(session.outputTokens, 50);
  assert.equal(session.reasoningTokens, 10);
  assert.equal(session.models['glm-5.2'], 1050);
});

test('extractUsageFromTokscale normalizes Kiro client ids', () => {
  const period = extractUsageFromTokscale([
    { client: 'kiro', model: 'claude-sonnet-4', totalTokens: 31 },
    { client: 'Kiro', model: 'claude-sonnet-4', totalTokens: 7 }
  ]);

  assert.equal(period.clients.kiro, 38);
});

test('extractUsageFromTokscale normalizes CodeBuddy and WorkBuddy client ids', () => {
  const period = extractUsageFromTokscale([
    { client: 'codebuddy', model: 'glm-5.2', totalTokens: 24 },
    { client: 'WorkBuddy', model: 'deepseek-v4-pro', totalTokens: 12 }
  ]);

  assert.equal(period.clients.codebuddy, 24);
  assert.equal(period.clients.workbuddy, 12);
});

test('normalizeClientName keeps kilo distinct from kilocode and maps Oh My Pi to pi', () => {
  const period = extractUsageFromTokscale([
    { client: 'kilo', model: 'x', totalTokens: 5 },
    { client: 'Oh My Pi', model: 'x', totalTokens: 7 }
  ]);

  assert.equal(period.clients.kilo, 5);
  assert.equal(period.clients.pi, 7);
  assert.ok(!('kilocode' in period.clients));
});

test('extractUsageFromTokscale keeps model usage grouped by client', () => {
  const period = extractUsageFromTokscale([
    { client: 'Hermes', model: 'claude-3-5-sonnet', totalTokens: 100, costUsd: 1.25 },
    { client: 'Codex', model: 'gpt-5', totalTokens: 50, costUsd: 0.25 }
  ]);

  assert.equal(period.models['claude-3-5-sonnet'], 100);
  assert.equal(period.clientModels.hermes['claude-3-5-sonnet'], 100);
  assert.equal(period.clientModelCosts.hermes['claude-3-5-sonnet'], 1.25);
  assert.equal(period.clientModels.codex['gpt-5'], 50);
});

test('extractUsageFromTokscale keeps session usage grouped by client and model', () => {
  const period = extractUsageFromTokscale({
    groupBy: 'client,session,model',
    entries: [
      {
        client: 'Codex',
        sessionId: 'rollout-1',
        model: 'gpt-5',
        provider: 'openai',
        input: 10,
        output: 5,
        cacheRead: 100,
        reasoning: 2,
        messageCount: 3,
        cost: 0.25,
        timestamp: '2026-05-30T04:00:00.000Z'
      },
      {
        client: 'Codex',
        sessionId: 'rollout-1',
        model: 'gpt-4o',
        provider: 'openai',
        input: 2,
        output: 3,
        messageCount: 1,
        cost: 0.05
      },
      {
        client: 'Cursor',
        sessionId: 'cursor-active',
        model: 'auto',
        provider: 'cursor',
        input: 1,
        output: 2,
        cost: 0.01
      }
    ]
  });

  const codex = period.sessions['codex:rollout-1'];
  // reasoning (2) is a subset of output (5), so it is NOT added to the total:
  // entry 1 = 10 + 5 + 100 = 115, entry 2 = 2 + 3 = 5 → 120 (reasoning still tracked separately).
  assert.equal(codex.totalTokens, 120);
  assert.equal(codex.costUsd, 0.3);
  assert.equal(codex.messageCount, 4);
  assert.equal(codex.inputTokens, 12);
  assert.equal(codex.outputTokens, 8);
  assert.equal(codex.cacheReadTokens, 100);
  assert.equal(codex.reasoningTokens, 2);
  assert.equal(codex.lastUsedAt, '2026-05-30T04:00:00.000Z');
  assert.equal(codex.models['gpt-5'], 115);
  assert.equal(codex.models['gpt-4o'], 5);
  assert.equal(codex.providers.openai, 120);
  assert.equal(period.sessions['cursor:cursor-active'].models['cursor-auto'], 3);
});

test('aggregateDevices combines session usage across devices', () => {
  const aggregate = aggregateDevices([
    {
      deviceId: 'one',
      updatedAt: '2026-05-30T00:00:00.000Z',
      receivedAt: '2026-05-30T00:00:00.000Z',
      today: {
        totalTokens: 10,
        costUsd: 0.1,
        clients: { codex: 10 },
        clientCosts: { codex: 0.1 },
        sessions: {
          'codex:s1': {
            client: 'codex',
            sessionId: 's1',
            totalTokens: 10,
            costUsd: 0.1,
            messageCount: 1,
            inputTokens: 4,
            outputTokens: 6,
            models: { 'gpt-5': 10 },
            modelCosts: { 'gpt-5': 0.1 }
          }
        }
      }
    },
    {
      deviceId: 'two',
      updatedAt: '2026-05-30T00:00:00.000Z',
      receivedAt: '2026-05-30T00:00:00.000Z',
      today: {
        totalTokens: 5,
        costUsd: 0.2,
        clients: { codex: 5 },
        clientCosts: { codex: 0.2 },
        sessions: {
          'codex:s1': {
            client: 'codex',
            sessionId: 's1',
            totalTokens: 5,
            costUsd: 0.2,
            messageCount: 2,
            inputTokens: 2,
            outputTokens: 3,
            models: { 'gpt-5': 5 },
            modelCosts: { 'gpt-5': 0.2 }
          }
        }
      }
    }
  ], 0, Date.parse('2026-05-30T00:01:00.000Z'));

  const session = aggregate.periods.today.sessions['codex:s1'];
  assert.equal(session.totalTokens, 15);
  assert.equal(session.costUsd, 0.3);
  assert.equal(session.messageCount, 3);
  assert.equal(session.inputTokens, 6);
  assert.equal(session.outputTokens, 9);
  assert.equal(session.models['gpt-5'], 15);
  assert.equal(session.modelCosts['gpt-5'], 0.3);
});

const { normalizeDeviceRecord, aggregateHistory, carryDeviceHistory } = require('../../src/shared/usage');

test('normalizeDeviceRecord carries a history field when present', () => {
  const rec = normalizeDeviceRecord({
    deviceId: 'm1',
    history: { daily: [{ date: '2026-06-07', tokens: 5 }], monthly: [], summary: { totalTokens: 5 } }
  });
  assert.equal(rec.history.daily[0].tokens, 5);
  const bare = normalizeDeviceRecord({ deviceId: 'm1' });
  assert.equal('history' in bare, false);
});

test('mergeDeviceRecord preserves prior history when the incoming post omits it', () => {
  const existing = normalizeDeviceRecord({
    deviceId: 'm1',
    today: { totalTokens: 1, costUsd: 0, clients: {}, clientCosts: {} },
    history: { daily: [{ date: '2026-06-07', tokens: 5 }], monthly: [], summary: { totalTokens: 5 } }
  });
  const merged = mergeDeviceRecord(existing, { deviceId: 'm1', limitsOnly: true });
  assert.equal(merged.history.daily[0].tokens, 5);
});

test('mergeDeviceRecord clears prior history when incoming history is explicitly null', () => {
  const existing = normalizeDeviceRecord({
    deviceId: 'm1',
    today: { totalTokens: 1, costUsd: 0, clients: {}, clientCosts: {} },
    history: { daily: [{ date: '2026-06-07', tokens: 5 }], monthly: [], summary: { totalTokens: 5 } }
  });
  const merged = mergeDeviceRecord(existing, { deviceId: 'm1', history: null });
  assert.deepEqual(merged.history, { daily: [], monthly: [], summary: {} });
});

test('aggregateHistory merges non-stale devices and skips stale ones', () => {
  const now = Date.parse('2026-06-07T12:00:00.000Z');
  const fresh = {
    deviceId: 'm1', receivedAt: '2026-06-07T11:59:00.000Z',
    history: { daily: [{ date: '2026-06-07', tokens: 10, cost: 1, perClient: { claude: { tokens: 10, cost: 1, messages: 1 } }, perModel: {} }],
      monthly: [{ month: '2026-06', tokens: 10, cost: 1, perClient: { claude: { tokens: 10, cost: 1, messages: 1 } }, perModel: {} }], summary: {} }
  };
  const stale = {
    deviceId: 'm2', receivedAt: '2026-06-01T00:00:00.000Z',
    history: { daily: [{ date: '2026-06-07', tokens: 999, cost: 99, perClient: {}, perModel: {} }],
      monthly: [{ month: '2026-06', tokens: 999, cost: 99, perClient: {}, perModel: {} }], summary: {} }
  };
  const merged = aggregateHistory([fresh, stale], 10 * 60 * 1000, now);
  assert.equal(merged.daily.length, 1);
  assert.equal(merged.daily[0].tokens, 10);     // stale m2 excluded
  assert.equal(merged.summary.totalTokens, 10);
});

test('aggregateHistory tolerates devices without history', () => {
  const merged = aggregateHistory([{ deviceId: 'm1', receivedAt: new Date().toISOString() }], 10 * 60 * 1000);
  assert.deepEqual(merged.daily, []);
});

test('carryDeviceHistory carries prior history forward when the incoming snapshot omits it', () => {
  const previous = {
    deviceId: 'm1', receivedAt: '2026-06-08T00:00:00.000Z',
    history: { daily: [{ date: '2026-06-07', tokens: 5 }], monthly: [], summary: { totalTokens: 5 } }
  };
  const incoming = { deviceId: 'm1', receivedAt: '2026-06-08T00:05:00.000Z', today: { totalTokens: 9 } };
  const next = carryDeviceHistory(previous, incoming);
  assert.equal(next.history.daily[0].tokens, 5);  // carried from the previous snapshot
  assert.equal(next.today.totalTokens, 9);         // incoming fields untouched
  assert.equal(next.receivedAt, '2026-06-08T00:05:00.000Z');
});

test('carryDeviceHistory keeps the incoming history when the tick brings its own', () => {
  const previous = { history: { daily: [{ date: '2026-06-07', tokens: 5 }], monthly: [], summary: {} } };
  const incoming = { history: { daily: [{ date: '2026-06-08', tokens: 7 }], monthly: [], summary: {} } };
  assert.equal(carryDeviceHistory(previous, incoming).history.daily[0].tokens, 7);
});

test('carryDeviceHistory does not resurrect history when the tick clears it with null', () => {
  const previous = { history: { daily: [{ date: '2026-06-07', tokens: 5 }], monthly: [], summary: {} } };
  const incoming = { history: null };
  assert.equal(carryDeviceHistory(previous, incoming).history, null);
});

test('carryDeviceHistory leaves the snapshot untouched when there is no prior history', () => {
  assert.equal('history' in carryDeviceHistory(null, { deviceId: 'm1' }), false);
});

test('a history-less local tick keeps the trends dashboard populated', () => {
  // Reproduces the local-mode regression: the collector attaches history only on
  // interval-gated ticks, so a later history-less tick must not blank the snapshot
  // (the hub gets this for free via mergeDeviceRecord; local mode replaces wholesale).
  const first = {
    deviceId: 'm1', receivedAt: '2026-06-08T00:00:00.000Z',
    history: { daily: [{ date: '2026-06-07', tokens: 5, cost: 1, perClient: {}, perModel: {} }],
      monthly: [{ month: '2026-06', tokens: 5, cost: 1, perClient: {}, perModel: {} }], summary: {} }
  };
  const second = carryDeviceHistory(first, { deviceId: 'm1', receivedAt: '2026-06-08T00:05:00.000Z' });
  const agg = aggregateHistory([second], 0);
  assert.equal(agg.daily.length, 1);
  assert.equal(agg.daily[0].tokens, 5);
});

// A device's today/month snapshot is a wall-clock window. Once it has rolled
// over (the device went offline before re-posting a fresh window) the frozen
// snapshot no longer belongs to "now" and must not pollute the aggregate. The
// device carries periodWindows.{today,month}.endsAt computed in its own local
// time; the hub just checks nowMs < endsAt. allTime is cumulative and never
// expires. See issue #37.
function staleSnapshotDevice(extra = {}) {
  return {
    deviceId: 'mac-mini-office',
    updatedAt: '2026-06-21T05:00:00.000Z',
    receivedAt: '2026-06-21T05:00:00.000Z',
    periodWindows: {
      today: { key: '2026-06-21', endsAt: '2026-06-22T00:00:00.000Z' },
      month: { key: '2026-06', endsAt: '2026-07-01T00:00:00.000Z' }
    },
    today: { totalTokens: 4029210, clients: { codex: 4029210 } },
    month: { totalTokens: 4029210, clients: { codex: 4029210 } },
    allTime: { totalTokens: 4029210, clients: { codex: 4029210 } },
    ...extra
  };
}

test('aggregateDevices drops today usage once a device today window has ended', () => {
  const aggregate = aggregateDevices([staleSnapshotDevice()], 10 * 60 * 1000, Date.parse('2026-06-26T05:00:00.000Z'));
  assert.equal(aggregate.periods.today.totalTokens, 0);
  assert.equal(aggregate.periods.today.clients.codex, undefined);
});

test('aggregateDevices keeps allTime from a device whose today window has ended', () => {
  const aggregate = aggregateDevices([staleSnapshotDevice()], 10 * 60 * 1000, Date.parse('2026-06-26T05:00:00.000Z'));
  assert.equal(aggregate.periods.allTime.totalTokens, 4029210);
});

test('aggregateDevices keeps month while the device month window is still open', () => {
  const aggregate = aggregateDevices([staleSnapshotDevice()], 10 * 60 * 1000, Date.parse('2026-06-26T05:00:00.000Z'));
  assert.equal(aggregate.periods.month.totalTokens, 4029210);
});

test('aggregateDevices drops month once the device month window has ended', () => {
  const device = staleSnapshotDevice({
    updatedAt: '2026-05-30T05:00:00.000Z',
    receivedAt: '2026-05-30T05:00:00.000Z',
    periodWindows: {
      today: { key: '2026-05-30', endsAt: '2026-05-31T00:00:00.000Z' },
      month: { key: '2026-05', endsAt: '2026-06-01T00:00:00.000Z' }
    }
  });
  const aggregate = aggregateDevices([device], 10 * 60 * 1000, Date.parse('2026-06-15T05:00:00.000Z'));
  assert.equal(aggregate.periods.month.totalTokens, 0);
  assert.equal(aggregate.periods.allTime.totalTokens, 4029210);
});

test('aggregateDevices keeps today for an offline-but-same-day device (window not stale flag)', () => {
  const now = Date.parse('2026-06-26T05:00:00.000Z');
  const device = {
    deviceId: 'napping-mac',
    // 20 minutes old: stale by the 10-minute threshold, but today has not rolled over
    updatedAt: '2026-06-26T04:40:00.000Z',
    receivedAt: '2026-06-26T04:40:00.000Z',
    periodWindows: { today: { key: '2026-06-26', endsAt: '2026-06-27T00:00:00.000Z' } },
    today: { totalTokens: 500 }
  };
  const aggregate = aggregateDevices([device], 10 * 60 * 1000, now);
  assert.equal(aggregate.periods.today.totalTokens, 500);
});

test('aggregateDevices keeps today across UTC midnight when device local day is unchanged', () => {
  // UTC+8 device: snapshot at local 06-27 02:00 (UTC 06-26 18:00),
  // now is local 06-27 10:00 (UTC 06-27 02:00) — same local day, different UTC day.
  // A UTC-day comparison would wrongly drop it; the local endsAt keeps it.
  const device = {
    deviceId: 'tw-mac',
    updatedAt: '2026-06-26T18:00:00.000Z',
    receivedAt: '2026-06-26T18:00:00.000Z',
    periodWindows: { today: { key: '2026-06-27', endsAt: '2026-06-27T16:00:00.000Z' } },
    today: { totalTokens: 123 }
  };
  const aggregate = aggregateDevices([device], 10 * 60 * 1000, Date.parse('2026-06-27T02:00:00.000Z'));
  assert.equal(aggregate.periods.today.totalTokens, 123);
});

test('aggregateDevices falls back to UTC-day compare for old agents without periodWindows', () => {
  const dropped = aggregateDevices([{
    deviceId: 'old', updatedAt: '2026-06-21T05:00:00.000Z', receivedAt: '2026-06-21T05:00:00.000Z',
    today: { totalTokens: 99 }, allTime: { totalTokens: 99 }
  }], 10 * 60 * 1000, Date.parse('2026-06-26T05:00:00.000Z'));
  assert.equal(dropped.periods.today.totalTokens, 0);
  assert.equal(dropped.periods.allTime.totalTokens, 99);

  const kept = aggregateDevices([{
    deviceId: 'old2', updatedAt: '2026-06-26T05:00:00.000Z', receivedAt: '2026-06-26T05:00:00.000Z',
    today: { totalTokens: 7 }
  }], 10 * 60 * 1000, Date.parse('2026-06-26T06:00:00.000Z'));
  assert.equal(kept.periods.today.totalTokens, 7);
});
