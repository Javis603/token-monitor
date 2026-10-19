'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  captureDailyHistoryArchive,
  captureLiveDailyHistory,
  graphFromDailyHistoryArchive
} = require('../../src/shared/dailyHistoryArchive');

function graph(date, clients) {
  return { contributions: [{ date, activeTimeMs: 1000, clients }] };
}

function client(clientId, modelId, tokens, cost = 1, messages = 1) {
  return {
    client: clientId,
    modelId,
    tokens: { input: tokens, output: 0 },
    cost,
    messages
  };
}

test('timezone round-trip: current-offset scan replaces inflated cross-offset day and liveDay', () => {
  const modelKey = JSON.stringify(['codex', 'gpt-4o']);

  // Phase 1 (UTC+8 / +480 mins):
  // True usage for 2026-10-10 is 500 tokens.
  let archive = captureDailyHistoryArchive({}, graph('2026-10-10', [
    client('codex', 'gpt-4o', 500, 5, 1)
  ]), { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  archive = captureLiveDailyHistory(archive, {
    clientModels: { codex: { 'gpt-4o': 500 } },
    clientModelCosts: { codex: { 'gpt-4o': 5 } },
    clients: { codex: 500 },
    clientCosts: { codex: 5 },
    totalTokens: 500,
    costUsd: 5
  }, { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  assert.equal(archive.days['2026-10-10'].observations[modelKey].tokens, 500);
  assert.equal(archive.liveDays['2026-10-10'].observations[modelKey].tokens, 500);

  // Phase 2 (Timezone switched to UTC-7 / -420 mins):
  // The scanner rebuckets across shifted midnight, giving inflated 1300 tokens for 2026-10-10.
  archive = captureDailyHistoryArchive(archive, graph('2026-10-10', [
    client('codex', 'gpt-4o', 1300, 13, 2)
  ]), { todayKey: '2026-10-10', utcOffsetMinutes: -420 });

  archive = captureLiveDailyHistory(archive, {
    clientModels: { codex: { 'gpt-4o': 1300 } },
    clientModelCosts: { codex: { 'gpt-4o': 13 } },
    clients: { codex: 1300 },
    clientCosts: { codex: 13 },
    totalTokens: 1300,
    costUsd: 13
  }, { todayKey: '2026-10-10', utcOffsetMinutes: -420 });

  assert.equal(archive.days['2026-10-10'].observations[modelKey].tokens, 1300);
  assert.equal(archive.liveDays['2026-10-10'].observations[modelKey].tokens, 1300);

  // Phase 3 (Timezone restored to UTC+8 / +480 mins):
  // True usage in UTC+8 grew slightly from 500 to 550 tokens.
  archive = captureDailyHistoryArchive(archive, graph('2026-10-10', [
    client('codex', 'gpt-4o', 550, 5.5, 1)
  ]), { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  archive = captureLiveDailyHistory(archive, {
    clientModels: { codex: { 'gpt-4o': 550 } },
    clientModelCosts: { codex: { 'gpt-4o': 5.5 } },
    clients: { codex: 550 },
    clientCosts: { codex: 5.5 },
    totalTokens: 550,
    costUsd: 5.5
  }, { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  // Stamped with active offset (+480), the correct lower count replaces the drifted -420 value.
  assert.equal(archive.days['2026-10-10'].observations[modelKey].tokens, 550);
  assert.equal(archive.liveDays['2026-10-10'].observations[modelKey].tokens, 550);

  const graphOutput = graphFromDailyHistoryArchive([], archive, { todayKey: '2026-10-10', utcOffsetMinutes: 480 });
  const dayRow = graphOutput.contributions.find((c) => c.date === '2026-10-10');
  assert.equal(dayRow.clients[0].tokens.input, 550);
});

test('cross-offset reconciliation replaces active time and purges models absent from authoritative offset', () => {
  const gpt4Key = JSON.stringify(['codex', 'gpt-4o']);
  const sonnetKey = JSON.stringify(['claude', 'sonnet-3.7']);

  // Phase 1 (Offset A / +480): Day has gpt-4o (500 tokens) and claude sonnet-3.7 (200 tokens), activeTimeMs = 5000ms
  let archive = captureDailyHistoryArchive({}, {
    contributions: [{
      date: '2026-10-10',
      activeTimeMs: 5000,
      clients: [
        client('codex', 'gpt-4o', 500, 5, 1),
        client('claude', 'sonnet-3.7', 200, 2, 1)
      ]
    }]
  }, { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  assert.equal(archive.days['2026-10-10'].activeTimeMs, 5000);
  assert.equal(archive.days['2026-10-10'].observations[gpt4Key].tokens, 500);
  assert.equal(archive.days['2026-10-10'].observations[sonnetKey].tokens, 200);

  // Phase 2 (Timezone switched to Offset B / -420):
  // The scanner rebuckets with shifted midnights: activeTimeMs jumps to 15000ms,
  // gpt-4o inflates to 1200 tokens, and an additional model (o3-mini) appears in this shifted day.
  const o3Key = JSON.stringify(['codex', 'o3-mini']);
  archive = captureDailyHistoryArchive(archive, {
    contributions: [{
      date: '2026-10-10',
      activeTimeMs: 15000,
      clients: [
        client('codex', 'gpt-4o', 1200, 12, 3),
        client('codex', 'o3-mini', 400, 4, 1)
      ]
    }]
  }, { todayKey: '2026-10-10', utcOffsetMinutes: -420 });

  assert.equal(archive.days['2026-10-10'].activeTimeMs, 15000);
  assert.equal(archive.days['2026-10-10'].observations[gpt4Key].tokens, 1200);
  assert.equal(archive.days['2026-10-10'].observations[o3Key].tokens, 400);

  // Phase 3 (Timezone returns to Offset A / +480):
  // True usage in UTC+8 for 2026-10-10 only has gpt-4o (600 tokens), activeTimeMs is 6000ms.
  // Neither claude sonnet-3.7 nor o3-mini belong to this day under the authoritative offset.
  archive = captureDailyHistoryArchive(archive, {
    contributions: [{
      date: '2026-10-10',
      activeTimeMs: 6000,
      clients: [
        client('codex', 'gpt-4o', 600, 6, 2)
      ]
    }]
  }, { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  // 1. activeTimeMs must be authoritative 6000ms, NOT inflated 15000ms from Offset B
  assert.equal(archive.days['2026-10-10'].activeTimeMs, 6000);
  // 2. Observations must contain only the models from the authoritative offset (+480)
  assert.equal(archive.days['2026-10-10'].observations[gpt4Key].tokens, 600);
  assert.equal(archive.days['2026-10-10'].observations[o3Key], undefined, 'stale model from offset B must be purged');
  assert.equal(archive.days['2026-10-10'].utcOffsetMinutes, 480);
});

test('cross-offset reconciliation purges dates that shift entirely across midnight within confirmed window', () => {
  const gpt4Key = JSON.stringify(['codex', 'gpt-4o']);

  // Under Offset B (-420 mins), a session near midnight was bucketed into 2026-10-11,
  // while previous sessions were on 2026-10-09.
  let archive = captureDailyHistoryArchive({}, [
    graph('2026-10-09', [client('codex', 'gpt-4o', 300, 3, 1)]),
    graph('2026-10-11', [client('codex', 'gpt-4o', 800, 8, 2)])
  ], { todayKey: '2026-10-11', utcOffsetMinutes: -420 });

  assert.equal(archive.days['2026-10-09'].observations[gpt4Key].tokens, 300);
  assert.equal(archive.days['2026-10-11'].observations[gpt4Key].tokens, 800);
  assert.equal(archive.days['2026-10-10'], undefined);

  // Timezone switches to Offset A (+480 mins):
  // The scanner now rebuckets that midnight session from 2026-10-11 into 2026-10-10!
  // The scan covers confirmed window [2026-10-09, 2026-10-10], meaning 2026-10-11 has NO rows.
  // BUT in this new offset, 2026-10-11 truly has 0 tokens (the usage shifted to 2026-10-10).
  // Also assume an older historical date (2026-09-01) outside the scan window exists with an old offset.
  archive.days['2026-09-01'] = {
    date: '2026-09-01',
    activeTimeMs: 1000,
    utcOffsetMinutes: -420,
    observations: { [gpt4Key]: { client: 'codex', modelId: 'gpt-4o', tokens: 100, cost: 1, messages: 1, utcOffsetMinutes: -420 } }
  };

  archive = captureDailyHistoryArchive(archive, [
    graph('2026-10-09', [client('codex', 'gpt-4o', 300, 3, 1)]),
    graph('2026-10-10', [client('codex', 'gpt-4o', 800, 8, 2)])
  ], { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  // 1. 2026-10-10 is created under Offset A
  assert.equal(archive.days['2026-10-10'].observations[gpt4Key].tokens, 800);
  assert.equal(archive.days['2026-10-10'].utcOffsetMinutes, 480);

  // 2. 2026-09-01 was OUTSIDE the confirmed scan window (which was 2026-10-09..2026-10-10),
  // so it must NOT be touched even if its offset was -420.
  assert.ok(archive.days['2026-09-01'], 'older date outside scan window must be preserved');

  // Now, what if the scan window covers 2026-10-09 to 2026-10-12, but 2026-10-11 is absent from incomingDays?
  archive = captureDailyHistoryArchive(archive, [
    graph('2026-10-09', [client('codex', 'gpt-4o', 300, 3, 1)]),
    graph('2026-10-10', [client('codex', 'gpt-4o', 800, 8, 2)]),
    graph('2026-10-12', [client('codex', 'gpt-4o', 400, 4, 1)])
  ], { todayKey: '2026-10-12', utcOffsetMinutes: 480 });

  // In this scan covering 2026-10-09..2026-10-12, 2026-10-11 is absent from incomingDays
  // and had stale utcOffsetMinutes = -420 from Offset B.
  // It MUST be purged so tokens are not counted on both 2026-10-10 and 2026-10-11!
  assert.equal(archive.days['2026-10-11'], undefined, 'stale cross-offset date absent from scan window must be purged');
});

test('same-offset captures preserve max-wins retention semantics', () => {
  const modelKey = JSON.stringify(['codex', 'gpt-4o']);
  let archive = captureDailyHistoryArchive({}, graph('2026-10-10', [
    client('codex', 'gpt-4o', 500, 5, 1)
  ]), { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  // A lower scan with the SAME offset does not overwrite (protecting against undercounts/transient reads)
  archive = captureDailyHistoryArchive(archive, graph('2026-10-10', [
    client('codex', 'gpt-4o', 400, 4, 1)
  ]), { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  assert.equal(archive.days['2026-10-10'].observations[modelKey].tokens, 500);

  // A higher scan with the SAME offset does overwrite
  archive = captureDailyHistoryArchive(archive, graph('2026-10-10', [
    client('codex', 'gpt-4o', 600, 6, 2)
  ]), { todayKey: '2026-10-10', utcOffsetMinutes: 480 });

  assert.equal(archive.days['2026-10-10'].observations[modelKey].tokens, 600);
});

test('unstamped legacy archives keep legacy max-wins behavior', () => {
  const modelKey = JSON.stringify(['codex', 'gpt-4o']);
  let archive = captureDailyHistoryArchive({}, graph('2026-10-10', [
    client('codex', 'gpt-4o', 500, 5, 1)
  ]), { todayKey: '2026-10-10' });

  // Without offset stamps, max-wins remains preserved
  archive = captureDailyHistoryArchive(archive, graph('2026-10-10', [
    client('codex', 'gpt-4o', 450, 4.5, 1)
  ]), { todayKey: '2026-10-10' });

  assert.equal(archive.days['2026-10-10'].observations[modelKey].tokens, 500);
});
