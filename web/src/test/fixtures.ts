import type { HubStats } from '../data/types';

export const statsFixture: HubStats = {
  staleAfterMs: 600_000,
  periods: {
    today: {
      capabilities: { tokenComponents: true },
      totalTokens: 1_530,
      outputTokens: 430,
      cacheReadTokens: 400,
      cacheWriteTokens: 70,
      clients: { codex: 1_000, claude: 530 },
      clientOutputs: { codex: 250, claude: 180 },
      clientCacheReads: { codex: 300, claude: 100 },
      clientCacheWrites: { codex: 50, claude: 20 },
      models: { 'gpt-5': 1_000, 'claude-opus-4-8': 530 },
      modelOutputs: { 'gpt-5': 250, 'claude-opus-4-8': 180 },
      modelCacheReads: { 'gpt-5': 300, 'claude-opus-4-8': 100 },
      modelCacheWrites: { 'gpt-5': 50, 'claude-opus-4-8': 20 },
      sessions: {
        'codex:recent': {
          client: 'codex',
          sessionId: 'recent',
          projectLabel: 'Token Monitor Web',
          totalTokens: 900,
          inputTokens: 600,
          outputTokens: 250,
          lastUsedAt: '2026-08-27T08:00:00.000Z'
        },
        'claude:older': {
          client: 'claude',
          sessionId: 'older',
          totalTokens: 630,
          inputTokens: 400,
          outputTokens: 180,
          lastUsedAt: '2026-08-27T07:00:00.000Z'
        }
      }
    },
    month: {
      capabilities: { tokenComponents: true },
      totalTokens: 2_500_000,
      outputTokens: 600_000,
      clients: { codex: 2_000_000, claude: 500_000 },
      clientOutputs: { codex: 450_000, claude: 150_000 },
      models: { 'gpt-5': 2_000_000, 'claude-opus-4-8': 500_000 },
      sessions: {}
    },
    allTime: {
      capabilities: { tokenComponents: true },
      totalTokens: 42_000_000,
      outputTokens: 9_000_000,
      clients: { codex: 35_000_000, claude: 7_000_000 },
      models: { 'gpt-5': 35_000_000, 'claude-opus-4-8': 7_000_000 },
      sessions: {}
    }
  },
  limits: {
    providers: [
      {
        provider: 'codex',
        accountLabel: 'Team',
        status: 'ok',
        stale: false,
        windows: [
          { kind: 'session', label: '5 小时', usedPercent: 32, remainingPercent: 68, resetsAt: '2026-08-27T10:00:00.000Z' },
          { kind: 'weekly', label: '每周', remainingPercent: 44 }
        ]
      },
      { provider: 'claude', status: 'unauthorized', stale: false, windows: [] }
    ]
  },
  devices: [
    {
      deviceId: 'workstation', hostname: 'workstation', platform: 'linux', osName: 'NixOS', osVersion: '26.05',
      agentRuntime: 'headless-agent', receivedAt: '2026-08-27T08:00:00.000Z', stale: false,
      periods: { today: { totalTokens: 1_000 }, month: { totalTokens: 2_000_000 }, allTime: { totalTokens: 35_000_000 } }
    },
    {
      deviceId: 'laptop', hostname: 'laptop', platform: 'darwin', osName: 'macOS', osVersion: '26.0',
      agentRuntime: 'electron-widget', receivedAt: '2026-08-27T07:00:00.000Z', stale: true,
      periods: { today: { totalTokens: 530 }, month: { totalTokens: 500_000 }, allTime: { totalTokens: 7_000_000 } }
    }
  ]
};
