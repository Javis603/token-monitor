'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hubStatsContentKey, freshnessEvent, applyFreshnessEvent, prepareSseFanout, wantsFreshnessEvents } = require('../../src/shared/hubProtocol');
const { sessionActivityState } = require('../../src/shared/sessionLive');

const first = '2026-10-27T10:00:00.000Z';
const renewed = '2026-10-27T10:00:20.000Z';
function fixture(at = first) {
  const periods = Object.fromEntries(['today', 'month', 'allTime'].map((name) => [name, {
    totalTokens: 42,
    sessions: {
      'codex:a': { client: 'codex', sessionId: 'a', totalTokens: 42, turnEnded: true, lastUsedAt: first,
        liveActivity: { state: 'waiting', observedAt: at } },
      'codex:b': { client: 'codex', sessionId: 'b', totalTokens: 0 }
    },
    projects: { a: { totalTokens: 42 } }
  }]));
  return { updatedAt: first, limits: {}, periods, devices: [{ deviceId: 'a', periods: structuredClone(periods) }] };
}

test('session renewal travels in freshness and reconstructs aggregate and device periods without mutating snapshots', () => {
  const before = fixture();
  const frozenCopy = structuredClone(before);
  const after = fixture(renewed);
  const frame = prepareSseFanout({ stats: after, lastContentKey: hubStatsContentKey(before), hasFreshnessClients: true });
  assert.equal(frame.stats, '');
  assert.match(frame.freshness, /^event: freshness/);
  const event = JSON.parse(frame.freshness.split('data: ')[1]);
  const applied = applyFreshnessEvent(before, event);
  assert.deepEqual(applied.periods, after.periods);
  assert.deepEqual(applied.devices[0].periods, after.devices[0].periods);
  assert.deepEqual(before, frozenCopy);
  assert.equal(applied.periods.today.projects, before.periods.today.projects);
  assert.equal(applied.periods.today.sessions['codex:b'], before.periods.today.sessions['codex:b']);
  assert.equal('sessionActivityObservedAt' in applied.devices[0], false);
  assert.equal(sessionActivityState(applied.periods.today.sessions['codex:a'], Date.parse(first) + 40_000), 'waiting');
  assert.equal(sessionActivityState(applied.periods.today.sessions['codex:a'], Date.parse(first) + 51_000), 'ended');
});

test('state, observation presence, identities and counters remain content changes', () => {
  for (const mutate of [
    row => { row.liveActivity.state = 'running'; },
    row => { row.liveActivity.state = 'unknown'; },
    row => { delete row.liveActivity; },
    row => { delete row.liveActivity.observedAt; },
    row => { row.totalTokens++; },
    row => { row.lastUsedAt = renewed; }
  ]) {
    for (const target of ['aggregate', 'device']) {
      const before = fixture();
      const after = fixture(renewed);
      mutate((target === 'aggregate' ? after : after.devices[0]).periods.today.sessions['codex:a']);
      assert.notEqual(hubStatsContentKey(before), hubStatsContentKey(after));
    }
  }
  const before = fixture();
  const after = fixture(renewed);
  delete after.periods.today.sessions['codex:a'];
  assert.notEqual(hubStatsContentKey(before), hubStatsContentKey(after));
});

test('freshness never creates absent sessions, periods or activity observations', () => {
  const before = fixture();
  const event = freshnessEvent(fixture(renewed));
  delete before.periods.month;
  delete before.periods.today.sessions['codex:a'];
  delete before.devices[0].periods.today.sessions['codex:a'].liveActivity;
  const applied = applyFreshnessEvent(before, event);
  assert.equal(applied.periods.month, undefined);
  assert.equal(applied.periods.today.sessions['codex:a'], undefined);
  assert.equal(applied.devices[0].periods.today.sessions['codex:a'].liveActivity, undefined);
});

test('only stream v3 clients opt into session freshness; v2 retains full snapshots', () => {
  assert.equal(wantsFreshnessEvents({ 'x-token-monitor-stream': '3' }), true);
  assert.equal(wantsFreshnessEvents({ 'x-token-monitor-stream': '2' }), false);
  const before = fixture();
  const after = fixture(renewed);
  const frames = prepareSseFanout({ stats: after, lastContentKey: hubStatsContentKey(before), hasLegacyClients: true, hasFreshnessClients: true });
  assert.deepEqual(JSON.parse(frames.stats.split('data: ')[1]).stats, after);
});

test('device heartbeats cannot renew a session observation', () => {
  const before = fixture();
  const at = '2026-10-27T10:10:00.000Z';
  const applied = applyFreshnessEvent(before, { stats: { updatedAt: at, devices: [{ deviceId: 'a', receivedAt: at }] } });
  assert.equal(applied.periods, before.periods);
  assert.equal(applied.devices[0].periods, before.devices[0].periods);
  assert.equal(sessionActivityState(applied.periods.today.sessions['codex:a'], Date.parse(at)), 'ended');
});

test('aggregate and same-key sessions on different devices receive their own observation clocks', () => {
  const before = fixture();
  before.devices.push({ deviceId: 'b', periods: structuredClone(before.periods) });
  const after = structuredClone(before);
  after.periods.today.sessions['codex:a'].liveActivity.observedAt = renewed;
  after.devices[1].periods.today.sessions['codex:a'].liveActivity.observedAt = renewed;
  const applied = applyFreshnessEvent(before, JSON.parse(JSON.stringify(freshnessEvent(after))));
  assert.deepEqual(applied.periods, after.periods);
  assert.deepEqual(applied.devices, after.devices);
  assert.equal(applied.devices[0].periods, before.devices[0].periods);
});
