'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { formatTrayText, pickUsageTrayIconId } = require('../../src/electron/tray');

const stats = {
  periods: {
    today: {
      clients: { claude: 10, codex: 25 },
      clientCosts: { claude: 0.5, codex: 0.2 }
    },
    allTime: {
      clients: { claude: 100, codex: 40 },
      clientCosts: { claude: 1, codex: 2 }
    }
  }
};

test('usage tray icon picks the top token client for day and total token modes', () => {
  assert.equal(pickUsageTrayIconId(stats, 'tokens', ['claude', 'codex']), 'codex');
  assert.equal(pickUsageTrayIconId(stats, 'both', ['claude', 'codex']), 'codex');
  assert.equal(pickUsageTrayIconId(stats, 'tokensAll', ['claude', 'codex']), 'claude');
  assert.equal(pickUsageTrayIconId(stats, 'bothAll', ['claude', 'codex']), 'claude');
});

test('usage tray icon picks the top cost client for day and total cost modes', () => {
  assert.equal(pickUsageTrayIconId(stats, 'cost', ['claude', 'codex']), 'claude');
  assert.equal(pickUsageTrayIconId(stats, 'costAll', ['claude', 'codex']), 'codex');
});

test('usage tray icon falls back to token usage when cost breakdown is unavailable', () => {
  assert.equal(
    pickUsageTrayIconId({ periods: { today: { clients: { claude: 3, codex: 9 } } } }, 'cost', ['claude', 'codex']),
    'codex'
  );
});

test('usage tray icon leaves pure icon and bar modes to their existing icon paths', () => {
  assert.equal(pickUsageTrayIconId(stats, 'icon', ['claude', 'codex']), null);
  assert.equal(pickUsageTrayIconId(stats, 'bars', ['claude', 'codex']), null);
  assert.equal(pickUsageTrayIconId(stats, 'barsSession', ['claude', 'codex']), null);
});

test('usage tray icon returns null when the top client has no available icon', () => {
  assert.equal(
    pickUsageTrayIconId({ periods: { today: { clients: { unknown: 20, codex: 10 } } } }, 'tokens', ['codex']),
    null
  );
});

test('tray cost text uses the selected display currency', () => {
  assert.equal(formatTrayText({ periods: { today: { costUsd: 1, totalTokens: 12_000 } } }, 'cost'), '$1.0000');
  assert.equal(formatTrayText({ periods: { today: { costUsd: 1, totalTokens: 12_000 } } }, 'cost', 'TWD'), 'NT$31.50');
  assert.equal(formatTrayText({ periods: { today: { costUsd: 1, totalTokens: 12_000 } } }, 'both', 'HKD'), '12.0K · HK$7.80');
});

const limitStats = {
  limits: {
    providers: [{
      provider: 'claude',
      status: 'ok',
      stale: false,
      windows: [
        { kind: 'session', remainingPercent: 38.2 },
        { kind: 'weekly', remainingPercent: 72.5 }
      ]
    }]
  }
};

test('tray limit modes show the worst remaining percent instead of hiding text', () => {
  assert.equal(formatTrayText(limitStats, 'bars'), '38%');
  assert.equal(formatTrayText(limitStats, 'barsSession'), '38%');
  assert.equal(formatTrayText(limitStats, 'barsWeekly'), '73%');
  assert.equal(formatTrayText(limitStats, 'barsAllSessions'), '38%');
  assert.equal(formatTrayText({ limits: { providers: [] } }, 'bars'), '—');
});

test('barsSession falls back to billing windows when session data is missing', () => {
  const { pickBarPairForTrayMode } = require('../../src/shared/trayText');
  const stats = {
    limits: {
      providers: [{
        provider: 'cursor',
        status: 'ok',
        stale: false,
        windows: [
          { kind: 'billing', label: 'Total', remainingPercent: 46, showMeter: true },
          { kind: 'billing', label: 'API', remainingPercent: 0, showMeter: true }
        ]
      }]
    }
  };
  const pair = pickBarPairForTrayMode(stats, 'barsSession');
  assert.equal(pair.firstWindow.label, 'API');
  assert.equal(pair.secondWindow.label, 'Total');
  assert.equal(formatTrayText(stats, 'barsSession'), '0%');
});

test('barsWeekly uses weekly windows from providers like Antigravity', () => {
  const { pickBarPairForTrayMode } = require('../../src/shared/trayText');
  const stats = {
    limits: {
      providers: [{
        provider: 'antigravity',
        status: 'ok',
        stale: false,
        windows: [
          { kind: 'weekly', label: 'Gemini Pro', remainingPercent: 100, showMeter: true },
          { kind: 'weekly', label: 'Gemini Flash', remainingPercent: 80, showMeter: true }
        ]
      }]
    }
  };
  const pair = pickBarPairForTrayMode(stats, 'barsWeekly');
  assert.equal(pair.firstWindow.label, 'Gemini Flash');
  assert.equal(formatTrayText(stats, 'barsWeekly'), '80%');
});
