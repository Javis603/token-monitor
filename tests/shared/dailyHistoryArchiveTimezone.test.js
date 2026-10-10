'use strict';

// Fixed UTC+8, matching the other day-boundary tests. The offsets below are
// injected via options.utcOffsetMinutes, so the process clock never moves; only
// the stamp a capture carries does.
process.env.TZ = 'Asia/Shanghai';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  captureDailyHistoryArchive,
  captureLiveDailyHistory,
  graphFromDailyHistoryArchive,
  mergeLiveDaysIntoArchive
} = require('../../src/shared/dailyHistoryArchive');

const BEIJING = -480;   // UTC+8
const CALIFORNIA = 420; // UTC-7 (PDT)

function graph(date, clients, extra = {}) {
  return {
    contributions: [{ date, activeTimeMs: extra.activeTimeMs || 0, clients }],
    ...(extra.timeMetrics ? { timeMetrics: extra.timeMetrics } : {})
  };
}

function client(clientId, modelId, tokens, cost = 0, messages = 1) {
  return {
    client: clientId,
    modelId,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost,
    messages
  };
}

function livePeriod(totalTokens, costUsd = 0) {
  return {
    totalTokens,
    costUsd,
    clients: { claude: totalTokens },
    clientCosts: { claude: costUsd },
    models: { opus: totalTokens },
    modelCosts: { opus: costUsd },
    clientModels: { claude: { opus: totalTokens } },
    clientModelCosts: { claude: { opus: costUsd } }
  };
}

const dayTokens = (archive, tier, date) => Object.values(archive[tier][date].observations)
  .reduce((sum, observation) => sum + observation.tokens, 0);

test('a day bucket re-bucketed by a timezone round-trip does not lock in the inflated value', () => {
  const date = '2026-10-09';
  const todayKey = '2026-10-10';

  // Phase 1 — home timezone: yesterday holds 1000 tokens.
  let archive = captureDailyHistoryArchive({}, graph(date, [client('claude', 'opus', 1000)]), {
    todayKey, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(archive, 'days', date), 1000);

  // Phase 2 — the OS timezone moved to California: tokscale re-buckets the same
  // absolute sessions by California days, so this day key now reports the slice
  // from Beijing 15:00 yesterday through now (800 of yesterday + 500 of today).
  archive = captureDailyHistoryArchive(archive, graph(date, [client('claude', 'opus', 1300)]), {
    todayKey: '2026-10-09', utcOffsetMinutes: CALIFORNIA
  });
  assert.equal(dayTokens(archive, 'days', date), 1300);
  assert.equal(archive.days[date].utcOffsetMinutes, CALIFORNIA);

  // Phase 3 — switched back: the same day key re-buckets to 1000 again. The
  // smaller correct value must replace the drifted one instead of losing to it.
  archive = captureDailyHistoryArchive(archive, graph(date, [client('claude', 'opus', 1000)]), {
    todayKey, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(archive, 'days', date), 1000);
  assert.equal(archive.days[date].utcOffsetMinutes, BEIJING);
});

test('same-offset retention keeps its keep-the-maximum semantics', () => {
  const date = '2026-10-09';
  const todayKey = '2026-10-10';
  let archive = captureDailyHistoryArchive({}, graph(date, [client('claude', 'opus', 1000)]), {
    todayKey, utcOffsetMinutes: BEIJING
  });
  // Late-arriving data grows the day.
  archive = captureDailyHistoryArchive(archive, graph(date, [client('claude', 'opus', 1200)]), {
    todayKey, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(archive, 'days', date), 1200);
  // A scan that sees less (source transcripts removed) does not shrink a
  // same-offset day — the retention maximum is a deliberate feature.
  archive = captureDailyHistoryArchive(archive, graph(date, [client('claude', 'opus', 700)]), {
    todayKey, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(archive, 'days', date), 1200);
});

test('a durable day captured before offset stamping keeps its retention maximum', () => {
  const date = '2026-10-09';
  const todayKey = '2026-10-10';
  const legacy = {
    days: { [date]: { date, observations: [{ client: 'claude', modelId: 'opus', tokens: 1300, cost: 0, messages: 1 }] } }
  };
  const archive = captureDailyHistoryArchive(legacy, graph(date, [client('claude', 'opus', 1000)]), {
    todayKey, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(archive, 'days', date), 1300, 'legacy day buckets keep the retention maximum');
  assert.equal(archive.days[date].utcOffsetMinutes, undefined, 'a legacy day is not restamped until it is replaced');
});

test('the live today overlay heals from a drifted-window maximum after the timezone returns', () => {
  const date = '2026-10-10';

  // Home timezone: today holds 500.
  let archive = captureLiveDailyHistory({}, livePeriod(500), {
    todayKey: date, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(archive, 'liveDays', date), 500);

  // California without a restart (main process keeps stamping the home day key
  // while the subprocess buckets from California midnight): the overlay jumps
  // to a two-calendar-day total.
  archive = captureLiveDailyHistory(archive, livePeriod(1300), {
    todayKey: date, utcOffsetMinutes: CALIFORNIA
  });
  assert.equal(dayTokens(archive, 'liveDays', date), 1300);
  assert.equal(archive.liveDays[date].utcOffsetMinutes, CALIFORNIA);

  // Back home: the correct smaller value replaces the drifted maximum.
  archive = captureLiveDailyHistory(archive, livePeriod(550), {
    todayKey: date, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(archive, 'liveDays', date), 550);
  assert.equal(archive.liveDays[date].utcOffsetMinutes, BEIJING);

  // Growth within the same timezone still max-wins as before.
  archive = captureLiveDailyHistory(archive, livePeriod(600), {
    todayKey: date, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(archive, 'liveDays', date), 600);
});

test('a live overlay written before offset stamping keeps its retention maximum', () => {
  const date = '2026-10-10';
  const legacy = {
    liveDays: { [date]: { date, observations: [{ client: 'claude', modelId: 'opus', tokens: 1300, cost: 0, messages: 1 }] } }
  };
  const archive = captureLiveDailyHistory(legacy, livePeriod(550), {
    todayKey: date, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(archive, 'liveDays', date), 1300, 'unstamped retention semantics are unchanged');
  // Once restamped by a greater same-offset capture, the cross-offset rule
  // applies to it from then on.
  const restamped = captureLiveDailyHistory(archive, livePeriod(1400), {
    todayKey: date, utcOffsetMinutes: BEIJING
  });
  assert.equal(dayTokens(restamped, 'liveDays', date), 1400);
  assert.equal(restamped.liveDays[date].utcOffsetMinutes, BEIJING);
  assert.equal(
    dayTokens(captureLiveDailyHistory(restamped, livePeriod(550), { todayKey: date, utcOffsetMinutes: CALIFORNIA }), 'liveDays', date),
    550,
    'a restamped overlay loses to no drifted window, and a later home-timezone capture replaces it'
  );
});

test('presentation prefers the same-offset value for a day key, whichever tier it lives in', () => {
  const date = '2026-10-10';
  const options = { todayKey: date, utcOffsetMinutes: BEIJING };

  // The reported corruption: a correct day bucket with a drifted live maximum
  // on top used to display the maximum. The current-offset day wins now.
  const healed = graphFromDailyHistoryArchive([], {
    days: { [date]: { date, utcOffsetMinutes: BEIJING, observations: [{ client: 'claude', modelId: 'opus', tokens: 550, cost: 0, messages: 1 }] } },
    liveDays: { [date]: { date, utcOffsetMinutes: CALIFORNIA, observations: [{ client: 'claude', modelId: 'opus', tokens: 1300, cost: 0, messages: 1 }] } }
  }, options);
  assert.equal(
    Object.values(healed.contributions.find(row => row.date === date).clients[0].tokens).reduce((a, b) => a + b, 0),
    550
  );

  // Mirror image: a drifted day bucket must not bury a current-offset overlay.
  const drifted = graphFromDailyHistoryArchive([], {
    days: { [date]: { date, utcOffsetMinutes: CALIFORNIA, observations: [{ client: 'claude', modelId: 'opus', tokens: 1300, cost: 0, messages: 1 }] } },
    liveDays: { [date]: { date, utcOffsetMinutes: BEIJING, observations: [{ client: 'claude', modelId: 'opus', tokens: 550, cost: 0, messages: 1 }] } }
  }, options);
  assert.equal(
    Object.values(drifted.contributions.find(row => row.date === date).clients[0].tokens).reduce((a, b) => a + b, 0),
    550
  );

  // Same offset on both tiers → the greater live value wins, as before.
  const grown = graphFromDailyHistoryArchive([], {
    days: { [date]: { date, utcOffsetMinutes: BEIJING, observations: [{ client: 'claude', modelId: 'opus', tokens: 550, cost: 0, messages: 1 }] } },
    liveDays: { [date]: { date, utcOffsetMinutes: BEIJING, observations: [{ client: 'claude', modelId: 'opus', tokens: 700, cost: 0, messages: 1 }] } }
  }, options);
  assert.equal(
    Object.values(grown.contributions.find(row => row.date === date).clients[0].tokens).reduce((a, b) => a + b, 0),
    700
  );
});

test('mergeLiveDaysIntoArchive replaces a cross-offset overlay and keeps same-offset maxima', () => {
  const date = '2026-10-10';
  let archive = {
    liveDays: { [date]: { date, utcOffsetMinutes: CALIFORNIA, observations: [{ client: 'claude', modelId: 'opus', tokens: 1300, cost: 0, messages: 1 }] } }
  };
  archive = mergeLiveDaysIntoArchive(archive, {
    [date]: { date, utcOffsetMinutes: BEIJING, observations: [{ client: 'claude', modelId: 'opus', tokens: 550, cost: 0, messages: 1 }] }
  });
  assert.equal(dayTokens(archive, 'liveDays', date), 550);

  archive = mergeLiveDaysIntoArchive(archive, {
    [date]: { date, utcOffsetMinutes: BEIJING, observations: [{ client: 'claude', modelId: 'opus', tokens: 600, cost: 0, messages: 1 }] }
  });
  assert.equal(dayTokens(archive, 'liveDays', date), 600);
});
