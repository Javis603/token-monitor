'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MCODE_DESKTOP_SESSIONS_DIR,
  buildMcodeDesktopHistoryGraph,
  buildMcodeDesktopPeriods,
  collectMcodeDesktopRows,
  mcodeDesktopSessionsRoot,
  normalizeMcodeDesktopLine,
  sessionIdForDir,
  walkMessageFiles
} = require('../../src/shared/mcodeDesktopUsage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function writeSession(root, sessionId, lines) {
  const dir = path.join(root, MCODE_DESKTOP_SESSIONS_DIR, '2026', '08', '26', `10-00-00-000-session_${sessionId}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sessionId }));
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`);
  return dir;
}

function assistantMessage({ id, turnId, model = 'MiniMax-M3', input = 0, output = 0, cacheRead = 0, cacheWrite = 0, timestamp = 1787713165942 }) {
  return {
    message_id: `msg-${id}`,
    turn_id: turnId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      api: 'anthropic-messages',
      provider: 'minimax',
      model,
      usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { total: 0 } },
      stopReason: 'toolUse',
      timestamp,
      responseId: `resp-${id}`
    }
  };
}

function userMessage(id) {
  return {
    message_id: `msg-${id}`,
    turn_id: `turn-${id}`,
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  };
}

test('normalizeMcodeDesktopLine reads usage from inside message', () => {
  const row = normalizeMcodeDesktopLine(
    JSON.stringify(assistantMessage({ id: 'a', turnId: 't1', input: 100, output: 20, cacheRead: 300, cacheWrite: 5 })),
    'mvs_abc',
    '/sessions/x/messages.jsonl'
  );
  assert.ok(row);
  assert.equal(row.model, 'MiniMax-M3');
  assert.equal(row.input, 100);
  assert.equal(row.output, 20);
  assert.equal(row.cacheRead, 300);
  assert.equal(row.cacheWrite, 5);
  assert.equal(row.createdAt, 1787713165942);
  assert.equal(row.sessionId, 'mcode:desktop:mvs_abc');
});

test('normalizeMcodeDesktopLine ignores user messages and empty usage', () => {
  assert.equal(normalizeMcodeDesktopLine(JSON.stringify(userMessage('u')), 's', 'f'), null);
  const empty = assistantMessage({ id: 'z', turnId: 't', input: 0, output: 0 });
  assert.equal(normalizeMcodeDesktopLine(JSON.stringify(empty), 's', 'f'), null);
  assert.equal(normalizeMcodeDesktopLine('not json', 's', 'f'), null);
});

test('collectMcodeDesktopRows reads every session transcript and dedupes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-desktop-'));
  const s1 = 'mvs_aaa';
  const s2 = 'mvs_bbb';
  writeSession(root, s1, [
    JSON.stringify(userMessage('u1')),
    JSON.stringify(assistantMessage({ id: 'a1', turnId: 't1', input: 10, output: 1 })),
    JSON.stringify(assistantMessage({ id: 'a2', turnId: 't2', input: 20, output: 2 }))
  ]);
  writeSession(root, s2, [
    JSON.stringify(assistantMessage({ id: 'b1', turnId: 't1', input: 30, output: 3, cacheRead: 4 }))
  ]);
  const rows = collectMcodeDesktopRows({ homeDir: root });
  assert.equal(rows.length, 3);
  const totals = rows.reduce((acc, row) => {
    acc.input += row.input;
    acc.output += row.output;
    acc.cacheRead += row.cacheRead;
    return acc;
  }, { input: 0, output: 0, cacheRead: 0 });
  assert.deepEqual(totals, { input: 60, output: 6, cacheRead: 4 });
  assert.ok(new Set(rows.map((r) => r.sessionId)).has('mcode:desktop:mvs_aaa'));
  assert.ok(new Set(rows.map((r) => r.sessionId)).has('mcode:desktop:mvs_bbb'));
});

test('collectMcodeDesktopRows honors sinceMs for anchored ticks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-desktop-since-'));
  writeSession(root, 'mvs_s', [
    JSON.stringify(assistantMessage({ id: 'old', turnId: 't', input: 10, timestamp: Date.parse('2026-08-25T12:00:00.000Z') })),
    JSON.stringify(assistantMessage({ id: 'new', turnId: 't', input: 20, timestamp: Date.parse('2026-08-26T09:00:00.000Z') }))
  ]);
  const since = Date.parse('2026-08-26T00:00:00.000Z');
  const rows = collectMcodeDesktopRows({ homeDir: root, sinceMs: since });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageId.includes('new'), true);
});

test('buildMcodeDesktopPeriods splits today/month/allTime and merges into mcode client', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-desktop-periods-'));
  // Build every fixture instant from local calendar dates: usage windows are
  // cut at *local* midnight, so UTC-anchored instants land in different local
  // days depending on the runner's offset (the CI timezones job runs the suite
  // at several UTC offsets to catch exactly this).
  const now = new Date(2026, 7, 26, 12, 0, 0); // local 2026-08-26 noon
  writeSession(root, 'mvs_p', [
    JSON.stringify(assistantMessage({ id: 'today', turnId: 't', input: 50, output: 5, timestamp: new Date(2026, 7, 26, 10, 0, 0).getTime() })),
    JSON.stringify(assistantMessage({ id: 'month', turnId: 't', input: 30, output: 3, timestamp: new Date(2026, 7, 3, 10, 0, 0).getTime() })),
    JSON.stringify(assistantMessage({ id: 'older', turnId: 't', input: 10, output: 1, timestamp: new Date(2026, 6, 15, 10, 0, 0).getTime() }))
  ]);
  const rows = collectMcodeDesktopRows({ homeDir: root });
  const json = buildMcodeDesktopPeriods({ now, allTimeSince: '2026-01-01', rows });
  const today = extractUsageFromTokscale(json.today);
  const month = extractUsageFromTokscale(json.month);
  const allTime = extractUsageFromTokscale(json.allTime);
  assert.equal(today.clients.mcode, 55);
  assert.equal(today.sessions['mcode:mcode:desktop:mvs_p'].totalTokens, 55);
  assert.equal(month.clients.mcode, 88);
  assert.equal(allTime.clients.mcode, 99);
});

test('buildMcodeDesktopHistoryGraph groups contributions by local day', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-desktop-graph-'));
  // Local calendar dates again, so the expected day keys are the same local
  // days the graph derives from the instants in any timezone.
  const day1 = new Date(2026, 7, 25, 10, 0, 0);
  const day2 = new Date(2026, 7, 26, 10, 0, 0);
  const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  writeSession(root, 'mvs_g', [
    JSON.stringify(assistantMessage({ id: 'd1', turnId: 't', input: 10, timestamp: day1.getTime() })),
    JSON.stringify(assistantMessage({ id: 'd2', turnId: 't', input: 20, timestamp: day2.getTime() }))
  ]);
  const rows = collectMcodeDesktopRows({ homeDir: root });
  const graph = buildMcodeDesktopHistoryGraph({ rows });
  assert.equal(graph.contributions.length, 2);
  assert.equal(graph.contributions[0].date, localKey(day1));
  assert.equal(graph.contributions[1].date, localKey(day2));
  assert.equal(graph.contributions[0].clients[0].client, 'mcode');
  assert.equal(graph.contributions[0].clients[0].tokens.input, 10);
  assert.equal(graph.contributions[1].clients[0].tokens.input, 20);
});

test('mcodeDesktopSessionsRoot points at the Desktop app store', () => {
  const root = mcodeDesktopSessionsRoot({ homeDir: '/tmp/home' });
  assert.equal(root, path.join('/tmp/home', MCODE_DESKTOP_SESSIONS_DIR));
  assert.equal(path.dirname(path.dirname(root)).endsWith('.minimax'), true);
});

test('sessionIdForDir falls back to a stable derived id when manifest is missing', () => {
  const dir = path.join('/tmp/x', '10-00-00-000-session_mvs_xyz');
  assert.equal(sessionIdForDir(dir), 'mvs_xyz');
});

test('walkMessageFiles stops the whole walk once the byte budget is exceeded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-desktop-budget-'));
  // Three sibling sessions, each ~200 bytes of messages. A cap of 400 must
  // stop at two files even though the third sibling directory is unvisited.
  for (const id of ['a', 'b', 'c']) {
    writeSession(root, `mvs_${id}`, [
      JSON.stringify(assistantMessage({ id: `m${id}`, turnId: 't', input: 10, output: 1 }))
    ]);
  }
  const files = walkMessageFiles(root, { maxBytes: 400 });
  assert.equal(files.length, 2, `expected 2 files under a 400-byte cap, got ${files.length}`);
});

test('collectMcodeDesktopRows reads against the remaining shared budget, not per file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-desktop-shared-budget-'));
  for (const id of ['a', 'b', 'c', 'd']) {
    writeSession(root, `mvs_${id}`, [
      JSON.stringify(assistantMessage({ id: `m${id}`, turnId: 't', input: 10, output: 1 }))
    ]);
  }
  // Small global budget: the collector must not read the full per-file cap for
  // every transcript, so the resulting row count stays well below the 4 rows
  // the store contains.
  const rows = collectMcodeDesktopRows({ homeDir: root, maxBytes: 500 });
  assert.ok(rows.length >= 1 && rows.length < 4, `expected a partial read under a tiny shared budget, got ${rows.length}`);
});
