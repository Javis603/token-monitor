'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  GCMP_SOURCE_CHECK_ID,
  buildGcmpHistoryGraph,
  buildGcmpPeriods,
  collectGcmpRows,
  gcmpUsagesRoots,
  normalizeUsageLine
} = require('../../src/shared/providers/gcmp/usage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function writeHourFile(root, dateKey, hour, lines) {
  const dir = path.join(root, dateKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${hour}.jsonl`), lines.join('\n') + '\n');
}

const COMPLETED = {
  requestId: 'req-1',
  timestamp: Date.parse('2026-09-22T01:27:07.087Z'),
  providerKey: 'opencode',
  providerName: 'OpenCode',
  modelId: 'gcmp.opencode:::glm-5.3-flash-go',
  modelName: 'GLM-5.3-Flash (Go)',
  rawUsage: {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 800 },
    completion_tokens_details: { reasoning_tokens: 50 }
  },
  status: 'completed',
  sessionId: 'session-a',
  estimatedCost: 0.005526,
  costBreakdown: { total: 0.005526 }
};

test('estimated stub lines are never counted; only completed rawUsage is', () => {
  assert.equal(normalizeUsageLine(JSON.stringify({
    requestId: 'req-1',
    timestamp: 1,
    estimatedInput: 1000,
    rawUsage: null,
    status: 'estimated'
  }), 's'), null);
  assert.equal(normalizeUsageLine('{"status":"completed"}', 's'), null);
  assert.equal(normalizeUsageLine('not json', 's'), null);
});

test('a completed record becomes a row with cached, reasoning and cost values', () => {
  const row = normalizeUsageLine(JSON.stringify(COMPLETED), 'abc123');
  assert.ok(row);
  assert.equal(row.requestId, 'req-1');
  assert.equal(row.model, 'GLM-5.3-Flash (Go)');
  assert.equal(row.input, 1000);
  assert.equal(row.output, 200);
  assert.equal(row.cacheRead, 800);
  assert.equal(row.reasoning, 50);
  assert.equal(row.cost, 0.005526);
  assert.equal(row.sessionId, 'session-a@abc123');
});

test('the gcmp namespace prefix is stripped when only the model id is present', () => {
  const row = normalizeUsageLine(JSON.stringify({
    ...COMPLETED,
    modelName: undefined,
    rawUsage: { prompt_tokens: 10, completion_tokens: 5 }
  }), 's');
  assert.equal(row.model, 'glm-5.3-flash-go');
});

test('collectGcmpRows dedupes repeated requestIds within a root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcmp-usage-'));
  const usages = path.join(root, 'usages');
  writeHourFile(usages, '2026-09-22', '09', [JSON.stringify(COMPLETED), JSON.stringify(COMPLETED)]);
  writeHourFile(usages, '2026-09-22', '10', [JSON.stringify({
    ...COMPLETED,
    requestId: 'req-2',
    estimatedCost: 0,
    rawUsage: { prompt_tokens: 10, completion_tokens: 5 }
  })]);
  const rows = collectGcmpRows({ roots: [usages] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.requestId).sort(), ['req-1', 'req-2']);
  const json = buildGcmpPeriods({
    rows,
    now: new Date(2026, 8, 22, 9),
    allTimeSince: 0
  });
  // The rows carry Sep 22 01:27 UTC, whose local date depends on the machine's
  // timezone, so compare against the allTime window which includes both.
  const allTime = extractUsageFromTokscale(json.allTime);
  assert.equal(allTime.totalTokens, 2015);
  assert.equal(allTime.clients.gcmp, 2015);
  assert.equal(allTime.costUsd, 0.005526);
});

test('buildGcmpPeriods cuts today and month at local boundaries', () => {
  const now = new Date(2026, 8, 22, 9, 0, 0); // local Sep 22, 09:00
  const todayRow = { sessionId: 's1@r', model: 'GLM', input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.01, createdAt: now.getTime() };
  const monthStart = new Date(2026, 8, 1, 0, 0, 0).getTime();
  const lastMonth = { ...todayRow, createdAt: monthStart - 1000 };
  const rows = [todayRow, lastMonth];
  const periods = buildGcmpPeriods({ rows, now, allTimeSince: monthStart - 60_000 });
  assert.equal(extractUsageFromTokscale(periods.today).totalTokens, 110);
  assert.equal(extractUsageFromTokscale(periods.month).totalTokens, 110);
  assert.equal(extractUsageFromTokscale(periods.allTime).totalTokens, 220);
});

test('undated rows count only for allTime, mirroring the proma rule', () => {
  const undated = { sessionId: 's@r', model: 'GLM', input: 5, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, createdAt: 0 };
  const periods = buildGcmpPeriods({ rows: [undated], now: new Date(2026, 8, 22, 9), allTimeSince: 0 });
  assert.equal(extractUsageFromTokscale(periods.today).totalTokens, 0);
  assert.equal(extractUsageFromTokscale(periods.month).totalTokens, 0);
  assert.equal(extractUsageFromTokscale(periods.allTime).totalTokens, 5);
});

test('history graph attributes rows to their local date and model', () => {
  const day = Date.parse('2026-09-22T12:00:00.000Z');
  const rows = [
    { sessionId: 'a@r', model: 'GLM', input: 10, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.1, createdAt: day },
    { sessionId: 'b@r', model: 'GLM', input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.2, createdAt: day }
  ];
  const graph = buildGcmpHistoryGraph({ rows });
  assert.equal(graph.contributions.length, 1);
  assert.equal(graph.contributions[0].clients.length, 1);
  const client = graph.contributions[0].clients[0];
  assert.equal(client.client, 'gcmp');
  assert.equal(client.tokens.input, 15);
  assert.equal(client.messages, 2);
  assert.ok(Math.abs(client.cost - 0.3) < 1e-9);
});

test('a sinceMs anchored to local midnight skips earlier date directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcmp-since-'));
  const usages = path.join(root, 'usages');
  writeHourFile(usages, '2026-09-21', '23', [JSON.stringify({ ...COMPLETED, requestId: 'old' })]);
  writeHourFile(usages, '2026-09-22', '00', [JSON.stringify({ ...COMPLETED, requestId: 'new' })]);
  const midnight = new Date(2026, 8, 22, 0, 0, 0).getTime();
  const rows = collectGcmpRows({ roots: [usages], sinceMs: midnight });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, 'new');
});

test('roots resolve per platform with remote-server variants included', () => {
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', XDG_CONFIG_HOME: '' };
  assert.deepEqual(gcmpUsagesRoots({ homeDir: '/h', platform: 'darwin', env }), [
    '/h/Library/Application Support/Code/User/globalStorage/vicanent.gcmp/usages',
    '/h/Library/Application Support/Code - Insiders/User/globalStorage/vicanent.gcmp/usages',
    '/h/.vscode-server/data/User/globalStorage/vicanent.gcmp/usages',
    '/h/.vscode-server-insiders/data/User/globalStorage/vicanent.gcmp/usages'
  ]);
  const linuxRoots = gcmpUsagesRoots({ homeDir: '/h', platform: 'linux', env });
  assert.ok(linuxRoots.some((dir) => dir === '/h/.config/Code/User/globalStorage/vicanent.gcmp/usages'));
  const winRoots = gcmpUsagesRoots({ homeDir: 'C:\\Users\\u', platform: 'win32', env });
  // path.join follows the host platform, so on POSIX the APPDATA prefix keeps
  // its backslashes while the appended segments use forward slashes.
  assert.ok(winRoots.some((dir) => dir.startsWith('C:\\Users\\u\\AppData\\Roaming') && dir.includes('vicanent.gcmp')));
  assert.equal(GCMP_SOURCE_CHECK_ID, 'gcmp-usages');
});
