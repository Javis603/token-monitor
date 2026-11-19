'use strict';

// Synthetic, deterministic History V1. No personal usage or credentials.
function summaryForUpload({ days = 151, sessions = 4, tick = 0, changeHistory = false } = {}) {
  const end = Date.parse('2026-11-05T00:00:00Z');
  const daily = Array.from({ length: days }, (_, index) => {
    const tokens = 100000 + index * 997 + (changeHistory && index === days - 1 ? tick : 0);
    return {
      date: new Date(end - (days - 1 - index) * 86400000).toISOString().slice(0, 10),
      tokens, cost: tokens * 0.000002,
      perClient: Object.fromEntries(['claude', 'codex', 'gemini'].map(client => [client, { tokens: Math.floor(tokens / 3), cost: tokens * 0.000002 / 3 }])),
      perModel: Object.fromEntries(Array.from({ length: 8 }, (_, model) => [`model-${model}`, { tokens: Math.floor(tokens / 8), cost: tokens * 0.000002 / 8 }]))
    };
  });
  const period = {
    totalTokens: 200000 + tick, costUsd: (200000 + tick) * 0.000002,
    sessions: Object.fromEntries(Array.from({ length: sessions }, (_, index) => [`codex:s${index}`, {
      client: 'codex', sessionId: `s${index}`, totalTokens: 1000 + index + tick,
      lastUsedAt: new Date(end + tick * 2400).toISOString()
    }]))
  };
  return {
    deviceId: 'bandwidth-fixture', updatedAt: new Date(end + tick * 2400).toISOString(),
    today: period, month: period, allTime: period,
    periodWindows: { today: { key: '2026-11-05' } },
    history: { daily, monthly: [], summary: { totalTokens: daily.reduce((sum, day) => sum + day.tokens, 0) } }
  };
}

module.exports = { summaryForUpload };
