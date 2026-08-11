'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { archivedSessionCount, sessionBreakdownIncomplete, sessionIdLabel, sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');

const clientLabels = { claude: 'Claude Code', codex: 'Codex' };
const clientColors = { claude: '#cc7c5e', codex: '#49a3b0', default: '#6ab4f0' };

function localIso(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

test('session rows sort by latest activity and keep subtitles compact', () => {
  const rows = sessionRowsForPeriod({
    sessions: {
      'codex:old': {
        client: 'codex',
        sessionId: 'rollout-2026-05-30T09-47-36-019e76fc-aaaa-bbbb-cccc-111111111111',
        totalTokens: 20548311,
        costUsd: 17.59,
        models: { 'gpt-5.5': 20548311 },
        messageCount: 160,
        lastUsedAt: localIso(2026, 5, 30, 11, 34)
      },
      'claude:newer': {
        client: 'claude',
        sessionId: '214c24d5-aaaa-bbbb-cccc-f87e',
        totalTokens: 21637,
        costUsd: 0.0812,
        models: { 'claude-opus-4-8': 21637 },
        messageCount: 1,
        lastUsedAt: localIso(2026, 5, 30, 12, 7)
      },
      'codex:newest': {
        client: 'codex',
        sessionId: 'rollout-2026-05-30T11-44-50-019e76fc-dddd-eeee-ffff-222222222222',
        totalTokens: 24870232,
        costUsd: 21.91,
        models: { 'gpt-5.5': 24870232 },
        messageCount: 184,
        lastUsedAt: localIso(2026, 5, 30, 12, 25)
      }
    }
  }, {
    clientLabels,
    clientColors,
    now: new Date(2026, 4, 30, 12, 30)
  });

  assert.deepEqual(rows.map((row) => row.key), [
    'session:codex:newest',
    'session:claude:newer',
    'session:codex:old'
  ]);
  assert.equal(rows[0].name, 'Codex · gpt-5.5');
  assert.equal(rows[0].subtitle, '12:25 · 184 msgs');
  assert.equal(rows[0].detail, '019e76fc-dddd-eeee-ffff-222222222222');
  assert.equal(rows[0].kind, 'session');
  assert.equal(rows[1].subtitle, '12:07 · 1 msg');
  assert.equal(rows[1].detail, '214c24d5-aaaa-bbbb-cccc-f87e');
});

test('session rows fall back to month and day for older activity', () => {
  const rows = sessionRowsForPeriod({
    sessions: {
      'claude:older': {
        client: 'claude',
        sessionId: '214c24d5-aaaa-bbbb-cccc-f87e',
        totalTokens: 21637,
        models: { 'claude-opus-4-8': 21637 },
        lastUsedAt: localIso(2026, 5, 29, 23, 8)
      }
    }
  }, {
    clientLabels,
    clientColors,
    now: new Date(2026, 4, 30, 12, 30)
  });

  assert.equal(rows[0].subtitle, '05/29 23:08');
  assert.equal(rows[0].detail, '214c24d5-aaaa-bbbb-cccc-f87e');
});

test('Reasonix native rows reuse the common session schema without a native accordion', () => {
  const rows = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:ABC123': {
        client: 'reasonix',
        sessionId: 'reasonix:ABC123',
        title: '测试一下',
        model: 'deepseek/deepseek-v4-flash',
        projectLabel: 'Qyen',
        totalTokens: 15382,
        promptTokens: 80,
        completionTokens: 30,
        reasoningTokens: 10,
        cacheHitTokens: 20,
        cacheMissTokens: 80,
        requestCount: 4,
        reportedCostUsd: 0.25,
        messageCount: 2,
        turns: 1,
        lastUsedAt: localIso(2026, 8, 8, 14, 10)
      }
    },
    clientLabels: { reasonix: 'Reasonix' },
    clientColors: { reasonix: '#4d6bfe' },
    now: new Date(2026, 7, 8, 14, 30)
  });

  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.kind, 'session');
  assert.equal(row.key, 'session:reasonix:ABC123');
  assert.equal(row.name, 'Reasonix · deepseek/deepseek-v4-flash');
  assert.equal(row.subtitle, '14:10 · 2 msgs');
  assert.equal(row.detail, 'ABC123');
  assert.equal(row.value, 15382);
  assert.equal(row.cost, 0.25);
  assert.equal(row.sessionDetailAvailable, false);
  assert.equal(row.periodTokenDataUnavailable, false);
  assert.equal(row.client, 'reasonix');
  assert.equal(row.sortTime, new Date(localIso(2026, 8, 8, 14, 10)).getTime());
  assert.doesNotMatch(row.name, /测试一下/);
  assert.doesNotMatch(row.subtitle, /Qyen/);
  assert.doesNotMatch(row.detail, /reasonix:/);
  assert.equal(Object.hasOwn(row, 'nativeSessionBreakdown'), false);
  assert.equal(sessionIdLabel('reasonix:ABC123'), 'ABC123');

  const ordinary = sessionRowsForPeriod({
    sessions: {
      'codex:ordinary': {
        client: 'codex',
        sessionId: 'ordinary',
        totalTokens: 10,
        models: { 'gpt-5.6-luna': 10 },
        messageCount: 1,
        lastUsedAt: localIso(2026, 8, 8, 14, 9)
      }
    }
  }, { clientLabels, clientColors, now: new Date(2026, 7, 8, 14, 30) })[0];
  for (const field of ['name', 'subtitle', 'detail', 'value', 'cost', 'client', 'sortTime']) {
    assert.ok(Object.hasOwn(row, field), `Reasonix row is missing ${field}`);
    assert.ok(Object.hasOwn(ordinary, field), `ordinary row is missing ${field}`);
  }
  assert.equal(ordinary.name, 'Codex · gpt-5.6-luna');
  assert.equal(ordinary.subtitle, '14:09 · 1 msg');
});

test('Reasonix native rows omit turns from the compact subtitle when turns are unavailable', () => {
  const [row] = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:no-turns': {
        client: 'reasonix',
        sessionId: 'reasonix:no-turns',
        model: 'deepseek/deepseek-v4-flash',
        totalTokens: 1,
        lastUsedAt: localIso(2026, 8, 8, 14, 10)
      }
    },
    clientLabels: { reasonix: 'Reasonix' },
    now: new Date(2026, 7, 8, 14, 30)
  });

  assert.equal(row.subtitle, '14:10');
  assert.doesNotMatch(row.subtitle, /request|msg|turn/i);
});

test('Reasonix native rows remain visible when official per-session tokens are unavailable', () => {
  const [row] = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:official': {
        client: 'reasonix',
        sessionId: 'reasonix:official',
        model: 'deepseek/deepseek-v4-flash',
        tokenDataUnavailable: true,
        messageCount: 2,
        lastUsedAt: localIso(2026, 8, 8, 14, 10)
      }
    },
    clientLabels: { reasonix: 'Reasonix' },
    now: new Date(2026, 7, 8, 14, 30)
  });

  assert.equal(row.value, 0);
  assert.equal(row.tokenDataUnavailable, true);
  assert.equal(row.periodTokenDataUnavailable, false);
  assert.equal(row.sessionDetailAvailable, false);
  assert.equal(row.subtitle, '14:10 · 2 msgs');
});

test('Reasonix native rows show cumulative totals for an unreliable bounded period', () => {
  const [row] = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:resumed': {
        client: 'reasonix',
        sessionId: 'reasonix:resumed',
        model: 'deepseek-v4-flash',
        totalTokens: 14777,
        reportedCostUsd: 0.00402028,
        periodTokenDataUnavailable: true,
        messageCount: 5,
        lastUsedAt: localIso(2026, 8, 9, 11, 46)
      }
    },
    clientLabels: { reasonix: 'Reasonix' },
    now: new Date(2026, 7, 9, 12, 0)
  });

  assert.equal(row.value, 14777);
  assert.equal(row.cost, 0.00402028);
  assert.equal(row.tokenDataUnavailable, false);
  assert.equal(row.periodTokenDataUnavailable, true);
});

test('Reasonix native rows hide legacy stats paths while keeping the compact message parameter', () => {
  const leakedPath = 'REASONIX:reasonix-stats:/Users/sunricardo/.reasonix/stats/2026-08-09.jsonl';
  const [row] = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:legacy-path': {
        client: 'reasonix',
        sessionId: leakedPath,
        model: 'deepseek-v4-flash',
        totalTokens: 123,
        messageCount: 6
      }
    },
    clientLabels: { reasonix: 'Reasonix' }
  });

  assert.equal(row.subtitle, '6 msgs');
  assert.equal(row.detail, '');
  assert.doesNotMatch(row.title, /reasonix-stats|\/Users\//i);
  assert.equal(sessionIdLabel(leakedPath), '');
});

test('session rows label archived sessions without claiming the source was deleted', () => {
  const rows = sessionRowsForPeriod({
    sessions: {
      'opencode:deleted': {
        client: 'opencode',
        sessionId: 'deleted',
        totalTokens: 1200,
        models: { 'gpt-5': 1200 },
        messageCount: 3,
        lastUsedAt: localIso(2026, 5, 30, 12, 7),
        archived: true
      }
    }
  }, {
    clientLabels: { opencode: 'OpenCode' },
    now: new Date(2026, 4, 30, 12, 30),
    archivedLabel: 'Archived'
  });

  assert.equal(rows[0].archived, true);
  assert.equal(rows[0].subtitle, 'Archived · 12:07 · 3 msgs');
  assert.equal(rows[0].title, 'OpenCode session deleted');
});

test('archived session count deduplicates retained sessions across periods', () => {
  assert.equal(archivedSessionCount({
    periods: {
      today: { sessions: {
        'claude:archived': { client: 'claude', sessionId: 'archived', archived: true },
        'claude:live': { client: 'claude', sessionId: 'live' }
      } },
      month: { sessions: {
        'claude:archived': { client: 'claude', sessionId: 'archived', archived: true },
        'codex:archived': { client: 'codex', sessionId: 'archived', archived: true }
      } },
      allTime: { sessions: {} }
    }
  }), 2);
  assert.equal(archivedSessionCount(null), 0);
});

test('session breakdown marks only periods affected by bounded sync detail', () => {
  const stats = { sessionDetailsOmitted: { today: 2, month: 7 } };
  assert.equal(sessionBreakdownIncomplete(stats, 'today'), true);
  assert.equal(sessionBreakdownIncomplete(stats, 'month'), true);
  assert.equal(sessionBreakdownIncomplete(stats, 'allTime'), false);
  assert.equal(sessionBreakdownIncomplete({ sessionDetailsOmitted: { today: 2 } }, 'allTime'), false);
  assert.equal(sessionBreakdownIncomplete({}, 'month'), false);
});

test('session layout keeps page chrome consistent and lets details wrap', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css'), 'utf8');

  assert.doesNotMatch(styles, /\.shell\.session-mode\s*\{[^}]*gap:/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.total-panel/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.total-number/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.cost/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.row-title\s*\{[^}]*white-space:\s*normal;/s);
  assert.match(styles, /\.shell\.session-mode \.row-detail\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
});
