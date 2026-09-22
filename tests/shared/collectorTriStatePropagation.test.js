'use strict';

// The derived month/allTime periods of a warm tick come from the last full-scan
// anchor, and the fresh today scan has to be copied onto them. Both facts it
// copies are tri-state and both used to be copied one-way, which let a stale
// reading outlive the tick that disproved it. The dock card reads month first,
// so it was the surface that kept showing what today had already dropped.
//
// The anchor is supplied directly: that is exactly the input startCollector
// hands to collectUsageOnce on every warm tick, so this is the real path rather
// than a reimplementation of it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectUsageOnce } = require('../../src/shared/collector');
const { localDayKey } = require('../../src/shared/history');

const KEY = 'dsh:session-prop';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-tri-state-'));
  const dir = path.join(home, '.dsh', 'sessions', 'proj', 'session-prop');
  fs.mkdirSync(dir, { recursive: true });
  return { home, file: path.join(dir, 'session.jsonl') };
}

function write(file, events) {
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify({ type: e.type, seq: 1, time: 1, data: e.data })).join('\n')}\n`);
}

function options(home, extra = {}) {
  return {
    clients: 'dsh',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 5000,
    deviceId: 'tri-state-test',
    agentVersion: 'test',
    limitsEnabled: false,
    historyEnabled: false,
    homeDir: home,
    runTokscale: async () => ({ entries: [{ client: 'dsh', sessionId: 'session-prop', model: 'deepseek-v4-flash', input: 10, output: 5, cost: 0.001 }] }),
    collectWslUsage: async () => ({ bundle: { today: {}, month: {}, allTime: {} }, detected: [] }),
    ...extra
  };
}

// startCollector builds this from the full scan it just took. todayPartitions is
// what makes the anchor usable, and a warm tick is recognisable by its scan
// flags: --today alone rather than --today/--month/--since.
function anchorFrom(full) {
  return {
    dateKey: localDayKey(new Date()),
    today: full.today,
    month: full.month,
    allTime: full.allTime,
    todayPartitions: { dsh: full.today },
    qoderCnPeriods: null
  };
}

const context200k = [
  { type: 'request/context', data: { contextWindow: 200_000 } },
  { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 189_000, outputTokens: 1_000 } } } }
];

test('a warm tick drops a context reading the fresh scan no longer has', async () => {
  const { home, file } = makeHome();
  try {
    write(file, context200k);
    const full = await collectUsageOnce(options(home));
    assert.equal(full.today.sessions[KEY].contextWindow, 200_000);
    assert.equal(full.today.sessions[KEY].contextTokens, 190_000);

    // The session switches model. The window changes, so the occupancy the old
    // window measured is not a share of the new one, and the fresh scan states
    // no valid pair until the next usage chunk lands.
    write(file, context200k.concat([{ type: 'request/context', data: { contextWindow: 1_000_000 } }]));
    const warm = await collectUsageOnce(options(home, { todayOnlyAnchor: anchorFrom(full) }));

    assert.equal(warm.today.sessions[KEY].contextWindow, 0, 'today drops the pair it can no longer vouch for');
    assert.equal(warm.today.sessions[KEY].contextTokens, 0);
    assert.equal(warm.month.sessions[KEY].contextWindow, 0, 'month must follow today, not keep the dropped pair');
    assert.equal(warm.month.sessions[KEY].contextTokens, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a warm tick carries an open turn through to the derived periods', async () => {
  const { home, file } = makeHome();
  try {
    write(file, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
    ]);
    const full = await collectUsageOnce(options(home));
    assert.equal(full.today.sessions[KEY].turnEnded, true);

    // The next turn starts, so that completion no longer describes the session.
    write(file, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 2 } }
    ]);
    const warm = await collectUsageOnce(options(home, { todayOnlyAnchor: anchorFrom(full) }));

    assert.equal(warm.today.sessions[KEY].turnEnded, false, 'an open turn is a reading, not an absence');
    assert.equal(warm.month.sessions[KEY].turnEnded, false, 'month must not keep the stale completion');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
