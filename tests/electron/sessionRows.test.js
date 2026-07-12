'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { archivedSessionCount, sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');

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

test('session layout keeps page chrome consistent and lets details wrap', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css'), 'utf8');

  assert.doesNotMatch(styles, /\.shell\.session-mode\s*\{[^}]*gap:/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.total-panel/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.total-number/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.cost/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.row-title\s*\{[^}]*white-space:\s*normal;/s);
  assert.match(styles, /\.shell\.session-mode \.row-detail\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
});
