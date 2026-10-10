'use strict';

// A warm tick derives month/allTime from the last full-scan anchor and copies
// the fresh today scan's facts onto them. Parent links are resolved per period
// by tokscale, so a derived period may legitimately name a different parent
// rollout than today does; only a link whose parent no longer has usage in that
// period is repaired from the fresh scan.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectUsageOnce } = require('../../src/shared/collector');
const { localDayKey } = require('../../src/shared/history');

const FIRST = 'rollout-2026-10-01T10-00-00-thread';
const CONTINUATION = 'rollout-2026-10-11T09-00-00-thread_1';
const CHILD = 'rollout-2026-10-11T09-30-00-child';

function entry(sessionId, input) {
  return { client: 'codex', sessionId, model: 'gpt-5.6-sol', input, output: 1, cost: 0.01 };
}

function scan(entries, parentSessionId) {
  return {
    groupBy: 'client,workspace,session,model',
    entries,
    sessions: entries.map(({ sessionId }) => ({
      client: 'codex', sessionId, ...(sessionId === CHILD ? { parentSessionId } : {})
    }))
  };
}

function options(home, scans, extra = {}) {
  return {
    clients: 'codex',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 5000,
    deviceId: 'parent-link-test',
    agentVersion: 'test',
    limitsEnabled: false,
    historyEnabled: false,
    homeDir: home,
    runTokscale: async ({ flags }) => (flags.includes('--today') ? scans.today : scans.month),
    collectWslUsage: async () => ({ bundle: { today: {}, month: {}, allTime: {} }, detected: [] }),
    ...extra
  };
}

function anchorFrom(full) {
  return {
    dateKey: localDayKey(new Date()),
    today: full.today,
    month: full.month,
    allTime: full.allTime,
    todayPartitions: { codex: full.today }
  };
}

async function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-parent-links-'));
  try { await run(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('a warm tick repairs a derived parent link whose parent rollout lost its usage', () => withHome(async (home) => {
  // The parent's first rollout was written only today, so the derived month
  // holds it only through today's share.
  const before = scan([entry(FIRST, 10), entry(CONTINUATION, 5), entry(CHILD, 3)], FIRST);
  const full = await collectUsageOnce(options(home, { today: before, month: before }));
  assert.equal(full.month.sessions[`codex:${CHILD}`].parentSessionId, FIRST);

  // The first rollout is deleted; tokscale now resolves the parent to its
  // earliest surviving continuation.
  const after = scan([entry(CONTINUATION, 5), entry(CHILD, 3)], CONTINUATION);
  const warm = await collectUsageOnce(options(home, { today: after, month: after },
    { todayOnlyAnchor: anchorFrom(full) }));

  assert.equal(warm.today.sessions[`codex:${CHILD}`].parentSessionId, CONTINUATION);
  assert.equal(Number(warm.month.sessions[`codex:${FIRST}`]?.totalTokens || 0), 0, 'the deleted rollout has no month usage left');
  assert.equal(warm.month.sessions[`codex:${CHILD}`].parentSessionId, CONTINUATION,
    'the derived month follows the fresh link instead of keeping an unresolvable parent');
  assert.equal(warm.allTime.sessions[`codex:${CHILD}`].parentSessionId, CONTINUATION);
}));

test('a warm tick keeps a derived parent link the period can still resolve', () => withHome(async (home) => {
  // The parent's first rollout has only earlier usage: the today scan resolves
  // the child to the continuation, while the month scan still keeps the first.
  const today = scan([entry(CONTINUATION, 5), entry(CHILD, 3)], CONTINUATION);
  const month = scan([entry(FIRST, 50), entry(CONTINUATION, 5), entry(CHILD, 3)], FIRST);
  const full = await collectUsageOnce(options(home, { today, month }));
  assert.equal(full.today.sessions[`codex:${CHILD}`].parentSessionId, CONTINUATION);
  assert.equal(full.month.sessions[`codex:${CHILD}`].parentSessionId, FIRST);

  const warm = await collectUsageOnce(options(home, { today, month }, { todayOnlyAnchor: anchorFrom(full) }));

  assert.equal(warm.today.sessions[`codex:${CHILD}`].parentSessionId, CONTINUATION);
  assert.equal(warm.month.sessions[`codex:${CHILD}`].parentSessionId, FIRST,
    'a parent the month still holds is kept rather than overwritten by today');
  assert.equal(warm.allTime.sessions[`codex:${CHILD}`].parentSessionId, FIRST);
  assert.equal(warm.month.sessions[`codex:${FIRST}`].totalTokens, 51);
}));
