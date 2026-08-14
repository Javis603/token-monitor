'use strict';

// DeepSeek Harness (dsh) is parsed locally, like Proma: the collector reads
// session logs under the harness home (`$DSH_HOME` or `~/.dsh`) instead of
// asking tokscale. The logs are append-only JSONL stored as a concatenation of
// independent zstd frames (one per durable write batch), so these tests pin
// the frame scanner, the usage extraction, and the period windowing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const test = require('node:test');

const {
  buildDshPeriods,
  buildDshTokscaleJson,
  collectDshRows,
  collectSessionRows,
  decompressSessionLog,
  estimatedRowCost,
  resetDshRowCache,
  scanZstdFrames
} = require('../../src/shared/dshUsage');
const { normalizeClientName } = require('../../src/shared/usage');

// Build a concatenated-frame zstd log like the harness writes: each batch is
// compressed as its own checksummed frame and appended.
function frame(bytes) {
  return zstdCompressSync(bytes);
}

function sessionLines(nowMs) {
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(nowMs.getFullYear(), nowMs.getMonth(), 1, 0, 0, 0, 0);
  const today = todayStart.getTime();
  const month = monthStart.getTime();
  const older = month - 40 * 24 * 60 * 60 * 1000;
  return [
    { type: 'session', version: 0, id: 'session-a', createdAt: older, cwd: '/work/demo', delegationDepth: 0, agentPreset: 'standard' },
    { type: 'request/header', seq: 0, time: older + 1, data: { header: { config: { provider: 'gw', model: 'deepseek-v4-flash', maxTokens: 384000 } } } },
    { type: 'assistant/message', seq: 1, time: older + 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'old' }], source: { kind: 'model', provider: 'gw', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } } },
    { type: 'assistant/message', seq: 2, time: month + 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'month' }], source: { kind: 'model', provider: 'gw', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 30, outputTokens: 5 } } },
    // Empty-content assistant messages exist only to host usage and still count.
    { type: 'assistant/message', seq: 3, time: today + 1, data: { message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'gw', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 4 } } },
    // Model/provider fall back to the last request/header when the source is absent.
    { type: 'assistant/message', seq: 4, time: today + 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'fallback' }] }, usage: { inputTokens: 11, outputTokens: 2, cacheWriteTokens: 9 } } }
  ].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function writeSessionLog(root, sessionId, lines) {
  const dir = path.join(root, 'sessions', '--work-demo--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const batches = [];
  const all = lines.split('\n').filter(Boolean);
  batches.push(frame(Buffer.from(all.slice(0, 3).join('\n') + '\n')));
  batches.push(frame(Buffer.from(all.slice(3).join('\n') + '\n')));
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), Buffer.concat(batches));
}

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('scanZstdFrames finds every complete frame boundary', () => {
  const one = frame(Buffer.from('line1\n'));
  const two = frame(Buffer.from('line2\n'));
  const buf = Buffer.concat([one, two]);
  const { frames } = scanZstdFrames(buf);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].start, 0);
  assert.equal(frames[0].end, one.length);
  assert.equal(frames[1].start, one.length);
  assert.equal(frames[1].end, buf.length);
  assert.equal(decompressSessionLog(buf), 'line1\nline2\n');
});

test('decompressSessionLog skips a torn final frame', () => {
  const good = frame(Buffer.from('line1\n'));
  const torn = Buffer.concat([good, good.subarray(0, 8)]);
  assert.equal(decompressSessionLog(torn), 'line1\n');
  // A completely unreadable log yields empty output rather than throwing.
  assert.equal(decompressSessionLog(Buffer.from('not zstd at all')), '');
});

test('collectSessionRows extracts usage with model/provider and request-header fallback', () => {
  const now = new Date(2026, 7, 14, 12, 0, 0); // 2026-08-14 local
  const { header, rows } = collectSessionRows(sessionLines(now), { sessionId: 'session-a' });
  assert.equal(header.id, 'session-a');
  assert.equal(header.cwd, '/work/demo');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    sessionId: 'session-a',
    model: 'deepseek-v4-flash',
    provider: 'gw',
    createdAt: (new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime() - 40 * 24 * 60 * 60 * 1000) + 2,
    messages: 1,
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 0
  });
  assert.equal(rows[2].input, 7);
  assert.equal(rows[2].cacheRead, 4);
  // No source on the last message: model/provider come from request/header.
  assert.equal(rows[3].model, 'deepseek-v4-flash');
  assert.equal(rows[3].provider, 'gw');
  assert.equal(rows[3].cacheWrite, 9);
});

test('collectDshRows reads session logs from a custom home and namespaces its ids', (t) => {
  const home = tempHome(t);
  const now = new Date(2026, 7, 14, 12, 0, 0);
  writeSessionLog(home, 'session-a', sessionLines(now));
  const rows = collectDshRows({ roots: [home] });
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.ok(row.sessionId.startsWith('session-a@'), 'non-default homes must namespace session ids');
    assert.equal(row.projectId, 'sha256:' + require('node:crypto').createHash('sha256').update('project\0/work/demo\0').digest('hex'));
    assert.equal(row.projectLabel, 'demo');
  }
});

test('dsh is a fixed point of normalizeClientName', () => {
  assert.equal(normalizeClientName('dsh'), 'dsh');
  assert.equal(normalizeClientName('DeepSeek Harness'), 'dsh');
});

test('buildDshPeriods buckets today, month and allTime by event time', (t) => {
  const home = tempHome(t);
  const now = new Date(2026, 7, 14, 12, 0, 0);
  writeSessionLog(home, 'session-a', sessionLines(now));
  const rows = collectDshRows({ roots: [home] });
  const periods = buildDshPeriods({ now, allTimeSince: 0, rows });

  const today = periods.today;
  assert.equal(today.totalInput, 18);
  assert.equal(today.totalOutput, 5);
  assert.equal(today.totalCacheRead, 4);
  assert.equal(today.totalCacheWrite, 9);
  assert.equal(today.totalMessages, 2);
  assert.equal(today.entries.length, 1);

  const month = periods.month;
  assert.equal(month.totalInput, 48);
  assert.equal(month.totalMessages, 3);

  const allTime = periods.allTime;
  assert.equal(allTime.totalInput, 148);
  assert.equal(allTime.totalMessages, 4);
  assert.equal(allTime.entries[0].projectLabel, 'demo');
  // startedAt is the earliest usage event time, not the session header's createdAt.
  assert.equal(allTime.entries[0].startedAt, new Date(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime() - 40 * 24 * 60 * 60 * 1000 + 2).toISOString());
});

test('estimatedRowCost returns null when pricing is unknown and sums catalog rates otherwise', () => {
  const row = { model: 'deepseek-v4-flash', input: 100, output: 20, cacheRead: 50, cacheWrite: 10 };
  assert.equal(estimatedRowCost(row, {}), null);
  assert.equal(estimatedRowCost(row, null), null);
  const pricing = {
    'deepseek-v4-flash': {
      inputCostPerToken: 0.0001,
      outputCostPerToken: 0.0002,
      cacheReadInputTokenCost: 0.00001,
      cacheCreationInputTokenCost: 0.00005
    }
  };
  const cost = estimatedRowCost(row, pricing);
  assert.ok(cost > 0);
  assert.equal(Math.round(cost * 1e6) / 1e6, 0.015);
});

test('unchanged session files reuse cached rows; touched files re-parse', (t) => {
  const home = tempHome(t);
  const now = new Date(2026, 7, 14, 12, 0, 0);
  writeSessionLog(home, 'session-a', sessionLines(now));
  resetDshRowCache();

  const first = collectDshRows({ roots: [home] });
  assert.equal(first.length, 4);

  // Touch the file with a different mtime: the cache key changes and the file
  // is re-read (still the same content, so the same rows).
  const file = path.join(home, 'sessions', '--work-demo--', 'session-a', 'session.jsonl.zstd');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const second = collectDshRows({ roots: [home] });
  assert.equal(second.length, 4);
  resetDshRowCache();
});

test('buildDshTokscaleJson windows are respected without on-disk data', () => {
  const now = new Date(2026, 7, 14, 12, 0, 0);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const rows = [
    { sessionId: 's1', model: 'm', provider: 'p', createdAt: todayStart + 5, messages: 1, input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }
  ];
  const json = buildDshTokscaleJson({ todayStart }, { rows });
  assert.equal(json.entries.length, 1);
  assert.equal(json.entries[0].client, 'dsh');
  assert.equal(json.totalInput, 3);
});
