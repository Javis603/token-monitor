'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateDevices, aggregateHistory, normalizeDeviceRecord, normalizePeriod, mergeDeviceRecord, mergePeriods } = require('../../src/shared/usage');
const { normalizeUsageIdentity, packUsageIdentity } = require('../../src/shared/usageIdentity');
const workerUsage = require('../../worker/src/shared/usage');
const workerIdentity = require('../../worker/src/shared/usageIdentity');
const { normalizeHistory, parseGraphResult } = require('../../src/shared/history');
const { syncPayload, serializeSyncPayload } = require('../../src/shared/syncPayload');

const NOW = '2026-10-13T02:00:00.000Z';
const id = number => `sha256:${number.toString(16).padStart(64, '0')}`;
function usage(tokens, { model = 'claude-sonnet-4-5', cost = tokens / 1000000, sid = 'session-a', project = 'repo', timed = true } = {}) {
  return normalizePeriod({
    totalTokens: tokens, costUsd: cost, cacheReadTokens: tokens / 2, cacheWriteTokens: 0, outputTokens: tokens / 10,
    capabilities: { tokenComponents: true, throughput: true },
    timedTokens: timed ? tokens : 0, timedOutputTokens: timed ? tokens / 10 : 0, timedDurationMs: timed ? tokens : 0,
    modelThroughput: timed ? { [model]: { timedTokens: tokens, timedOutputTokens: tokens / 10, timedDurationMs: tokens } } : {},
    clients: { claude: tokens }, clientCosts: { claude: cost }, clientCacheReads: { claude: tokens / 2 }, clientOutputs: { claude: tokens / 10 },
    models: { [model]: tokens }, modelCosts: { [model]: cost }, modelCacheReads: { [model]: tokens / 2 }, modelOutputs: { [model]: tokens / 10 },
    clientModels: { claude: { [model]: tokens } }, clientModelCosts: { claude: { [model]: cost } },
    sessions: { [`claude:${sid}`]: { client: 'claude', sessionId: sid, projectId: project, projectLabel: project,
      totalTokens: tokens, costUsd: cost, messageCount: 1, cacheReadTokens: tokens / 2, outputTokens: tokens / 10,
      timedOutputTokens: timed ? tokens / 10 : 0, timedDurationMs: timed ? tokens : 0, models: { [model]: tokens }, modelCosts: { [model]: cost }, providers: { anthropic: tokens } } },
    projects: { [project]: { tokens, costUsd: cost, clients: { claude: tokens } } }
  });
}
function historyDay(tokens, date = '2026-10-13') {
  return parseGraphResult({ contributions: [{ date, clients: [{ client: 'claude', modelId: 'claude-sonnet-4-5',
    tokens: { input: tokens * 0.4, output: tokens * 0.1, cacheRead: tokens * 0.5, cacheWrite: 0 }, cost: tokens / 1000000, messages: 1 }] }] }).contributions[0];
}
function device(name, events, kind = 'native') {
  const period = mergePeriods(...events.map(event => event.usage));
  return { deviceId: name, hostname: name, updatedAt: NOW, receivedAt: NOW,
    today: period, month: period, allTime: period,
    periodWindows: { today: { key: '2026-10-13', endsAt: '2026-10-14T00:00:00.000Z' }, month: { key: '2026-10', endsAt: '2026-11-01T00:00:00.000Z' } },
    usageIdentity: { version: 1, eventIdentityVersion: 2, periods: Object.fromEntries(['today', 'month', 'allTime'].map(name => [name,
      { capturedAt: NOW, events: events.map(event => ({ ...event, observationKind: kind, sessionId: 'session-a' })) }])) } };
}

test('root timing proof remains idempotent when accepted optional model throughput is unavailable', () => {
  const host = device('host', [{ id: id(1), usage: usage(100) }], 'mirror');
  const peer = device('peer', [{ id: id(1), usage: usage(100) }]);
  for (const name of ['today', 'month', 'allTime']) {
    delete host[name].modelThroughput;
    host[name].capabilities.throughput = false;
  }
  for (const evidence of [host.usageIdentity, structuredClone(host.usageIdentity)]) {
    if (evidence !== host.usageIdentity) for (const period of Object.values(evidence.periods)) {
      for (const event of period.events) delete event.usage.modelThroughput;
    }
    for (const identity of [require('../../src/shared/usageIdentity'), workerIdentity]) {
      const once = identity.normalizeUsageIdentity(evidence, host);
      const twice = identity.normalizeUsageIdentity(once, host);
      assert.deepEqual(twice, once);
      assert.ok(twice.periods.today);
      const packed = identity.packUsageIdentity(twice);
      assert.ok(packed);
      const restored = identity.normalizeUsageIdentity(packed, host);
      assert.deepEqual(identity.normalizeUsageIdentity(restored, host), restored);
      for (const name of ['today', 'month', 'allTime']) {
        assert.equal(restored.periods[name].events[0].usage.timedTokens, 100);
        assert.equal(restored.periods[name].events[0].usage.timedOutputTokens, 10);
      }
      const repacked = identity.packUsageIdentity(restored);
      assert.deepEqual(repacked, packed);
      for (const hub of [require('../../src/shared/usage'), workerUsage]) {
        const record = hub.normalizeDeviceRecord({ ...host, usageIdentity: repacked });
        assert.equal(record.periods.today.modelThroughput, undefined);
        assert.equal(record.periods.today.capabilities.throughput, false);
        assert.equal(hub.aggregateDevices([syncPayload({ ...host, usageIdentity: twice }), syncPayload(peer)], 600000, Date.parse(NOW)).periods.today.totalTokens, 100);
      }
    }
  }
});

test('root-only timing cannot leave an accepted exact model map undeducted', () => {
  const host = device('host', [{ id: id(1), usage: usage(100) }], 'mirror');
  const peer = device('peer', [{ id: id(1), usage: usage(100) }]);
  for (const evidence of Object.values(host.usageIdentity.periods)) delete evidence.events[0].usage.modelThroughput;
  const fixed = packUsageIdentity(host.usageIdentity);
  assert.ok(fixed, 'root-only evidence can encode before the receiver bounds it');
  for (const evidence of [host.usageIdentity, fixed]) for (const hub of [require('../../src/shared/usage'), workerUsage]) {
    const record = hub.normalizeDeviceRecord({ ...host, usageIdentity: evidence });
    assert.equal(record.usageIdentity, undefined);
    const result = hub.aggregateDevices([{ ...host, usageIdentity: evidence }, peer], 600000, Date.parse(NOW));
    for (const period of Object.values(result.periods)) {
      assert.equal(period.totalTokens, 200);
      assert.equal(period.timedTokens, 200);
      assert.equal(period.timedDurationMs, 200);
      assert.equal(period.modelThroughput['claude-sonnet-4-5'].timedTokens, 200);
      assert.equal(period.modelThroughput['claude-sonnet-4-5'].timedDurationMs, 200);
    }
  }
});

test('period and History proof cannot leave impossible cache/output residuals in available buckets', () => {
  const model = 'claude-sonnet-4-5';
  const period = (cacheRead, output) => normalizePeriod({ totalTokens: 100, cacheReadTokens: cacheRead, outputTokens: output,
    clients: { claude: 100 }, models: { [model]: 100 }, clientModels: { claude: { [model]: 100 } },
    clientCacheReads: { claude: cacheRead }, modelCacheReads: { [model]: cacheRead },
    clientOutputs: { claude: output }, modelOutputs: { [model]: output }, capabilities: { tokenComponents: true } });
  const day = (cacheRead, output) => ({ date: '2026-10-13', tokens: 100, cost: 0, messages: 1,
    cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output, unclassifiedTokens: 0,
    perClient: { claude: { tokens: 100, cost: 0, messages: 1, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output, unclassifiedTokens: 0 } },
    perModel: { [model]: { tokens: 100, cost: 0, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output, unclassifiedTokens: 0 } } });
  const mirror = device('mirror', [{ id: id(1), usage: period(100, 0) }], 'mirror');
  const native = device('native', [{ id: id(1), usage: period(0, 100) }]);
  mirror.history = normalizeHistory({ contributions: [day(100, 0)] }, { todayKey: '2026-10-13' });
  native.history = normalizeHistory({ contributions: [day(0, 100)] }, { todayKey: '2026-10-13' });
  for (const record of [mirror, native]) record.usageIdentity.history = { capturedAt: NOW, events: [{ id: id(1),
    observationKind: record === mirror ? 'mirror' : 'native', days: [{ date: '2026-10-13', usage: day(record === mirror ? 100 : 0, record === mirror ? 0 : 100) }] }] };
  const corrupt = structuredClone(mirror.usageIdentity);
  for (const evidence of Object.values(corrupt.periods)) evidence.events[0].usage = period(0, 0);
  corrupt.history.events[0].days[0].usage = day(0, 0);
  const packed = packUsageIdentity(corrupt);
  assert.ok(packed, 'standalone claims are internally consistent before receiver bounds');
  for (const evidence of [corrupt, packed]) for (const hub of [require('../../src/shared/usage'), workerUsage]) {
    assert.equal(hub.normalizeDeviceRecord({ ...mirror, usageIdentity: evidence }).usageIdentity, undefined);
    const result = hub.aggregateDevices([{ ...mirror, usageIdentity: evidence }, native], 600000, Date.parse(NOW));
    for (const value of Object.values(result.periods)) {
      assert.equal(value.totalTokens, 200);
      assert.equal(value.cacheReadTokens + value.outputTokens, 200);
    }
    const history = hub.aggregateHistory([{ ...mirror, usageIdentity: evidence }, native], { todayKey: '2026-10-13' });
    assert.equal(history.summary.totalTokens, 200);
    for (const value of [history.daily[0], history.daily[0].perClient.claude, history.daily[0].perModel[model]]) {
      assert.equal(value.cacheReadTokens + value.outputTokens, value.tokens);
    }
  }
});

test('root, client and model residuals independently bound raw and fixed period and History proof', () => {
  const { packFixedIdentity } = require('../../src/shared/usageIdentityCodec');
  const counter = (tokens, cacheReadTokens = 0) => ({ tokens, cost: 0, messages: 0, cacheReadTokens,
    cacheWriteTokens: 0, outputTokens: 0, unclassifiedTokens: 0 });
  const claim = normalizePeriod({ totalTokens: 100, clients: { claude: 100 }, models: { a: 100 }, clientModels: { claude: { a: 100 } } });
  const dayClaim = { ...counter(100), perClient: { claude: counter(100) }, perModel: { a: counter(100) } };
  for (const axis of ['root', 'client', 'model']) {
    const accepted = normalizePeriod({ totalTokens: axis === 'root' ? 100 : 200, cacheReadTokens: 100,
      clients: axis === 'client' ? { claude: 100, codex: 100 } : { claude: axis === 'root' ? 100 : 200 },
      models: axis === 'root' ? { a: 100 } : { a: 100, b: 100 },
      clientCacheReads: axis === 'client' ? { claude: 100 } : {}, modelCacheReads: axis === 'model' ? { a: 100 } : {} });
    const day = { date: '2026-10-13', ...counter(axis === 'root' ? 100 : 200, 100),
      perClient: axis === 'client' ? { claude: counter(100, 100), codex: counter(100) }
        : { claude: counter(axis === 'root' ? 100 : 200) },
      perModel: axis === 'model' ? { a: counter(100, 100), b: counter(100) }
        : axis === 'root' ? { a: counter(100) } : { a: counter(100), b: counter(100) } };
    const record = { today: accepted, history: { daily: [day], monthly: [{ month: '2026-10',
      tokens: day.tokens, cost: 0, perClient: day.perClient, perModel: day.perModel }] } };
    for (const raw of [
      { version: 1, eventIdentityVersion: 2, periods: { today: { capturedAt: NOW, events: [{ id: id(1), observationKind: 'mirror', usage: claim }] } } },
      { version: 1, eventIdentityVersion: 2, periods: {}, history: { capturedAt: NOW, events: [{ id: id(1), observationKind: 'mirror',
        days: [{ date: day.date, usage: dayClaim }] }] } }
    ]) for (const evidence of [raw, packFixedIdentity(raw)]) {
      assert.ok(evidence);
      for (const identity of [{ normalizeUsageIdentity }, workerIdentity]) assert.equal(identity.normalizeUsageIdentity(evidence, record), null, axis);
    }
  }
});

test('a duplicated event cannot claim a disjoint event reasoning even within the accepted session bound', () => {
  const shared = { id: id(1), usage: usage(100) };
  const separate = { id: id(2), usage: usage(200) };
  separate.usage.sessions['claude:session-a'].reasoningTokens = 20;
  const host = device('host', [shared, separate], 'mirror');
  for (const period of Object.values(host.usageIdentity.periods)) period.events.splice(1);
  const peer = device('peer', [shared]);
  const forged = structuredClone(host);
  for (const period of Object.values(forged.usageIdentity.periods)) period.events[0].usage.sessions['claude:session-a'].reasoningTokens = 20;
  const { packFixedIdentity } = require('../../src/shared/usageIdentityCodec');
  for (const evidence of [forged.usageIdentity, packFixedIdentity(forged.usageIdentity)]) {
    assert.ok(evidence);
    for (const hub of [require('../../src/shared/usage'), workerUsage]) {
      assert.equal(hub.normalizeDeviceRecord({ ...forged, usageIdentity: evidence }).usageIdentity?.periods.today, undefined);
      const aggregate = hub.aggregateDevices([{ ...forged, usageIdentity: evidence }, peer], 600000, Date.parse(NOW));
      assert.equal(aggregate.periods.today.sessions['claude:session-a'].reasoningTokens, 20);
      assert.equal(aggregate.periods.today.totalTokens, 400);
    }
  }
  const accepted = aggregateDevices([syncPayload(host), syncPayload(peer)], 600000, Date.parse(NOW));
  assert.equal(accepted.periods.today.totalTokens, 300);
  assert.equal(accepted.periods.today.sessions['claude:session-a'].reasoningTokens, 20);
});

test('native events reconcile mirror duplicates across hostnames and keep disjoint turns and every period attribution', () => {
  const shared = { id: id(1), usage: usage(100) };
  const host = device('windows', [shared, { id: id(2), usage: usage(200) }], 'mirror');
  const remote = device('linux', [shared, { id: id(3), usage: usage(300) }]);
  const before = JSON.stringify([host, remote]);
  const result = aggregateDevices([host, remote], 600000, Date.parse(NOW));
  for (const period of Object.values(result.periods)) {
    assert.equal(period.totalTokens, 600);
    assert.equal(period.clients.claude, 600);
    assert.equal(period.models['claude-sonnet-4-5'], 600);
    assert.equal(period.clientModels.claude['claude-sonnet-4-5'], 600);
    assert.equal(period.cacheReadTokens, 300);
    assert.equal(period.outputTokens, 60);
    assert.equal(period.timedTokens, 600);
    assert.equal(period.timedDurationMs, 600);
    assert.equal(period.projects.repo.tokens, 600);
    assert.equal(period.sessions['claude:session-a'].totalTokens, 600);
    assert.equal(period.sessions['claude:session-a'].messageCount, 3);
    assert.equal(period.sessions['claude:session-a'].providers.anthropic, 600);
    assert.equal(period.costUsd, 0.0006);
  }
  assert.equal(result.devices.find(row => row.deviceId === 'windows').periods.allTime.totalTokens, 300);
  assert.equal(result.devices.find(row => row.deviceId === 'linux').periods.allTime.totalTokens, 400);
  assert.equal(JSON.stringify([host, remote]), before);
  assert.equal(aggregateDevices([remote, host], 600000, Date.parse(NOW)).periods.allTime.totalTokens, 600);
});

test('an exact native correction beats a newer larger mirror reading without max-total ownership', () => {
  const mirror = device('host', [{ id: id(1), usage: usage(200) }], 'mirror');
  const native = device('remote', [{ id: id(1), usage: usage(100) }]);
  for (const evidence of Object.values(mirror.usageIdentity.periods)) evidence.capturedAt = '2026-10-13T03:00:00.000Z';
  assert.equal(aggregateDevices([mirror, native], 600000, Date.parse(NOW)).periods.allTime.totalTokens, 100);
});

test('same session without native proof, invalid envelopes, and overclaims remain additive', () => {
  const native = device('a', [{ id: id(1), usage: usage(100) }]);
  const legacy = device('b', [{ id: id(1), usage: usage(100) }]);
  delete legacy.usageIdentity;
  assert.equal(aggregateDevices([native, legacy], 600000, Date.parse(NOW)).periods.allTime.totalTokens, 200);
  const invalid = structuredClone(native);
  invalid.usageIdentity.eventIdentityVersion = 99;
  assert.equal(normalizeDeviceRecord(invalid).usageIdentity, undefined);
  const overclaim = structuredClone(native);
  overclaim.usageIdentity.periods.allTime.events.push({ id: id(2), observationKind: 'native', usage: usage(100) });
  assert.equal(normalizeDeviceRecord(overclaim).usageIdentity.periods.allTime, undefined);
  const negative = structuredClone(native);
  negative.usageIdentity.periods.allTime.events[0].usage.totalTokens = -1;
  assert.equal(normalizeUsageIdentity(negative.usageIdentity, negative), null);
});

test('limits-only retains matching proof, a legacy full usage update clears it', () => {
  const initial = device('a', [{ id: id(1), usage: usage(100) }]);
  assert.ok(mergeDeviceRecord(initial, { deviceId: 'a', limitsOnly: true }).usageIdentity);
  const legacy = { ...initial }; delete legacy.usageIdentity;
  assert.equal(mergeDeviceRecord(initial, legacy).usageIdentity, undefined);
});

test('event model attribution and physical component totals bound session and throughput claims in both encodings', () => {
  const first = { id: id(1), usage: usage(100, { model: 'model-a' }) };
  const second = { id: id(2), usage: usage(100, { model: 'model-b' }) };
  const accepted = device('host', [first, second], 'mirror');
  for (const corrupt of [
    row => { row.modelThroughput = { 'model-b': row.modelThroughput['model-a'] }; },
    row => { row.sessions['claude:session-a'].models = { 'model-b': 100 }; row.sessions['claude:session-a'].modelCosts = { 'model-b': row.costUsd }; },
    row => { row.cacheReadTokens = 100; row.clientCacheReads.claude = 100; row.modelCacheReads['model-a'] = 100; row.outputTokens = 100; row.clientOutputs.claude = 100; row.modelOutputs['model-a'] = 100; }
  ]) {
    const raw = structuredClone(normalizeUsageIdentity(accepted.usageIdentity, accepted));
    // All-time uploads intentionally remove session detail before validation.
    // Exercise the session-bearing Today evidence in both encodings.
    delete raw.periods.month;
    delete raw.periods.allTime;
    for (const evidence of Object.values(raw.periods)) {
      evidence.events = [structuredClone(evidence.events[0])];
      corrupt(evidence.events[0].usage);
    }
    assert.equal(normalizeUsageIdentity(raw, accepted), null);
    assert.equal(packUsageIdentity(raw), null, 'packing must not repair malformed raw attribution');
    assert.equal(normalizeUsageIdentity(packUsageIdentity(raw), accepted), null);
  }
});

test('inconsistent component and foreign client attribution cannot authorize deductions', () => {
  const initial = device('a', [{ id: id(1), usage: usage(100) }]);
  for (const [index, corrupt] of [
    row => { row.clientCacheReads.claude = 25; },
    row => { row.modelOutputs['claude-sonnet-4-5'] = 5; },
    row => { row.projects.repo.clients = { codex: 100 }; },
    row => { row.sessions['codex:session-a'] = row.sessions['claude:session-a']; delete row.sessions['claude:session-a']; },
    row => { row.sessions['claude:other-session'] = row.sessions['claude:session-a']; delete row.sessions['claude:session-a']; },
    row => { row.sessions['claude:session-a'].models = { 'cost-model': 99.5 }; }
  ].entries()) {
    const raw = structuredClone(initial);
    for (const evidence of Object.values(raw.usageIdentity.periods)) {
      evidence.events[0].usage = structuredClone(evidence.events[0].usage);
      corrupt(evidence.events[0].usage);
    }
    assert.equal(normalizeDeviceRecord(raw).usageIdentity, undefined, `corruption ${index}`);
  }
});

test('event client/model buckets must match their model buckets before any duplicate deduction', () => {
  const first = { id: id(1), usage: usage(100, { model: 'model-a' }) };
  const second = { id: id(2), usage: usage(100, { model: 'model-b' }) };
  for (const event of [first, second]) {
    const model = Object.keys(event.usage.models)[0];
    Object.assign(event.usage, { unpricedTokens: 100, clientUnpricedTokens: { claude: 100 },
      modelUnpricedTokens: { [model]: 100 }, clientModelUnpricedTokens: { claude: { [model]: 100 } } });
  }
  const mirror = device('host', [first, second], 'mirror');
  const original = device('remote', [first]);
  for (const corrupt of [
    row => { row.clientModels.claude = { 'model-b': 100 }; },
    row => { row.clientModelCosts.claude = { 'model-b': row.costUsd }; },
    row => {
      row.unpricedTokens = 100; row.clientUnpricedTokens = { claude: 100 };
      row.modelUnpricedTokens = { 'model-a': 100 };
      row.clientModelUnpricedTokens = { claude: { 'model-b': 100 } };
    }
  ]) {
    const raw = structuredClone(normalizeUsageIdentity(mirror.usageIdentity, mirror));
    for (const evidence of Object.values(raw.periods)) {
      evidence.events = [structuredClone(evidence.events[0])];
      corrupt(evidence.events[0].usage);
    }
    assert.equal(packUsageIdentity(raw), null, 'packing must reject mismatched model/client token, cost and unpriced maps');
    for (const evidence of [raw, packUsageIdentity(raw)]) {
      const badMirror = { ...mirror, usageIdentity: evidence };
      for (const implementation of [{ normalizeUsageIdentity, aggregateDevices },
        { normalizeUsageIdentity: workerIdentity.normalizeUsageIdentity, aggregateDevices: workerUsage.aggregateDevices }]) {
        assert.equal(implementation.normalizeUsageIdentity(evidence, mirror), null);
        const result = implementation.aggregateDevices([badMirror, original], 600000, Date.parse(NOW));
        for (const period of Object.values(result.periods)) {
          assert.deepEqual({ ...period.clientModels.claude }, { 'model-a': 200, 'model-b': 100 });
          assert.equal(period.clientModelCosts.claude['model-b'], second.usage.costUsd);
        }
      }
    }
  }
});

test('an unlabeled session cannot authorize a deduction from an unrelated project', () => {
  const record = device('host', [{ id: id(1), usage: usage(100) }], 'mirror');
  for (const period of [record.today, record.month, record.allTime]) {
    delete period.sessions['claude:session-a'].projectLabel;
  }
  const raw = { ...record.usageIdentity, periods: { today: record.usageIdentity.periods.today } };
  assert.equal(normalizeUsageIdentity(raw, record), null);
  assert.equal(normalizeUsageIdentity(packUsageIdentity(raw), record), null);
});

test('expired native Today cannot erase a current mirror contribution', () => {
  const mirror = device('a', [{ id: id(1), usage: usage(100) }], 'mirror');
  const old = device('b', [{ id: id(1), usage: usage(200) }]);
  old.periodWindows.today.endsAt = '2026-10-13T00:00:00.000Z';
  assert.equal(aggregateDevices([old, mirror], 600000, Date.parse(NOW)).periods.today.totalTokens, 100);
});

test('History reconciles daily/monthly/model/components and recomputes summary from the same events', () => {
  const mirror = device('host', [{ id: id(1), usage: usage(100) }], 'mirror');
  const native = device('remote', [{ id: id(1), usage: usage(100) }, { id: id(2), usage: usage(200) }]);
  for (const [record, tokens] of [[mirror, [100]], [native, [100, 200]]]) {
    const days = tokens.map(value => historyDay(value));
    record.history = normalizeHistory({ contributions: days }, { todayKey: '2026-10-13' });
    record.usageIdentity.history = { capturedAt: NOW, events: days.map((day, index) => ({ id: id(index + 1),
      observationKind: record === mirror ? 'mirror' : 'native', days: [{ date: day.date, usage: day }] })) };
  }
  // normalizeHistory expects one row per day. Fold the two native rows as real graph does.
  native.history = aggregateHistory([{ history: native.history }], { todayKey: '2026-10-13' });
  const history = aggregateHistory([mirror, native], { todayKey: '2026-10-13' });
  assert.equal(history.summary.totalTokens, 300);
  assert.equal(history.summary.messages, 2);
  assert.equal(history.daily[0].tokens, 300);
  assert.equal(history.daily[0].cacheReadTokens, 150);
  assert.equal(history.daily[0].perModel['claude-sonnet-4-5'].tokens, 300);
  assert.equal(history.monthly[0].perClient.claude.tokens, 300);
  assert.ok(Math.abs(history.monthly[0].cost - 0.0003) < Number.EPSILON * 0.001);
});

test('sync never sends event paths/titles or all-time session detail; budget drops whole optional evidence first', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  const event = record.usageIdentity.periods.today.events[0];
  event.sourcePath = '/private/transcript'; event.nativeKey = 'secret'; event.usage.sessions['claude:session-a'].title = 'secret title';
  const payload = syncPayload(record);
  assert.ok(payload.usageIdentity);
  const decoded = normalizeDeviceRecord(payload).usageIdentity;
  assert.equal(decoded.periods.allTime.events[0].usage.sessions && Object.keys(decoded.periods.allTime.events[0].usage.sessions).length, 0);
  assert.ok(!decoded.periods.allTime.events[0].sessionId);
  assert.ok(!JSON.stringify(payload.usageIdentity).includes('secret'));
  assert.ok(!JSON.stringify(payload.usageIdentity).includes('/private'));
  const baseline = serializeSyncPayload({ ...record, usageIdentity: undefined });
  const reduced = serializeSyncPayload(record, { maxBytes: baseline.bytes + 10 });
  assert.equal(reduced.payload.usageIdentity, undefined);
  assert.equal(reduced.payload.allTime.totalTokens, 100);
});

test('fixed event rows preserve thousands of cumulative events within the existing upload budget', () => {
  const events = Array.from({ length: 2500 }, (_, index) => ({ id: id(index + 1), usage: usage(100) }));
  const record = device('a', events);
  const result = serializeSyncPayload(record);
  assert.ok(result.bytes < 1024 * 1024);
  assert.equal(normalizeDeviceRecord(result.payload).usageIdentity.periods.allTime.events.length, 2500);
  const other = { ...result.payload, deviceId: 'b' };
  assert.equal(aggregateDevices([result.payload, other], 600000, Date.parse(NOW)).periods.allTime.totalTokens, 250000);
});

test('fixed rows reject invalid references, duplicates, identifiers, negative and overflowing counters', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  const packed = packUsageIdentity(normalizeDeviceRecord(record).usageIdentity);
  const corruptions = [
    value => { value.periods.today.events[0] = 999999; },
    value => { value.events[0][4][0].push(structuredClone(value.events[0][4][0][0])); },
    value => { value.models[0] = '__proto__'; },
    value => { value.events[0][4][0][0][1] = -1; },
    value => { value.events[0][4][0][0][1] = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.events[0][4][0][0][2] = Infinity; },
    value => { value.events[0][4][0][0][0] = 999999; },
    value => { value.periods.today.events.push(value.periods.today.events[0]); },
    value => { value.events[0].push({ totalTokens: 1 }); },
    value => { value.paths = [['models', 'foreign']]; },
    value => { value.encoding = 'unknown'; }
  ];
  for (const corrupt of corruptions) {
    const input = structuredClone(packed); corrupt(input);
    assert.equal(normalizeUsageIdentity(input, record), null);
  }
  assert.equal({}.totalTokens, undefined);
});

test('native source evidence is never reparsed as a second usage input', () => {
  const { extractUsageFromTokscale, extractUsageBundleFromTokscale } = require('../../src/shared/usage');
  const json = { entries: [{ client: 'claude', model: 'model', input: 100 }], sourceUsage: {
    rootUsage: [{ client: 'claude', model: 'model', totalTokens: 100 }], sessions: [{ events: [{ contributions: [{ model: 'model', input: 100 }] }] }]
  } };
  assert.equal(extractUsageFromTokscale(json).totalTokens, 100);
  assert.equal(extractUsageBundleFromTokscale(json).period.totalTokens, 100);
});

test('explicit timed output separates timed from untimed fragments in one report group', () => {
  const { extractUsageFromTokscale } = require('../../src/shared/usage');
  const row = { client: 'claude', sessionId: 'session', model: 'model', input: 100, output: 40,
    performance: { totalDurationMs: 500, timedTokens: 80, timedOutputTokens: 10 } };
  const period = extractUsageFromTokscale({ entries: [row] });
  assert.equal(period.timedOutputTokens, 10);
  assert.equal(period.modelThroughput.model.timedOutputTokens, 10);
  assert.equal(period.sessions['claude:session'].timedOutputTokens, 10);
  delete row.performance.timedOutputTokens;
  assert.equal(extractUsageFromTokscale({ entries: [row] }).timedOutputTokens, 40);
});

test('fixed upload conserves mixed models, timing, explicit provider/session allocations and unpriced counters', () => {
  const { extractUsageFromTokscale } = require('../../src/shared/usage');
  const contribution = normalizePeriod(extractUsageFromTokscale({ entries: [
    { client: 'claude', sessionId: 'session-a', model: 'a', provider: 'one', input: 13, output: 3,
      reasoning: 2, cacheRead: 5, cacheWrite: 2, cost: 0.012, messages: 2, unpricedTokens: 3,
      performance: { timedTokens: 16, timedOutputTokens: 3, totalDurationMs: 111 } },
    { client: 'claude', sessionId: 'session-a', model: 'a', provider: 'two', input: 7, output: 2,
      cost: 0.003, messages: 1 },
    { client: 'claude', sessionId: 'session-a', model: 'b', provider: 'one', input: 5, output: 1,
      cost: 0, unpricedTokens: 6, messages: 1 }
  ] }));
  const record = device('a', [{ id: id(1), usage: contribution }]);
  const canonical = normalizeUsageIdentity(record.usageIdentity, record);
  const packed = packUsageIdentity(canonical);
  assert.equal(packed.encoding, 'event-rows-v1');
  assert.equal(packed.paths, undefined);
  const decoded = normalizeUsageIdentity(packed, record);
  assert.deepEqual(decoded.periods.today, canonical.periods.today);
  assert.deepEqual(decoded.periods.month, canonical.periods.month);
  assert.equal(Object.keys(decoded.periods.allTime.events[0].usage.sessions).length, 0);
  const session = decoded.periods.today.events[0].usage.sessions['claude:session-a'];
  assert.deepEqual(session.providers, canonical.periods.today.events[0].usage.sessions['claude:session-a'].providers);
  assert.equal(decoded.periods.today.events[0].usage.timedOutputTokens, 3);
  assert.equal(decoded.periods.today.events[0].usage.unpricedTokens, 9);
});

test('serial period captures and independent graph History share only equal accounting rows', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  for (const [index, name] of ['today', 'month', 'allTime'].entries()) {
    record[name] = usage((index + 1) * 100);
    record.usageIdentity.periods[name].capturedAt = `2026-10-13T02:0${index}:00.000Z`;
    record.usageIdentity.periods[name].events[0].usage = record[name];
  }
  const day = historyDay(400);
  record.history = normalizeHistory({ contributions: [day] }, { todayKey: '2026-10-13' });
  record.usageIdentity.history = { capturedAt: '2026-10-13T02:05:00.000Z', events: [
    { id: id(1), observationKind: 'native', days: [{ date: day.date, usage: day }] }
  ] };
  const packed = packUsageIdentity(normalizeUsageIdentity(record.usageIdentity, record));
  assert.equal(packed.events.length, 4);
  const decoded = normalizeUsageIdentity(packed, record);
  assert.deepEqual(['today', 'month', 'allTime'].map(name => decoded.periods[name].events[0].usage.totalTokens), [100, 200, 300]);
  assert.equal(decoded.history.events[0].days[0].usage.tokens, 400);
  assert.equal(decoded.history.capturedAt, '2026-10-13T02:05:00.000Z');

  // Session-free AllTime accounting with equal tokens but different cost or
  // timing must never borrow the earlier row.
  const same = device('a', [{ id: id(1), usage: usage(100) }]);
  const equalPacked = packUsageIdentity(normalizeUsageIdentity(same.usageIdentity, same));
  assert.equal(equalPacked.events.length, 1);
  for (const changed of [usage(100, { cost: 0.1 }), usage(100, { timed: false })]) {
    same.allTime = changed;
    same.usageIdentity.periods.allTime.events[0].usage = changed;
    assert.equal(packUsageIdentity(normalizeUsageIdentity(same.usageIdentity, same)).events.length, 2);
  }
});

test('fixed History preserves optional omitted components and monthly-only days', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  const day = historyDay(100);
  record.history = normalizeHistory({ contributions: [day] }, { todayKey: '2026-10-13' });
  record.usageIdentity.history = { capturedAt: NOW, events: [
    { id: id(1), observationKind: 'native', days: [{ date: day.date, usage: day }] }
  ] };
  // This is the current trimming contract: availability can differ between
  // root, client and model component counters.
  delete record.history.daily[0].cacheReadTokens;
  delete record.history.daily[0].perClient.claude.outputTokens;
  delete record.history.daily[0].perModel['claude-sonnet-4-5'].unclassifiedTokens;
  const canonical = normalizeUsageIdentity(record.usageIdentity, record);
  assert.ok(canonical.history);
  const packed = packUsageIdentity(canonical);
  assert.ok(packed);
  assert.deepEqual(normalizeUsageIdentity(packed, record).history, canonical.history);
  record.history.daily = [];
  const monthlyCanonical = normalizeUsageIdentity(record.usageIdentity, record);
  assert.deepEqual(normalizeUsageIdentity(packUsageIdentity(monthlyCanonical), record).history, monthlyCanonical.history);
});

test('fixed session attribution corruption and overclaims stay additive in Node and generated Worker', () => {
  const record = device('host', [{ id: id(1), usage: usage(100, { model: 'a' }) },
    { id: id(2), usage: usage(100, { model: 'b' }) }], 'mirror');
  const original = device('remote', [{ id: id(1), usage: usage(100, { model: 'a' }) }]);
  const canonical = normalizeUsageIdentity(record.usageIdentity, record);
  canonical.periods = { today: { ...canonical.periods.today, events: [canonical.periods.today.events[0]] } };
  const packed = packUsageIdentity(canonical);
  for (const corrupt of [
    value => { value.events[0][4][1][0][1][0][0] = value.models.push('foreign') - 1; },
    value => { value.events[0][4][0][0][2] = 1; },
    value => { value.events[0][4][0][0][3] = 101; },
    value => { value.events[0][4][0][0][0] = value.models.push('foreign') - 1; },
    value => { value.events[0][4][0][0].push({ clientModels: { claude: { b: 100 } } }); }
  ]) {
    const wire = structuredClone(packed); corrupt(wire);
    for (const implementation of [{ normalizeUsageIdentity, aggregateDevices },
      { normalizeUsageIdentity: workerIdentity.normalizeUsageIdentity, aggregateDevices: workerUsage.aggregateDevices }]) {
      assert.equal(implementation.normalizeUsageIdentity(wire, record), null);
      assert.equal(implementation.aggregateDevices([{ ...record, usageIdentity: wire }, original], 600000, Date.parse(NOW)).periods.today.totalTokens, 300);
    }
  }
});

test('AllTime-only proof adds no session/provider detail and unsupported draft encoding stays additive', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  const canonical = normalizeUsageIdentity(record.usageIdentity, record);
  canonical.periods = { allTime: canonical.periods.allTime };
  const packed = packUsageIdentity(canonical);
  assert.deepEqual(packed.sessions, []);
  assert.deepEqual(packed.providers, []);
  assert.deepEqual(packed.events[0][4][1], []);
  assert.ok(normalizeUsageIdentity(packed, record));
  packed.encoding = 'counter-table-v1';
  assert.equal(normalizeUsageIdentity(packed, record), null);
});

test('session component claims cannot erase another event input or reasoning in raw or fixed evidence', () => {
  const primitive = (input, output = 0) => normalizePeriod(require('../../src/shared/usage').extractUsageFromTokscale({
    entries: [{ client: 'claude', sessionId: 'session-a', model: 'model', provider: 'anthropic', input, output, cost: 0 }]
  }));
  const mirror = device('host', [{ id: id(1), usage: primitive(100) }, { id: id(2), usage: primitive(1000) }], 'mirror');
  const native = device('remote', [{ id: id(1), usage: primitive(100) }]);
  const canonical = normalizeUsageIdentity(mirror.usageIdentity, mirror);
  canonical.periods = { today: { ...canonical.periods.today, events: [canonical.periods.today.events[0]] } };
  const fixed = packUsageIdentity(canonical);
  const forgedRaw = structuredClone(canonical);
  forgedRaw.periods.today.events[0].usage.sessions['claude:session-a'].inputTokens = 1100;
  assert.equal(packUsageIdentity(forgedRaw), null);
  const forgedFixed = structuredClone(fixed);
  forgedFixed.events[0][4][1][0][0][4] = 1100;
  for (const implementation of [{ normalizeUsageIdentity, aggregateDevices },
    { normalizeUsageIdentity: workerIdentity.normalizeUsageIdentity, aggregateDevices: workerUsage.aggregateDevices }]) {
    for (const evidence of [forgedRaw, forgedFixed]) {
      assert.equal(implementation.normalizeUsageIdentity(evidence, mirror), null);
      const result = implementation.aggregateDevices([{ ...mirror, usageIdentity: evidence }, native], 600000, Date.parse(NOW));
      assert.equal(result.periods.today.totalTokens, 1200);
      assert.equal(result.periods.today.sessions['claude:session-a'].inputTokens, 1200);
    }
    const valid = implementation.aggregateDevices([{ ...mirror, usageIdentity: fixed }, native], 600000, Date.parse(NOW));
    assert.equal(valid.periods.today.totalTokens, 1100);
    assert.equal(valid.periods.today.sessions['claude:session-a'].inputTokens, 1100);
  }
  for (const field of ['reasoningTokens', 'timedOutputTokens']) {
    const raw = structuredClone(canonical);
    raw.periods.today.events[0].usage.sessions['claude:session-a'][field] = 1;
    assert.equal(packUsageIdentity(raw), null, field);
    const wire = structuredClone(fixed);
    wire.events[0][4][1][0][0][field === 'reasoningTokens' ? 8 : 9] = 1;
    assert.equal(normalizeUsageIdentity(wire, mirror), null, field);
    assert.equal(workerIdentity.normalizeUsageIdentity(wire, mirror), null, field);
  }
});
