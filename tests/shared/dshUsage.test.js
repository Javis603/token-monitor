'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildDshHistoryGraph,
  buildDshTokscaleJson,
  collectDshRows,
  collectSessionRows,
  dshNativeZstdAvailable,
  scanZstdFrames
} = require('../../src/shared/dshUsage');
const { resolveDshHome, resolveDshSessionsDir } = require('../../src/shared/dshPaths');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

const YESTERDAY = 1783536000000;
const TODAY = 1783536900000;
const TODAY_START = 1783536450000; // between the two, so the daily split is deterministic

// Three concatenated zstd frames:
//   frame 1: session header + title + assistant message "msg-old" (yesterday)
//   frame 2: assistant usage chunk + assistant message "msg-today" (today)
//   frame 3: replay of "msg-today" with smaller totals (must collapse)
const FIXTURE_B64 = 'KLUv/WAsAcUJADYQMyJAa6sDSGdkRayV/YdSbGWv+yx5Gp1PLBQqWj+ijGWAMAcCKQApACgAmicJKBYKgoFEJtoF7K0OVyKlhJrfiDXNkzKBd2gedduYz5qJ/j20PgKqFTvTWvM0nL90awQRGf1u4La1Ur6cwXPjmtLgLnOGcK8zLERAkgOHFc2x8C1ny7jW0MeCzfJCtixSmNE8782wAVAU8xmknWpuzCqmZqKPTDSIGGNaMPWEM5ZamqebZffGKnTzXDsxKoPVsoACHKjx87uCzna5v4VnASsgMAJCkHN6L0XCyUmNgBrCMyKqDdCsCDLXTidAdQi38ZdpIFo/sYpc0a/BhcFCBiti4EAATtI4CGKApwX4hCmNQTgXNHQBCcM2nMBp7GNMgvLRYP251jZnbqFfa3fR8BirRcIYx1cZAyi1L/1g8QBVBwASTCYgYEmcA01ptEV2rGx/1trIjq5KEOrGFtEaEPA5EgaBUqxFjF84NQhHgjgYVXaq64lWOXStaur26WKIfa7RtY0xf9SDy82+RFrbh8LOSlidIsYYDyupgS4qqYabJDo3ZfagoWtMlcTwaRgS3WkfEr092H8SPXVaTwOgQAAJQAgGDA7rp4EkeoLy0zjT4KIK3VIzY05PdHWJ/hMfAK1moT4KgY/5Bhv/aQlWo3WG4gThh2Qkn09l17FMhBMIMJwrGg5qkBnaBl7YpWkdwQTghgcNW/m0yxrrRVA0ZAxtgAmIYGUMZ0fIUmUotS/9YDAATQYAwkslIFBp2wamGpJIDwm934bp/pcko6oBR1YcMjTfIcnM52YNAE3TIJWKoIkjj+NB/ZaZJpvQr7F3PE3zBKeiYAwojESVm6o6pkUMVXswbetULcW6pqhatpIzh3vLyrpFqm0D4UUtTG/aApjO3OszmJ6d6ngMCCF0QHBAHAwKDMvq40Fg+oLy8VyRZNYloFk2L+Y8pmtb9JkTAEwV34YP8Gc0w+w5aqxP+AYH/xkIVqN1huIE4UcZIvJR8WLRFU54INSWYLWPalVl';

function writeLog(dir, name, base64) {
  fs.writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
  writeLog(root, 'session.jsonl.zstd', FIXTURE_B64);
  return root;
}

function readRows(root, options = {}) {
  return collectDshRows({ roots: [root], ...options });
}

const hasZstd = dshNativeZstdAvailable();

test('DSH zstd runtime support matches the bundled Node version', { skip: !hasZstd }, () => {
  assert.equal(typeof require('node:zlib').zstdDecompressSync, 'function');
});

test('DSH daily window filters messages before per-session aggregation', { skip: !hasZstd }, () => {
  const rows = readRows(fixtureRoot());

  const todayUsage = extractUsageFromTokscale(buildDshTokscaleJson({ todayStart: TODAY_START }, { rows }));
  // Only msg-today (40 input + 3 output + 2 cache read) falls inside the window.
  assert.equal(todayUsage.clients.dsh, 45);
  assert.equal(todayUsage.models['deepseek-v4-flash'], 45);
  assert.equal(todayUsage.cacheReadTokens, 2);
  assert.equal(todayUsage.outputTokens, 3);

  const allTimeUsage = extractUsageFromTokscale(buildDshTokscaleJson({ allTimeSince: 0 }, { rows }));
  // msg-old contributes 100 + 10 + 50 = 160; total = 205.
  assert.equal(allTimeUsage.clients.dsh, 205);
});

test('DSH collapses replays by message id keeping the largest totals', { skip: !hasZstd }, () => {
  const rows = readRows(fixtureRoot());
  const todayRows = rows.filter((row) => row.createdAt >= TODAY_START);
  // msg-today appears twice (40/3/2 and 5/0/0) and collapses to the larger one.
  assert.equal(todayRows.length, 1);
  assert.equal(todayRows[0].input, 40);
  assert.equal(todayRows[0].output, 3);
  assert.equal(todayRows[0].cacheRead, 2);
});

test('DSH counts assistant messages only, ignoring assistant/chunk usage duplicates', { skip: !hasZstd }, () => {
  const rows = readRows(fixtureRoot());
  const total = rows.reduce((sum, row) => sum + row.input + row.output + row.cacheRead, 0);
  // The usage chunk in frame 2 duplicates msg-today and must not be counted.
  assert.equal(total, 205);
  assert.equal(rows.length, 2);
});

test('DSH decodes concatenated zstd frames as one stream', { skip: !hasZstd }, () => {
  const buffer = Buffer.from(FIXTURE_B64, 'base64');
  assert.equal(scanZstdFrames(buffer).length, 3);
  const filePath = path.join(fixtureRoot(), 'session.jsonl.zstd');
  assert.equal(collectSessionRows(filePath).length, 2);
});

test('DSH session header supplies id, timestamps and provider/model attribution', { skip: !hasZstd }, () => {
  const rows = readRows(fixtureRoot());
  const oldRow = rows.find((row) => row.createdAt === YESTERDAY);
  assert.ok(oldRow);
  assert.equal(oldRow.sessionId, 'session-test-0001');
  assert.equal(oldRow.startedAt, YESTERDAY);
  assert.equal(oldRow.model, 'deepseek-v4-flash');
  assert.equal(oldRow.provider, 'opencode-go');

  const todayRow = rows.find((row) => row.createdAt > YESTERDAY);
  assert.ok(todayRow);
  // lastUsedAt is the latest message timestamp in the log (the replay's).
  assert.equal(todayRow.lastUsedAt, TODAY + 1);
});

test('DSH rows carry project identity resolved from the session cwd', { skip: !hasZstd }, () => {
  const rows = readRows(fixtureRoot(), {
    projectIdentity: (cwd) => ({ projectId: 'proj-demo', projectLabel: cwd.split('/').pop() })
  });
  for (const row of rows) {
    assert.equal(row.projectId, 'proj-demo');
    assert.equal(row.projectLabel, 'demo');
  }
  const allTimeUsage = extractUsageFromTokscale(buildDshTokscaleJson({ allTimeSince: 0 }, { rows }));
  const session = Object.values(allTimeUsage.sessions)[0];
  assert.equal(session.projectId, 'proj-demo');
  assert.equal(session.projectLabel, 'demo');
});

test('DSH ignores logs without a session header', { skip: !hasZstd }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
  const { zstdCompressSync } = require('node:zlib');
  const line = JSON.stringify({
    type: 'assistant/message',
    seq: 1,
    time: TODAY,
    data: {
      turn: 1,
      step: 1,
      message: { id: 'm1', source: { kind: 'model', provider: 'opencode-go', model: 'deepseek-v4-pro' } },
      usage: { inputTokens: 10, outputTokens: 1 }
    }
  }) + '\n';
  writeLog(root, 'session.jsonl.zstd', zstdCompressSync(Buffer.from(line)).toString('base64'));
  assert.equal(collectDshRows({ roots: [root] }).length, 0);
});

test('DSH history graph keeps per-day and per-model attribution', { skip: !hasZstd }, () => {
  const rows = readRows(fixtureRoot());
  const graph = buildDshHistoryGraph({ rows });
  const expectedDays = new Set(rows.map((row) => {
    const date = new Date(row.createdAt);
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }));
  assert.equal(graph.contributions.length, expectedDays.size);
  let tokens = 0;
  for (const day of graph.contributions) {
    for (const client of day.clients) {
      assert.equal(client.client, 'dsh');
      assert.equal(client.modelId, 'deepseek-v4-flash');
      tokens += client.tokens.input + client.tokens.output + client.tokens.cacheRead;
    }
  }
  assert.equal(tokens, 205);
});

test('DSH estimated cost uses every populated token category', { skip: !hasZstd }, () => {
  const rows = readRows(fixtureRoot());
  const pricing = {
    'deepseek-v4-flash': {
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000002,
      cacheReadInputTokenCost: 0.0000005,
      cacheCreationInputTokenCost: 0.000003
    }
  };
  const json = buildDshTokscaleJson({ allTimeSince: 0 }, { rows, pricingByModel: pricing });
  const expected = 140 * 0.000001 + 13 * 0.000002 + 52 * 0.0000005;
  assert.ok(Math.abs(json.totalCost - expected) < 1e-12);
});

test('DSH walks nested session directories under the sessions root', { skip: !hasZstd }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  writeLog(nested, 'session.jsonl.zstd', FIXTURE_B64);
  assert.equal(collectDshRows({ roots: [root] }).length, 2);
});

test('resolveDshSessionsDir honors DSH_HOME and defaults to ~/.dsh', () => {
  const windowsHome = resolveDshHome({ env: { DSH_HOME: 'D:\\tools\\dsh' }, platform: 'win32' });
  assert.equal(windowsHome, 'D:\\tools\\dsh');
  assert.equal(resolveDshSessionsDir({ env: { DSH_HOME: 'D:\\tools\\dsh' }, platform: 'win32' }), 'D:\\tools\\dsh\\sessions');

  const posixHome = resolveDshHome({ env: { HOME: '/home/user' }, platform: 'linux' });
  assert.equal(posixHome, '/home/user/.dsh');
  assert.equal(resolveDshSessionsDir({ env: { HOME: '/home/user' }, platform: 'linux' }), '/home/user/.dsh/sessions');

  const winDefault = resolveDshHome({ env: { USERPROFILE: 'C:\\Users\\demo' }, platform: 'win32' });
  assert.equal(winDefault, 'C:\\Users\\demo\\.dsh');
});
