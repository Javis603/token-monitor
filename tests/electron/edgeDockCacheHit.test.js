'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const items = require(path.join(rendererDir, 'edgeDock', 'items'));
const presentation = require(path.join(rendererDir, 'edgeDock', 'presentation'));
const fixedPeriodRanges = require(path.join(rendererDir, 'fixedPeriodRanges'));
const { LANGUAGE_OPTIONS, MESSAGES, translate } = require(path.join(rendererDir, 'i18n'));

const HOUR_MS = 60 * 60 * 1000;

function session(client, sessionId, now, overrides = {}) {
  return {
    client,
    sessionId,
    title: sessionId,
    totalTokens: 1000,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
    inputTokens: 100,
    outputTokens: 200,
    lastUsedAt: new Date(now).toISOString(),
    turnEnded: false,
    ...overrides
  };
}

test('cacheHit projects one period total and the running session rows', () => {
  const now = Date.now();
  const sessions = {
    'codex:running-a': session('codex', 'running-a', now),
    'codex:running-b': session('codex', 'running-b', now, {
      totalTokens: 500,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      inputTokens: 400,
      outputTokens: 0
    }),
    'codex:idle': session('codex', 'idle', now, {
      totalTokens: 2000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      inputTokens: 500,
      outputTokens: 500,
      lastUsedAt: new Date(now - 2 * HOUR_MS).toISOString(),
      turnEnded: true
    }),
    'codex:output-only': session('codex', 'output-only', now, {
      totalTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 100,
      turnEnded: true
    }),
    'codex:background': session('codex', 'background', now, {
      sessionKind: 'background-review',
      totalTokens: 400,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 0
    })
  };
  const today = {
    totalTokens: 4000,
    cacheReadTokens: 2100,
    cacheWriteTokens: 100,
    inputTokens: 1000,
    outputTokens: 800,
    unclassifiedTokens: 0,
    capabilities: { tokenComponents: true },
    sessions
  };
  const items = [{ type: 'stat', metric: 'cacheHit' }];
  const [cell] = presentation.buildEdgeDockCells({ periods: { today } }, { items });
  const component = fixedPeriodRanges.tokenComponentBreakdown(today);

  assert.equal(items.length, 1);
  assert.equal(cell.metric, 'cacheHit');
  assert.equal(cell.period, 'today');
  assert.equal(cell.available, true);
  assert.equal(cell.hit, 2100);
  // Cache writes stay on the miss side, matching the Tool detail split.
  assert.equal(cell.miss, 1100);
  assert.ok(Math.abs(cell.rate - 65.625) < 1e-9);
  assert.equal(Math.round(cell.rate), component.hitPct);
  assert.deepEqual(cell.sessions.map((row) => row.key), ['codex:running-a', 'codex:running-b']);
  assert.equal(cell.sessions[0].miss, 200);
  assert.equal(cell.sessions[0].rate, 75);
  assert.equal(cell.sessions[1].miss, 400);
  assert.equal(cell.sessions[1].rate, 20);
  assert.equal(cell.runningCount, 2);
  assert.equal(presentation.runningSessionSummary(cell.sessions).count, 2);
  assert.ok(cell.runningExpiresAt > now);
  for (const row of cell.sessions) {
    assert.equal(row.client, 'codex');
    assert.equal(row.lastUsedAt, new Date(now).toISOString());
    assert.equal(row.turnEnded, false);
    assert.equal(row.archived, false);
    assert.equal(row.deleted, false);
    assert.equal(row.sourceDeleted, false);
  }
});

test('cacheHit falls back to the six most recently active rows when idle', () => {
  const now = Date.now();
  const sessions = {};
  for (let index = 0; index < 7; index += 1) {
    sessions[`codex:${index}`] = session('codex', `idle-${index}`, now, {
      totalTokens: 1000,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      inputTokens: 200,
      outputTokens: 700,
      lastUsedAt: new Date(now - index * HOUR_MS).toISOString(),
      turnEnded: true
    });
  }
  const [cell] = presentation.buildEdgeDockCells({
    periods: {
      today: {
        totalTokens: 7000,
        cacheReadTokens: 700,
        cacheWriteTokens: 0,
        inputTokens: 1400,
        outputTokens: 4900,
        unclassifiedTokens: 0,
        capabilities: { tokenComponents: true },
        sessions
      }
    }
  }, { items: [{ type: 'stat', metric: 'cacheHit' }] });

  assert.equal(cell.sessions.length, 6);
  assert.deepEqual(cell.sessions.map((row) => row.key), [
    'codex:idle-0', 'codex:idle-1', 'codex:idle-2', 'codex:idle-3', 'codex:idle-4', 'codex:idle-5'
  ]);
  assert.equal(presentation.runningSessionSummary(cell.sessions).count, 0);
});

test('cacheHit omits total-only rows when cache telemetry is absent', () => {
  const now = Date.now();
  const [cell] = presentation.buildEdgeDockCells({
    periods: {
      today: {
        totalTokens: 300,
        inputTokens: 0,
        outputTokens: 0,
        unclassifiedTokens: 0,
        sessions: {
          'codex:total-only': {
            client: 'codex',
            sessionId: 'total-only',
            title: 'total-only',
            totalTokens: 300,
            lastUsedAt: new Date(now).toISOString(),
            turnEnded: false
          }
        }
      }
    }
  }, { items: [{ type: 'stat', metric: 'cacheHit' }] });

  assert.equal(cell.available, false);
  assert.equal(cell.rate, null);
  assert.deepEqual(cell.sessions, []);
});

test('cacheHit uses measured session input while the period keeps its own split', () => {
  const now = Date.now();
  const row = {
    client: 'codex',
    sessionId: 'measured-input',
    title: 'measured-input',
    totalTokens: 1000,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
    inputTokens: 100,
    outputTokens: 100,
    lastUsedAt: new Date(now - 2 * HOUR_MS).toISOString(),
    turnEnded: true
  };
  const [cell] = presentation.buildEdgeDockCells({
    periods: {
      today: {
        totalTokens: 1000,
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
        inputTokens: 100,
        outputTokens: 100,
        unclassifiedTokens: 100,
        capabilities: { tokenComponents: true },
        sessions: { 'codex:measured-input': row }
      }
    }
  }, { items: [{ type: 'stat', metric: 'cacheHit' }] });

  assert.ok(Math.abs(cell.rate - 75) < 1e-9);
  assert.equal(cell.sessions[0].miss, 200);
  assert.ok(Math.abs(cell.sessions[0].rate - 75) < 1e-9);
});

test('cacheHit expiry includes idle live observations in the fallback rows', () => {
  const now = Date.now();
  const observedAt = new Date(now).toISOString();
  const row = session('codex', 'idle-observation', now, {
    lastUsedAt: new Date(now - 2 * HOUR_MS).toISOString(),
    turnEnded: true,
    liveActivity: { state: 'idle', observedAt }
  });
  const [cell] = presentation.buildEdgeDockCells({
    periods: {
      today: {
        totalTokens: 1000,
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
        inputTokens: 100,
        outputTokens: 200,
        unclassifiedTokens: 0,
        capabilities: { tokenComponents: true },
        sessions: { 'codex:idle-observation': row }
      }
    }
  }, { items: [{ type: 'stat', metric: 'cacheHit' }] });

  assert.equal(cell.runningCount, 0);
  assert.equal(cell.sessions.length, 1);
  assert.ok(cell.runningExpiresAt > now);
});

test('cacheHit preserves inferred Cursor bot identity', () => {
  const now = Date.now();
  const row = session('cursor', 'sand-subagent-one', now, {
    models: { 'grok-bot-4': 1000 }
  });
  const [cell] = presentation.buildEdgeDockCells({
    periods: {
      today: {
        totalTokens: 1000,
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
        inputTokens: 100,
        outputTokens: 200,
        unclassifiedTokens: 0,
        capabilities: { tokenComponents: true },
        sessions: { 'cursor:sand-subagent-one': row }
      }
    }
  }, { items: [{ type: 'stat', metric: 'cacheHit' }] });

  assert.equal(cell.sessions.length, 1);
  assert.equal(cell.sessions[0].grokBotSession, true);
});

test('cacheHit keeps the uncapped running count and schedules re-projection', () => {
  const now = Date.now();
  const sessions = {};
  for (let index = 0; index < 7; index += 1) {
    sessions[`codex:${index}`] = session('codex', `running-${index}`, now, {
      cacheReadTokens: 600 - index * 10
    });
  }
  const [cell] = presentation.buildEdgeDockCells({
    periods: {
      today: {
        totalTokens: 7000,
        cacheReadTokens: 3990,
        cacheWriteTokens: 700,
        inputTokens: 700,
        outputTokens: 1400,
        unclassifiedTokens: 0,
        capabilities: { tokenComponents: true },
        sessions
      }
    }
  }, { items: [{ type: 'stat', metric: 'cacheHit' }] });

  assert.equal(cell.runningCount, 7);
  assert.equal(cell.sessions.length, 6);
  assert.ok(cell.runningExpiresAt > now);
});

test('cacheHit is registered and localized at every dock surface', () => {
  assert.ok(items.STAT_METRICS.includes('cacheHit'));
  assert.deepEqual(items.normalizeEdgeDockItems([{ type: 'stat', metric: 'cacheHit' }]), [
    { type: 'stat', metric: 'cacheHit' }
  ]);

  const dock = fs.readFileSync(path.join(rendererDir, 'edgeDock', 'dock.js'), 'utf8');
  assert.match(dock, /t\('edgeDock\.cacheHit\.detail', \{/);
  assert.match(dock, /clientLabel\(s\.client\)/);
  assert.doesNotMatch(dock, /function cacheHit(?:Label|ShortLabel)\(/);

  const rateStart = dock.indexOf('function formatCacheHitRate(');
  const rateEnd = dock.indexOf('function cacheHitDetail(', rateStart);
  const formatCacheHitRate = Function('state', `return (${dock.slice(rateStart, rateEnd).trim()})`)({
    locale: 'pt-BR'
  });
  assert.equal(formatCacheHitRate(65.625), '65,6%');
  assert.equal(formatCacheHitRate(0.05), '<0,1%');

  for (const locale of LANGUAGE_OPTIONS.map((option) => option.value).filter((value) => value !== 'auto')) {
    assert.ok(MESSAGES[locale]['edgeDock.period.cacheHit']?.trim(), locale);
    assert.ok(MESSAGES[locale]['edgeDock.periodShort.cacheHit']?.trim(), locale);
    assert.match(MESSAGES[locale]['edgeDock.cacheHit.detail'], /\{hit\}.*\{miss\}/u, locale);
  }
  assert.equal(translate('en', 'edgeDock.cacheHit.detail', { hit: 700, miss: 300 }), 'Hit 700 · Miss 300');
  assert.equal(translate('zh-CN', 'edgeDock.cacheHit.detail', { hit: 700, miss: 300 }), '命中 700 · 未命中 300');
});
