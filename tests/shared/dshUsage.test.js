'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const {
  DSH_CLIENT,
  buildDshHistoryGraph,
  buildDshPeriods,
  collectDshUsageOnce,
  resetDshFileCache,
  resolveDshSessionsRoot,
  zstdAvailable
} = require('../../src/shared/dshUsage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
}

function writeSession(root, project, sessionId, lines, suffix = 'session.jsonl') {
  const dir = path.join(root, project, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, suffix);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

function assistantEvent(time, usage, model = 'deepseek-v4-flash', provider = 'deepseek-official') {
  return {
    type: 'assistant/message',
    seq: 0,
    time,
    data: {
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'ok' }],
      provenance: { provider, model },
      usage
    }
  };
}

function headerLine(sessionId, createdAt, cwd = '/work/project') {
  return { type: 'session', version: 0, id: sessionId, createdAt, cwd, delegationDepth: 0 };
}

const pricingByModel = {
  'deepseek-v4-flash': {
    inputCostPerToken: 0.0000003,
    outputCostPerToken: 0.000001,
    cacheReadInputTokenCost: 0.0000001,
    cacheCreationInputTokenCost: 0.000001
  }
};

function projectIdentity(cwd) {
  return { projectId: 'sha256:project', projectLabel: path.basename(String(cwd || '')) };
}

test('resolveDshSessionsRoot follows explicit dir, DSH_HOME, then the default', () => {
  const homeDir = '/Users/alice';
  assert.equal(
    resolveDshSessionsRoot({ env: { TOKEN_MONITOR_DSH_SESSIONS_DIR: '/srv/sessions' }, homeDir, cwdDir: '/' }),
    path.resolve('/srv/sessions')
  );
  assert.equal(
    resolveDshSessionsRoot({ env: { DSH_HOME: '/srv/dsh' }, homeDir, cwdDir: '/' }),
    path.join(path.resolve('/srv/dsh'), 'sessions')
  );
  assert.equal(
    resolveDshSessionsRoot({ env: {}, homeDir, cwdDir: '/' }),
    path.join(homeDir, '.dsh', 'sessions')
  );
});

test('collectDshUsageOnce parses raw logs into tokscale-shaped periods', () => {
  const root = tempRoot();
  const createdAt = Date.parse('2026-08-01T00:00:00Z');
  const later = Date.parse('2026-08-15T00:00:00Z');
  writeSession(root, 'proj', 'session-a', [
    JSON.stringify(headerLine('session-a', createdAt)),
    JSON.stringify(assistantEvent(createdAt, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 2, reasoningTokens: 3 })),
    JSON.stringify(assistantEvent(later, { inputTokens: 100, outputTokens: 50, reasoningTokens: 10 }))
  ]);
  resetDshFileCache();
  const collected = collectDshUsageOnce({ roots: [root], now: new Date(later) });
  assert.equal(collected.files, 1);
  assert.deepEqual(collected.errors, []);
  assert.equal(collected.rows.length, 2);

  const periods = buildDshPeriods({
    rows: collected.rows,
    now: new Date(later),
    pricingByModel,
    projectIdentity
  });
  const today = extractUsageFromTokscale(periods.today);
  const allTime = extractUsageFromTokscale(periods.allTime);
  assert.equal(today.totalTokens, 150);
  assert.equal(today.outputTokens, 50);
  assert.equal(today.clients[DSH_CLIENT], 150);
  const todayCost = today.sessions[`${DSH_CLIENT}:session-a`].modelCosts['deepseek-v4-flash'];
  assert.ok(Math.abs(todayCost - 0.00008) < 1e-12, `expected 0.00008, got ${todayCost}`);
  assert.equal(allTime.totalTokens, 187);
  assert.equal(allTime.cacheReadTokens, 20);
  assert.equal(allTime.sessions[`${DSH_CLIENT}:session-a`].projectId, 'sha256:project');
});

test('unknown model prices leave cost at zero without dropping token totals', () => {
  const root = tempRoot();
  const time = Date.now();
  writeSession(root, 'proj', 'session-b', [
    JSON.stringify(headerLine('session-b', time)),
    JSON.stringify(assistantEvent(time, { inputTokens: 10, outputTokens: 5 }, 'custom-model'))
  ]);
  resetDshFileCache();
  const collected = collectDshUsageOnce({ roots: [root], now: new Date(time) });
  const allTime = extractUsageFromTokscale(buildDshPeriods({ rows: collected.rows, now: new Date(time), pricingByModel: {} }).allTime);
  assert.equal(allTime.totalTokens, 15);
  assert.equal(allTime.costUsd, 0);
});

test('packed chunk rows are skipped while assistant/message usage still counts', () => {
  const root = tempRoot();
  const time = Date.now();
  writeSession(root, 'proj', 'session-c', [
    JSON.stringify(headerLine('session-c', time)),
    JSON.stringify({ type: 'text-chunks', seq0: 1, time0: time, data: { turn: 1, step: 1, index: 0, dt: [0, 1], texts: ['ignored', 'chunks'] } }),
    JSON.stringify(assistantEvent(time, { inputTokens: 10, outputTokens: 5 }))
  ]);
  resetDshFileCache();
  const collected = collectDshUsageOnce({ roots: [root], now: new Date(time) });
  assert.equal(collected.rows.length, 1);
  assert.equal(collected.rows[0].total ?? collected.rows[0].input, 10);
});

test('incremental reads pick up appended events without duplicating earlier rows', () => {
  const root = tempRoot();
  const time = Date.now();
  const filePath = writeSession(root, 'proj', 'session-d', [
    JSON.stringify(headerLine('session-d', time)),
    JSON.stringify(assistantEvent(time, { inputTokens: 10, outputTokens: 5 }))
  ]);
  resetDshFileCache();
  const first = collectDshUsageOnce({ roots: [root], now: new Date(time) });
  assert.equal(first.rows.length, 1);
  fs.appendFileSync(filePath, `${JSON.stringify(assistantEvent(time + 1, { inputTokens: 20, outputTokens: 5 }))}\n`);
  const second = collectDshUsageOnce({ roots: [root], now: new Date(time + 1) });
  assert.equal(second.rows.length, 2);
  assert.equal(second.rows.reduce((sum, row) => sum + row.input, 0), 30);
  resetDshFileCache();
});

test('zstd logs are decoded and a torn trailing frame is ignored', { skip: !zstdAvailable() }, () => {
  const root = tempRoot();
  const time = Date.now();
  const lines = [
    JSON.stringify(headerLine('session-z', time)),
    JSON.stringify(assistantEvent(time, { inputTokens: 10, outputTokens: 5 }))
  ];
  const dir = path.join(root, 'proj', 'session-z');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'session.jsonl.zstd');
  const frame = zlib.zstdCompressSync(`${lines.join('\n')}\n`);
  fs.writeFileSync(filePath, frame);
  resetDshFileCache();
  const collected = collectDshUsageOnce({ roots: [root], now: new Date(time) });
  assert.equal(collected.files, 1);
  assert.equal(collected.errors.length, 0);
  assert.equal(collected.rows.length, 1);
  assert.equal(collected.rows[0].input, 10);

  fs.appendFileSync(filePath, zlib.zstdCompressSync(`${JSON.stringify(assistantEvent(time + 1, { inputTokens: 20, outputTokens: 5 }))}\n`).subarray(0, 7));
  const withTorn = collectDshUsageOnce({ roots: [root], now: new Date(time + 1) });
  assert.equal(withTorn.rows.length, 1);
  resetDshFileCache();
});

test('unsupported log versions fail closed without rows', () => {
  const root = tempRoot();
  const time = Date.now();
  writeSession(root, 'proj', 'session-old', [
    JSON.stringify({ type: 'session', version: 99, id: 'session-old', createdAt: time, delegationDepth: 0 }),
    JSON.stringify(assistantEvent(time, { inputTokens: 10, outputTokens: 5 }))
  ]);
  resetDshFileCache();
  const collected = collectDshUsageOnce({ roots: [root], now: new Date(time) });
  assert.equal(collected.rows.length, 0);
  assert.deepEqual(collected.errors, [{ code: 'unsupported-format-version' }]);
  resetDshFileCache();
});

test('usage provenance is read from both the newer provenance block and message.source', () => {
  const root = tempRoot();
  const time = Date.now();
  writeSession(root, 'proj', 'session-source', [
    JSON.stringify(headerLine('session-source', time)),
    JSON.stringify({
      type: 'assistant/message',
      seq: 0,
      time,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          source: { provider: 'opencode-go', model: 'deepseek-v4-pro' }
        },
        usage: { inputTokens: 10, outputTokens: 5 }
      }
    })
  ]);
  resetDshFileCache();
  const collected = collectDshUsageOnce({ roots: [root], now: new Date(time) });
  assert.equal(collected.rows.length, 1);
  assert.equal(collected.rows[0].model, 'deepseek-v4-pro');
  assert.equal(collected.rows[0].provider, 'opencode-go');
  resetDshFileCache();
});

test('dsh history graph merges through the shared history parser', () => {
  const rows = [
    { time: Date.parse('2026-08-13T10:00:00Z'), model: 'deepseek-v4-flash', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2, messages: 1 },
    { time: Date.parse('2026-08-14T10:00:00Z'), model: 'deepseek-v4-flash', input: 20, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 4, messages: 1 }
  ];
  const graph = buildDshHistoryGraph({ rows, pricingByModel });
  assert.equal(graph.contributions.length, 2);
  assert.equal(graph.contributions[0].clients[0].client, DSH_CLIENT);
  assert.equal(graph.contributions[1].clients[0].tokens.input, 20);
});

test('collectDshUsageOnce normalizes every event timestamp to a local day', () => {
  const rows = collectDshUsageOnce({
    roots: [tempRoot()],
    now: new Date('2026-08-15T00:00:00Z')
  });
  assert.deepEqual(rows.rows, []);
});
