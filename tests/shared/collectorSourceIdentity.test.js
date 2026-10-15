'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { collectUsageOnce, startCollector, configFingerprint, collectorAnchorTrust } = require('../../src/shared/collector');
const { normalizeUsageIdentity } = require('../../src/shared/usageIdentity');
const { createDeviceState } = require('../../src/shared/usage/deviceState');
const { canonicalWatchPath } = require('../../src/shared/clientSources');
const { deviceRecordFromAnchor } = require('../../src/shared/anchorSeed');
const { installInProcessWatchHost } = require('../helpers/watchHost');

installInProcessWatchHost(test);

const id = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const now = new Date('2026-10-13T06:00:00Z');
const todayKey = '2026-10-13';
const event = (name, input, observationKind = 'native', date = todayKey) => ({
  id: id(name), observationKind, contributions: [{ timestamp: Date.parse(`${date}T06:00:00Z`), modelId: 'claude-opus-4-8',
    providerId: 'anthropic', tokens: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: input / 100, messages: 1 }] });
function report(events, roots = {}, { readStatus = 'complete', ack = true, rootUsage } = {}) {
  return { entries: events.map(e => ({ client: 'claude', sessionId: 's', model: e.contributions[0].modelId,
    provider: 'anthropic', input: e.contributions[0].tokens.input, cost: e.contributions[0].cost, messages: 1 })),
  sourceUsage: { version: 2, eventIdentityVersion: 2, fullHistory: false, capturedAt: now.toISOString(), bucketTimezone: 'UTC',
    replacementClients: ['claude'], partialClients: readStatus === 'complete' ? [] : ['claude'], rowsWithoutIdentity: {},
    scopes: [{ id: id('scope'), clients: ['claude'], readStatus, identityStatus: 'exact' }],
    sessions: [{ client: 'claude', sessionId: 's', scopeId: id('scope'), events }], ...(ack ? { scanRoots: roots } : {}),
    ...(rootUsage ? { rootUsage } : {}) } };
}
function base(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-identity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { now, clients: 'claude', deviceId: 'claims-test', allTimeSince: '2026-01-01', env: {}, homeDir: home,
    commandTimeoutMs: 1000, projectsEnabled: false, wslScanEnabled: false, codexLocalUsageEnabled: false, sessionActivityPolling: false,
    historyEnabled: false, sessionMetadataDeps: { resolveSessionMetadata: () => null }, ...overrides };
}
function anchorOf(captured) {
  return { ...captured, ...captured.windowsPeriods };
}
function graph(events, roots) {
  const data = report(events, roots);
  const dates = new Map();
  for (const e of events) {
    const date = new Date(e.contributions[0].timestamp).toISOString().slice(0, 10);
    if (!dates.has(date)) dates.set(date, []);
    dates.get(date).push({ client: 'claude', ...e.contributions[0] });
  }
  return { contributions: [...dates].map(([date, clients]) => ({ date, clients })), sourceUsage: { ...data.sourceUsage, fullHistory: true } };
}

for (const kind of ['native', 'mirror']) for (const includeHistory of [false, true]) {
  test(`event capture authority survives ${kind} retained and fresh full scans with History=${includeHistory}`, async t => {
    // These UTC instants compare authority within one day, not a rollover.
    const previousTZ = process.env.TZ;
    process.env.TZ = 'UTC';
    t.after(() => {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    });
    const hubs = [require('../../src/shared/usage'), require('../../worker/src/shared/usage')];
    const { syncPayload } = require('../../src/shared/syncPayload');
    const early = '2026-10-13T06:00:00.000Z';
    const middle = '2026-10-13T08:00:00.000Z';
    const late = '2026-10-13T09:00:00.000Z';
    const read = (events, at) => {
      const result = report(events);
      result.sourceUsage.capturedAt = at;
      const sessions = new Map();
      events.forEach((e, i) => {
        const sessionId = e.id === id('B') ? 'fresh-session' : 's';
        result.entries[i].sessionId = sessionId;
        if (!sessions.has(sessionId)) sessions.set(sessionId, { client: 'claude', sessionId, scopeId: id('scope'), events: [] });
        sessions.get(sessionId).events.push(e);
      });
      result.sourceUsage.sessions = [...sessions.values()];
      return result;
    };
    const fullGraph = (events, at) => ({ ...graph(events, {}), sourceUsage: { ...read(events, at).sourceUsage, fullHistory: true } });
    const options = base(t, { historyEnabled: true, includeHistory: true, dailyHistoryArchiveEnabled: true,
      getSessionUsageArchive: () => ({ version: 1, sessions: {} }) });
    options.dailyHistoryArchiveOptions = { path: path.join(options.homeDir, 'daily.json') };
    let projection;
    await collectUsageOnce({ ...options, onSourceArchiveComputed: value => { projection = value; },
      runTokscale: async () => read([event('A', 100, kind)], early), runGraph: async () => fullGraph([event('A', 100, kind)], early) });
    const selected = await collectUsageOnce({ ...options, now: new Date(late), includeHistory, sourceArchiveSnapshot: projection,
      runTokscale: async () => read([event('B', 20, kind)], late), runGraph: async () => fullGraph([event('B', 20, kind)], late) });
    const peerEvents = [event('A', 50, kind), event('B', 10, kind)];
    const peer = await collectUsageOnce({ ...base(t), now: new Date(middle), deviceId: 'remote', historyEnabled: true, includeHistory: true,
      runTokscale: async () => read(peerEvents, middle), runGraph: async () => fullGraph(peerEvents, middle) });
    assert.equal(selected.today.totalTokens, 120);
    for (const hub of hubs) for (const pair of [[selected, peer], [syncPayload(selected), syncPayload(peer)]]) {
      const result = hub.aggregateDevices(pair, 14400000, Date.parse(late));
      for (const name of ['today', 'month', 'allTime']) assert.equal(result.periods[name].totalTokens, 70);
      if (includeHistory) assert.equal(hub.aggregateHistory(pair, { todayKey }).summary.totalTokens, 70);
    }
    for (const evidence of Object.values(selected.usageIdentity.periods)) {
      assert.equal(evidence.events.find(e => e.id === id('A')).capturedAt, early);
      assert.equal(evidence.events.find(e => e.id === id('B')).capturedAt, late);
    }
    if (includeHistory) assert.equal(selected.usageIdentity.history.events.find(e => e.id === id('A')).capturedAt, early);
  });
}

test('collector publishes independent native/mirror events for headless agents without leaking source metadata', async t => {
  const options = base(t);
  const events = [event('A', 4), event('B', 6, 'mirror')];
  const summary = await collectUsageOnce({ ...options, runTokscale: async input => {
    assert.equal(input.sourceSnapshots, true);
    return report(events);
  } });
  assert.equal(summary.today.totalTokens, 10);
  assert.equal(summary.usageIdentity.periods.today.events.length, 2);
  assert.equal(normalizeUsageIdentity(summary.usageIdentity, summary).periods.today.events.length, 2);
  assert.equal(JSON.stringify(summary.usageIdentity).includes(options.homeDir), false);
});

test('native report source rootUsage observations never become extra usage rows', async t => {
  const summary = await collectUsageOnce({ ...base(t), runTokscale: async () => report([event('A', 4)], {},
    { rootUsage: [{ client: 'claude', root: '/private/path', tokens: 4, readStatus: 'complete' }] }) });
  assert.equal(summary.today.totalTokens, 4);
  assert.equal(summary.today.clients.claude, 4);
});

test('watch corrections replace claimed today events in both broader periods, including deletion', async t => {
  const options = base(t);
  let captured;
  const past = event('past', 20, 'native', '2026-10-12');
  const old = [event('A', 5), event('deleted', 7, 'mirror')];
  await collectUsageOnce({ ...options, onAnchorComputed: value => { captured = value; },
    runTokscale: async input => report(input.flags.includes('--today') ? old : [...old, past]) });
  const originalAnchor = anchorOf(captured);
  const fresh = [event('A', 3), event('new', 4, 'mirror')];
  const calls = [];
  const summary = await collectUsageOnce({ ...options, todayOnlyAnchor: originalAnchor, runTokscale: async input => {
    calls.push(input.flags); return report(fresh);
  } });
  assert.deepEqual(calls, [['--today']]);
  assert.equal(summary.today.totalTokens, 7);
  assert.equal(summary.month.totalTokens, 27);
  assert.equal(summary.allTime.totalTokens, 27);
  assert.deepEqual(new Set(summary.usageIdentity.periods.month.events.map(e => e.id)), new Set([id('past'), id('A'), id('new')]));
  assert.equal(summary.usageIdentity.periods.month.events.find(e => e.id === id('A')).usage.totalTokens, 3);
  const removed = await collectUsageOnce({ ...options, todayOnlyAnchor: originalAnchor, runTokscale: async () => report([]) });
  assert.equal(removed.today.totalTokens, 0);
  assert.equal(removed.month.totalTokens, 20);
  assert.deepEqual(removed.usageIdentity.periods.month.events.map(e => e.id), [id('past')]);
});

test('a changed custom scan config forces full scan and cannot carry old broad-period proof', async t => {
  const options = base(t);
  let captured;
  await collectUsageOnce({ ...options, scanRoots: { claude: ['/old,.claude'] },
    runTokscale: async () => report([event('old', 4)]), onAnchorComputed: value => { captured = value; } });
  const calls = [];
  const summary = await collectUsageOnce({ ...options, todayOnlyAnchor: anchorOf(captured), scanRoots: { claude: ['/new,.claude'] },
    runTokscale: async input => { calls.push(input.flags); return report([event('new', 7)]); } });
  assert.equal(calls.length, 3);
  assert.deepEqual(summary.usageIdentity.periods.month.events.map(e => e.id), [id('new')]);
});

test('Windows full tick discovers original homes once; native, History and watch share lossless roots', async t => {
  const options = base(t, { platform: 'win32', wslScanEnabled: true, historyEnabled: true, includeHistory: true });
  const home = '\\\\wsl$\\Ubuntu,Dev\\home\\alice';
  const root = `${home}\\.claude`;
  const discovery = { homes: [home], clientsByHome: { [home]: ['claude', 'gemini'] }, claudeRoots: [root], state: 'ok', diagnostics: [] };
  let discovered = 0;
  let captured;
  const inputs = [];
  const runTokscale = async input => {
    inputs.push(input);
    if (input.flags.includes('--home')) return { entries: [{ client: 'gemini', sessionId: 'wsl', model: 'gemini', input: 2 }] };
    return report([event('shared', 4), event('original-only', 5), event('mirror-only', 3, 'mirror')], input.scanRoots,
      { rootUsage: [{ root, client: 'claude', tokens: 9, readStatus: 'complete' }] });
  };
  const summary = await collectUsageOnce({ ...options, clients: 'claude,gemini', runTokscale,
    discoverWslUsage: () => { discovered++; return discovery; }, onAnchorComputed: value => { captured = value; },
    runGraph: async input => {
      assert.equal(input.sourceSnapshots, true);
      assert.deepEqual(input.scanRoots, { claude: [root] });
      return graph([event('shared', 4), event('original-only', 5), event('mirror-only', 3, 'mirror')], input.scanRoots);
    } });
  assert.equal(discovered, 1);
  assert.equal(summary.today.clients.claude, 12);
  assert.equal(summary.today.clients.gemini, 2);
  assert.deepEqual(inputs.filter(input => input.flags.includes('--home')).map(input => input.clients), ['gemini', 'gemini', 'gemini']);
  assert.deepEqual(summary.wslStatus.withData.sort(), ['claude', 'gemini']);
  assert.deepEqual(summary.wslStatus.detected.sort(), ['claude', 'gemini']);
  assert.deepEqual(inputs.slice(0, 3).map(input => input.flags), [['--today'], ['--month'], ['--since', '2026-01-01']]);
  const watch = await collectUsageOnce({ ...options, clients: 'claude,gemini', includeHistory: false,
    todayOnlyAnchor: anchorOf(captured), wslAnchor: captured.wslBundle, wslStatus: captured.wslStatus,
    discoverWslUsage: () => { throw new Error('watch must not discover'); }, runTokscale });
  assert.equal(discovered, 1);
  assert.equal(watch.today.clients.claude, 12);
  assert.equal(inputs.length, 7);
  assert.deepEqual(inputs.at(-1).scanRoots, { claude: [root] });
});

test('originals are excluded per native period only after acknowledged inclusion', async t => {
  const options = base(t, { platform: 'win32', wslScanEnabled: true });
  const home = '\\\\wsl$\\Ubuntu\\home\\alice';
  const root = `${home}\\.claude`;
  const calls = [];
  const summary = await collectUsageOnce({ ...options,
    discoverWslUsage: () => ({ homes: [home], clientsByHome: { [home]: ['claude'] }, claudeRoots: [root], state: 'ok' }),
    runTokscale: async input => {
      calls.push(input);
      if (input.flags.includes('--home')) return { entries: [{ client: 'claude', sessionId: 's', model: 'claude-opus-4-8', input: 6 }] };
      return report([event('mirror', 4, 'mirror')], input.scanRoots, { ack: input.flags.includes('--today') });
    } });
  assert.deepEqual(calls.filter(input => input.flags.includes('--home')).map(input => input.flags[0]), ['--month', '--since']);
  assert.equal(summary.today.totalTokens, 4);
  assert.equal(summary.month.totalTokens, 10);
});

test('History original inclusion is gated by graph acknowledgement independently of native period acknowledgement', async t => {
  const options = base(t, { platform: 'win32', wslScanEnabled: true, historyEnabled: true, includeHistory: true });
  const home = '\\\\wsl$\\Ubuntu\\home\\alice';
  const root = `${home}\\.claude`;
  for (const graphAck of [false, true]) {
    const nativeCalls = [];
    const graphCalls = [];
    const summary = await collectUsageOnce({ ...options,
      discoverWslUsage: () => ({ homes: [home], clientsByHome: { [home]: ['claude'] }, claudeRoots: [root], state: 'ok' }),
      runTokscale: async input => {
        nativeCalls.push(input);
        return report([event('host', 4)], input.scanRoots, { ack: !graphAck });
      },
      runGraph: async input => {
        graphCalls.push(input);
        if (input.flags?.includes('--home')) {
          assert.equal(input.scanRoots, undefined);
          return graph([event('original', 6)], {});
        }
        const current = graph([event('host', 4)], input.scanRoots);
        if (!graphAck) delete current.sourceUsage.scanRoots;
        return current;
      } });
    assert.equal(nativeCalls.filter(input => input.flags.includes('--home')).length, graphAck ? 3 : 0);
    assert.equal(graphCalls.length, graphAck ? 1 : 2);
    assert.equal(summary.history.summary.totalTokens, graphAck ? 4 : 10);
    if (!graphAck) assert.equal(summary.usageIdentity?.history, undefined, 'additive fallback graphs grant no fresh whole-History proof');
  }
});

test('WSL disabled preserves the host mirror and does not discover originals', async t => {
  const summary = await collectUsageOnce({ ...base(t, { platform: 'win32' }),
    discoverWslUsage: () => { throw new Error('disabled'); },
    runTokscale: async input => { assert.deepEqual(input.scanRoots, {}); return report([event('mirror', 4, 'mirror')]); } });
  assert.equal(summary.today.totalTokens, 4);
  assert.equal(summary.usageIdentity.periods.today.events[0].observationKind, 'mirror');
  assert.equal(summary.wslStatus.state, 'disabled');
});

test('without exact rootUsage WSL detection never fabricates withData from host-native events', async t => {
  const options = base(t, { platform: 'win32', wslScanEnabled: true });
  const home = '\\\\wsl$\\Ubuntu\\home\\alice';
  const summary = await collectUsageOnce({ ...options,
    discoverWslUsage: () => ({ homes: [home], clientsByHome: { [home]: ['claude'] }, claudeRoots: [`${home}\\.claude`], state: 'ok' }),
    runTokscale: async input => report([event('host-native', 4)], input.scanRoots) });
  assert.deepEqual(summary.wslStatus.detected, ['claude']);
  assert.deepEqual(summary.wslStatus.withData, []);
});

test('partial watch reads retain accepted ledger counters and cannot publish newer claims against retained totals', async t => {
  const options = base(t, { historyEnabled: true, includeHistory: true, dailyHistoryArchiveEnabled: true,
    getSessionUsageArchive: () => ({ version: 1, sessions: {} }) });
  options.dailyHistoryArchiveOptions = { path: path.join(options.homeDir, 'daily.json') };
  let captured;
  let projection;
  const events = [event('accepted', 15, 'mirror')];
  const full = await collectUsageOnce({ ...options, onAnchorComputed: value => { captured = value; },
    onSourceArchiveComputed: value => { projection = value; }, runTokscale: async () => report(events), runGraph: async () => graph(events, {}) });
  assert.equal(full.usageIdentity.history.events[0].id, id('accepted'));
  const partial = await collectUsageOnce({ ...options, includeHistory: false, todayOnlyAnchor: anchorOf(captured), sourceArchiveSnapshot: projection,
    runTokscale: async () => report([event('rejected', 5)], {}, { readStatus: 'partial' }) });
  assert.equal(partial.today.totalTokens, 15);
  assert.equal(partial.month.totalTokens, 15);
  assert.equal(partial.usageIdentity.periods.today.events[0].id, id('accepted'));
  assert.equal(partial.usageIdentity.periods.today.events.some(e => e.id === id('rejected')), false);
});

test('persisted anchors include roots and claims; restart with changed roots forces full native scans', async t => {
  const options = base(t, { platform: 'win32', wslScanEnabled: true });
  const previousShared = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = options.homeDir;
  t.after(() => {
    if (previousShared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previousShared;
  });
  const discovery = suffix => { const home = `\\\\wsl$\\Ubuntu\\home\\${suffix}`; return { homes: [home],
    clientsByHome: { [home]: ['claude'] }, claudeRoots: [`${home}\\.claude`], state: 'ok' }; };
  const run = async d => {
    const calls = [];
    const collector = startCollector({ ...options, now: () => new Date(), watchEnabled: false, intervalMs: 100000,
      discoverWslUsage: () => d, runTokscale: async input => {
        calls.push(input.flags);
        const e = event('accepted', 4, 'mirror', new Date().toISOString().slice(0, 10));
        return { ...report([e], input.scanRoots), sourceUsage: { ...report([e], input.scanRoots).sourceUsage, capturedAt: new Date().toISOString() } };
      } });
    try { await collector.whenIdle(); } finally { collector.stop(); await collector.whenIdle(); }
    return calls;
  };
  await run(discovery('alice'));
  const saved = JSON.parse(fs.readFileSync(path.join(options.homeDir, 'collector-anchor.json'), 'utf8'));
  assert.deepEqual(saved.scanRoots, { claude: discovery('alice').claudeRoots });
  assert.ok(saved.nativeIdentityState.today);
  const same = await run(discovery('alice'));
  assert.deepEqual(same, [['--today']]);
  const changed = await run(discovery('bob'));
  assert.equal(changed.length, 3);
});

test('persisted trust fingerprint distinguishes WSL toggle and configured JSON roots', t => {
  const options = base(t, { platform: 'win32', wslScanEnabled: true });
  const sourceOptions = { ...options, scanRoots: { claude: ['/comma,.claude'] }, wslDiscovery: { claudeRoots: ['\\\\wsl$\\Ubuntu\\root\\.claude'] } };
  const fingerprint = configFingerprint('claude', options.allTimeSince, false, '', '', null, 'pricing', sourceOptions);
  assert.notEqual(fingerprint, configFingerprint('claude', options.allTimeSince, false, '', '', null, 'pricing', { ...sourceOptions, wslScanEnabled: false }));
  assert.notEqual(fingerprint, configFingerprint('claude', options.allTimeSince, false, '', '', null, 'pricing', { ...sourceOptions, wslDiscovery: { claudeRoots: [] } }));
  const period = { totalTokens: 0 };
  const saved = { today: period, month: period, allTime: period, dateKey: todayKey, timeZone: 'UTC', configFingerprint: fingerprint };
  assert.equal(collectorAnchorTrust(saved, { ...sourceOptions, now, pricingRevision: 'pricing', dailyHistoryArchiveEnabled: true,
    env: { TZ: 'UTC' }, wslDiscovery: { claudeRoots: [] } }), null);
});

test('upstream native flag fallback retries without source proof and never infers exact identity', async t => {
  const childProcess = require('node:child_process');
  const original = childProcess.spawn;
  const collectorPath = require.resolve('../../src/shared/collector');
  const calls = [];
  childProcess.spawn = (_bin, args, options) => {
    calls.push({ args, env: options.env });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => {
      if (args.includes('--source-snapshots')) {
        child.stderr.emit('data', Buffer.from("error: unexpected argument '--source-snapshots' found")); child.emit('close', 2);
      } else { child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [{ client: 'claude', sessionId: 's', model: 'opus', input: 4 }] }))); child.emit('close', 0); }
    }); return child;
  };
  delete require.cache[collectorPath];
  try {
    const collector = require(collectorPath);
    const summary = await collector.collectUsageOnce({ ...base(t), scanRoots: { claude: ['/comma,.claude'] } });
    assert.equal(summary.today.totalTokens, 4);
    assert.equal(summary.usageIdentity, undefined);
    assert.equal(calls.length, 4);
    assert.equal(calls.filter(call => call.args.includes('--source-snapshots')).length, 1);
    assert.deepEqual(JSON.parse(calls[0].env.TOKSCALE_SCAN_ROOTS_JSON), { claude: ['/comma,.claude'] });
  } finally { childProcess.spawn = original; delete require.cache[collectorPath]; }
});

test('a later unrelated client watch carries the latest Claude today claims while keeping full period baselines', async t => {
  const options = base(t, { clients: 'claude,gemini' });
  let captured;
  const runTokscale = async () => ({ ...report([event('old', 5)]), entries: [
    ...report([event('old', 5)]).entries, { client: 'gemini', sessionId: 'g', model: 'gemini', input: 2 }
  ] });
  await collectUsageOnce({ ...options, runTokscale, onAnchorComputed: value => { captured = value; } });
  const anchor = anchorOf(captured);
  let watched;
  await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients: ['claude'],
    runTokscale: async () => report([event('new', 3)]), onAnchorComputed: value => { watched = value; } });
  anchor.todayPartitions = watched.todayPartitions;
  anchor.todayIdentityState = watched.nativeIdentityState.today;
  const summary = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients: ['gemini'],
    runTokscale: async () => ({ entries: [{ client: 'gemini', sessionId: 'g', model: 'gemini', input: 4 }] }) });
  assert.equal(summary.today.totalTokens, 7);
  for (const name of ['today', 'month', 'allTime']) assert.deepEqual(summary.usageIdentity.periods[name].events.map(e => e.id), [id('new')]);
});

test('native explicit-home scans remove inherited JSON root overrides instead of recounting host paths', async t => {
  const childProcess = require('node:child_process');
  const original = childProcess.spawn;
  const collectorPath = require.resolve('../../src/shared/collector');
  const calls = [];
  childProcess.spawn = (_bin, args, options) => {
    calls.push({ args, env: options.env });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] }))); child.emit('close', 0); });
    return child;
  };
  delete require.cache[collectorPath];
  const inherited = process.env.TOKSCALE_SCAN_ROOTS_JSON;
  process.env.TOKSCALE_SCAN_ROOTS_JSON = JSON.stringify({ claude: ['/host,.claude'] });
  try {
    const collector = require(collectorPath);
    const home = '\\\\wsl$\\Ubuntu\\home\\alice';
    await collector.collectUsageOnce({ ...base(t, { platform: 'win32', wslScanEnabled: true }),
      discoverWslUsage: () => ({ homes: [home], clientsByHome: { [home]: ['claude'] }, claudeRoots: [`${home}\\.claude`], state: 'ok' }) });
    assert.equal(calls.filter(call => call.args.includes('--home')).length, 3);
    for (const call of calls.filter(call => call.args.includes('--home'))) assert.equal(Object.hasOwn(call.env, 'TOKSCALE_SCAN_ROOTS_JSON'), false);
  } finally {
    if (inherited === undefined) delete process.env.TOKSCALE_SCAN_ROOTS_JSON;
    else process.env.TOKSCALE_SCAN_ROOTS_JSON = inherited;
    childProcess.spawn = original; delete require.cache[collectorPath];
  }
});

test('default headless agent publishes History identity from the same successful graph without writing archives', async t => {
  const options = base(t, { historyEnabled: true, includeHistory: true, dailyHistoryArchiveEnabled: false,
    retainDeletedSessions: false, getSessionUsageArchive: () => { throw new Error('no migration read'); } });
  options.dailyHistoryArchiveOptions = { path: path.join(options.homeDir, 'must-not-exist.json') };
  const events = [event('shared', 4, 'native'), event('mirror-only', 5, 'mirror')];
  const summary = await collectUsageOnce({ ...options, runTokscale: async () => report(events), runGraph: async () => graph(events, {}) });
  assert.equal(summary.history.summary.totalTokens, 9);
  assert.deepEqual(summary.usageIdentity.history.events.map(e => e.id), events.map(e => e.id));
  assert.equal(summary.usageIdentity.history.events[1].observationKind, 'mirror');
  assert.equal(fs.existsSync(options.dailyHistoryArchiveOptions.path), false);
  assert.ok(normalizeUsageIdentity(summary.usageIdentity, summary).history);
});

test('a partial or aggregate-only graph never grants no-archive History claims', async t => {
  const options = base(t, { historyEnabled: true, includeHistory: true, dailyHistoryArchiveEnabled: false });
  const events = [event('A', 4)];
  for (const mode of ['partial', 'aggregate', 'identity-version']) {
    const current = graph(events, {});
    if (mode === 'partial') current.sourceUsage.scopes[0].readStatus = 'partial';
    else if (mode === 'aggregate') delete current.sourceUsage;
    else current.sourceUsage.eventIdentityVersion = 1;
    const summary = await collectUsageOnce({ ...options, runTokscale: async () => report(events), runGraph: async () => current });
    assert.equal(summary.history.summary.totalTokens, 4);
    assert.equal(summary.usageIdentity.history, undefined);
  }
});

async function waitFor(condition, timeoutMs = 4500) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'collector condition should complete within the live update window');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('no-archive runtime retains accepted Claude periods and History on partial full scans, then accepts exact downward corrections', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const options = base(t, { historyEnabled: true, retainDeletedSessions: false, dailyHistoryArchiveEnabled: false });
  const shared = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = options.homeDir;
  let mode = 'accepted';
  const records = [];
  const state = createDeviceState({ onRecord: record => records.push(record) });
  const events = () => [event('shared', mode === 'accepted' ? 100 : mode === 'partial' ? 20 : 10)];
  const readStatus = () => mode === 'partial' ? 'partial' : 'complete';
  const collector = startCollector({ ...options, clients: 'claude,gemini', watchEnabled: false, limitsEnabled: false, intervalMs: 300000,
    runTokscale: async () => {
      const current = report(events(), {}, { readStatus: readStatus() });
      current.entries.push({ client: 'gemini', sessionId: 'g', model: 'gemini-2.5-pro', input: mode === 'accepted' ? 3 : 7 });
      return current;
    }, runGraph: async () => {
      const current = graph(events(), {});
      current.sourceUsage.scopes[0].readStatus = readStatus();
      current.contributions[0].clients.push({ client: 'gemini', modelId: 'gemini-2.5-pro', tokens: { input: mode === 'accepted' ? 3 : 7 }, cost: 0, messages: 1 });
      return current;
    }, onUpdate: (summary, reason) => state.updateUsage(summary, reason),
    getSessionUsageArchive: () => { throw new Error('no archive read'); } });
  try {
    await collector.whenIdle();
    const accepted = records.at(-1);
    assert.equal(accepted.today.clients.claude, 100);
    assert.equal(accepted.history.summary.totalTokens, 103);
    mode = 'partial';
    await collector.tick('interval', { todayOnly: false, forceHistory: true });
    const retained = records.at(-1);
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(retained[name].clients.claude, 100, name);
      assert.equal(retained[name].clients.gemini, 7, 'other clients remain fresh');
      assert.deepEqual(retained.usageIdentity.periods[name], accepted.usageIdentity.periods[name]);
    }
    assert.equal(retained.history.summary.totalTokens, 107);
    assert.deepEqual(retained.usageIdentity.history, accepted.usageIdentity.history);
    assert.ok(normalizeUsageIdentity(retained.usageIdentity, retained).history);
    const saved = JSON.parse(fs.readFileSync(path.join(options.homeDir, 'collector-anchor.json'), 'utf8'));
    const seed = deviceRecordFromAnchor(saved, { ...options, clients: 'claude,gemini', platform: process.platform });
    assert.equal(seed.today.clients.claude, 100, 'partial full capture persists accepted counters in the existing anchor');
    assert.equal(seed.usageIdentity.periods.today.events[0].usage.totalTokens, 100);
    assert.equal(saved.noArchiveClaudeSnapshot.periods.today.totalTokens, 100);
    mode = 'corrected';
    await collector.tick('interval', { todayOnly: false, forceHistory: true });
    const corrected = records.at(-1);
    for (const name of ['today', 'month', 'allTime']) assert.equal(corrected[name].clients.claude, 10, name);
    assert.equal(corrected.history.summary.totalTokens, 17);
    assert.equal(corrected.usageIdentity.periods.today.events[0].usage.totalTokens, 10);
    assert.equal(corrected.usageIdentity.history.events[0].days[0].usage.tokens, 10);
    assert.equal(fs.existsSync(path.join(options.homeDir, 'daily-history-archive.json')), false);
  } finally {
    collector.stop(); await collector.whenIdle(); state.stop();
    if (shared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = shared;
  }
});

test('partial full scan at rollover derives accepted Claude windows from event days and drops proof across configuration changes', async t => {
  const options = base(t, { historyEnabled: true, dailyHistoryArchiveEnabled: false });
  const shared = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = options.homeDir;
  let clock = now;
  let partial = false;
  const records = [];
  const collector = startCollector({ ...options, now: () => clock, watchEnabled: false, limitsEnabled: false, intervalMs: 300000,
    runTokscale: async () => report([event('shared', partial ? 20 : 100)], {}, { readStatus: partial ? 'partial' : 'complete' }),
    runGraph: async () => {
      const current = graph([event('shared', partial ? 20 : 100)], {});
      if (partial) current.sourceUsage.scopes[0].readStatus = 'partial';
      return current;
    }, onUpdate: summary => { records.push(summary); } });
  try {
    await collector.whenIdle();
    partial = true;
    clock = new Date(2026, 9, 14, 12);
    await collector.tick('interval', { todayOnly: false, forceHistory: true });
    let retained = records.at(-1);
    assert.equal(retained.today.totalTokens, 0);
    assert.equal(retained.month.totalTokens, 100);
    assert.equal(retained.allTime.totalTokens, 100);
    assert.equal(retained.usageIdentity.periods.today, undefined);
    clock = new Date(2026, 10, 1, 12);
    await collector.tick('interval', { todayOnly: false, forceHistory: true });
    retained = records.at(-1);
    assert.equal(retained.today.totalTokens, 0);
    assert.equal(retained.month.totalTokens, 0);
    assert.equal(retained.allTime.totalTokens, 100);
    assert.equal(retained.history.summary.totalTokens, 100);
    assert.equal(retained.usageIdentity.periods.month, undefined);
    assert.equal(retained.usageIdentity.periods.allTime.events[0].usage.totalTokens, 100);
    let saved;
    saved = JSON.parse(fs.readFileSync(path.join(options.homeDir, 'collector-anchor.json'), 'utf8'));
    const changed = await collectUsageOnce({ ...options, now: clock, scanRoots: { claude: ['/new-source/.claude'] },
      noArchiveClaudeSnapshot: saved.noArchiveClaudeSnapshot, runTokscale: async () => report([event('new-config', 20)], {}, { readStatus: 'partial' }) });
    assert.equal(changed.allTime.totalTokens, 20);
    assert.equal(changed.usageIdentity, undefined);
  } finally {
    collector.stop(); await collector.whenIdle();
    if (shared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = shared;
  }
});

const nativeBinary = process.env.TOKEN_MONITOR_TEST_TOKSCALE_BINARY;
test('native lagging mirror cannot replace accepted no-archive usage when the original config root disappears',
  { skip: !nativeBinary }, async t => {
    const options = base(t, { historyEnabled: true, dailyHistoryArchiveEnabled: false, retainDeletedSessions: false });
    const shared = process.env.TOKEN_MONITOR_SHARED_DIR;
    const oldZone = process.env.TZ;
    process.env.TOKEN_MONITOR_SHARED_DIR = options.homeDir;
    process.env.TZ = 'UTC';
    const originalRoot = path.join(options.homeDir, 'original', '.claude');
    const mirrorDir = path.join(options.homeDir, '.claude', 'projects', 'ssh-s');
    const originalDir = path.join(originalRoot, 'projects', '-work');
    fs.mkdirSync(mirrorDir, { recursive: true });
    fs.mkdirSync(originalDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const transcript = input => JSON.stringify({ type: 'assistant', timestamp, requestId: 'req',
      message: { id: 'msg', model: 'claude-sonnet-4-20250514', usage: { input_tokens: input, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n';
    fs.writeFileSync(path.join(mirrorDir, 's.jsonl'), transcript(20));
    fs.writeFileSync(path.join(originalDir, 's.jsonl'), transcript(100));
    const cacheDir = path.join(options.homeDir, '.config', 'tokscale', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Keep this native regression offline, including native pricing lookup.
    for (const name of ['litellm', 'openrouter', 'models-dev']) fs.writeFileSync(path.join(cacheDir, `pricing-${name}.json`),
      JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), data: {
        [name === 'models-dev' ? 'anthropic/claude-sonnet-4-20250514' : 'claude-sonnet-4-20250514']:
          { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 } } }));
    const env = { ...process.env, HOME: options.homeDir, USERPROFILE: options.homeDir, XDG_CONFIG_HOME: path.join(options.homeDir, '.config'),
      TOKSCALE_SCAN_ROOTS_JSON: JSON.stringify({ claude: [originalRoot] }), TZ: 'UTC' };
    const scan = input => JSON.parse(execFileSync(nativeBinary,
      ['--json', '--client', input.clients, '--group-by', 'client,session,model', ...input.flags, '--source-snapshots'],
      { env, timeout: 20000, encoding: 'utf8' }));
    const scanGraph = input => JSON.parse(execFileSync(nativeBinary, ['graph', '--client', input.clients, '--source-snapshots'],
      { env, timeout: 20000, encoding: 'utf8' }));
    const state = createDeviceState();
    const records = [];
    const collector = startCollector({ ...options, now: () => new Date(), scanRoots: { claude: [originalRoot] },
      watchEnabled: false, limitsEnabled: false, intervalMs: 300000, runTokscale: scan, runGraph: scanGraph,
      onUpdate: (summary, reason) => { const record = state.updateUsage(summary, reason); records.push(record); } });
    try {
      await collector.whenIdle();
      assert.equal(records.at(-1).today.totalTokens, 100);
      assert.equal(records.at(-1).history.summary.totalTokens, 100);
      assert.ok(records.at(-1).usageIdentity.history);
      fs.renameSync(originalRoot, `${originalRoot}-unavailable`);
      await collector.tick('interval', { todayOnly: false, forceHistory: true });
      const retained = records.at(-1);
      for (const name of ['today', 'month', 'allTime']) assert.equal(retained[name].totalTokens, 100, name);
      assert.equal(retained.history.summary.totalTokens, 100);
      assert.deepEqual(retained.usageIdentity, records[0].usageIdentity);
      fs.renameSync(`${originalRoot}-unavailable`, originalRoot);
      fs.writeFileSync(path.join(originalDir, 's.jsonl'), transcript(40));
      await collector.tick('interval', { todayOnly: false, forceHistory: true });
      for (const name of ['today', 'month', 'allTime']) assert.equal(records.at(-1)[name].totalTokens, 40, name);
      assert.equal(records.at(-1).history.summary.totalTokens, 40);
    } finally {
      collector.stop(); await collector.whenIdle(); state.stop();
      if (shared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR; else process.env.TOKEN_MONITOR_SHARED_DIR = shared;
      if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone;
    }
  });

test('cached acknowledged UNC originals trigger warm today scans alongside host mirrors and refresh on root changes', async t => {
  const options = base(t, { platform: 'win32', wslScanEnabled: true });
  const mirror = path.join(options.homeDir, '.claude', 'projects');
  fs.mkdirSync(mirror, { recursive: true });
  const originalWatch = require('chokidar').watch;
  const originalShared = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = options.homeDir;
  const watches = [];
  require('chokidar').watch = (dirs, watchOptions) => {
    const watcher = new EventEmitter();
    watcher.close = () => {};
    watches.push({ dirs, options: watchOptions, watcher });
    return watcher;
  };
  let root = '\\\\wsl$\\Ubuntu,Dev\\home\\alice\\.claude';
  let discoveries = 0;
  const calls = [];
  const updates = [];
  const collector = startCollector({ ...options, watchEnabled: true, limitsEnabled: false,
    intervalMs: 300000, onUpdate: value => updates.push(value),
    discoverWslUsage: () => { discoveries++; return { homes: [], clientsByHome: {}, claudeRoots: [root], state: 'ok' }; },
    runTokscale: async input => {
      calls.push(input);
      return report([event('original', calls.length)], input.scanRoots);
    } });
  try {
    await collector.whenIdle();
    assert.equal(discoveries, 1);
    assert.equal(calls.length, 3);
    const active = watches.at(-1);
    assert.ok(active.dirs.includes(root), 'acknowledged original admitted without a path-presence gate');
    assert.ok(active.dirs.includes(canonicalWatchPath(mirror)), 'host mirrors stay watched');
    assert.equal(active.options.usePolling, false);
    const transcript = path.join(root, 'projects', 'project', 's.jsonl');
    assert.notEqual(active.options.ignored?.(transcript), true);
    const updatedAt = updates.length;
    const startedAt = Date.now();
    active.watcher.emit('all', 'change', transcript);
    await waitFor(() => updates.length > updatedAt);
    await collector.whenIdle();
    assert.ok(Date.now() - startedAt < 5000);
    assert.equal(discoveries, 1, 'warm native scan must not discover WSL');
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.at(-1).flags, ['--today']);
    assert.deepEqual(calls.at(-1).scanRoots, { claude: [root] });
    root = '\\\\wsl$\\Ubuntu,Dev\\home\\bob\\.claude';
    await collector.tick('manual');
    assert.equal(discoveries, 2);
    assert.equal(calls.length, 7);
    assert.ok(watches.at(-1).dirs.includes(root));
    assert.equal(watches.at(-1).dirs.includes('\\\\wsl$\\Ubuntu,Dev\\home\\alice\\.claude'), false);
  } finally {
    collector.stop(); await collector.whenIdle();
    require('chokidar').watch = originalWatch;
    if (originalShared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalShared;
  }
});

test('unsupported original network watches safely retry polling then report interval fallback', async t => {
  const options = base(t, { platform: 'win32', wslScanEnabled: true });
  const root = '\\\\wsl$\\Ubuntu\\home\\alice\\.claude';
  const originalWatch = require('chokidar').watch;
  const originalShared = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = options.homeDir;
  const watches = [];
  const diagnostics = [];
  require('chokidar').watch = (_dirs, watchOptions) => {
    const watcher = new EventEmitter();
    watcher.close = () => {};
    watches.push({ watcher, options: watchOptions });
    return watcher;
  };
  const collector = startCollector({ ...options, watchEnabled: true, limitsEnabled: false,
    discoverWslUsage: () => ({ homes: [], clientsByHome: {}, claudeRoots: [root], state: 'ok' }),
    runTokscale: async input => report([event('A', 4)], input.scanRoots), onDiagnosticEvent: e => diagnostics.push(e) });
  try {
    await collector.whenIdle();
    watches.at(-1).watcher.emit('error', Object.assign(new Error('network watch unsupported'), { code: 'ENOTSUP' }));
    await waitFor(() => watches.at(-1).options.usePolling === true);
    assert.equal(collector.getDiagnostics().watchMode, 'polling');
    watches.at(-1).watcher.emit('error', Object.assign(new Error('network polling inaccessible'), { code: 'EACCES' }));
    assert.equal(collector.getDiagnostics().watchMode, 'interval');
    assert.equal(collector.getDiagnostics().intervalMs, 300000);
    assert.ok(diagnostics.some(e => e.code === 'watcher-interval-fallback' && e.detailCode === 'EACCES'));
  } finally {
    collector.stop(); await collector.whenIdle();
    require('chokidar').watch = originalWatch;
    if (originalShared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalShared;
  }
});

for (const freshTokens of [20, 15]) {
  test(`cached retained ledger cannot claim a fresh disjoint native full capture at ${freshTokens} tokens`, async t => {
    const { aggregateDevices } = require('../../src/shared/usage');
    const { syncPayload } = require('../../src/shared/syncPayload');
    const options = base(t, { historyEnabled: true, includeHistory: true, dailyHistoryArchiveEnabled: true,
      getSessionUsageArchive: () => ({ version: 1, sessions: {} }) });
    options.dailyHistoryArchiveOptions = { path: path.join(options.homeDir, 'daily.json') };
    let projection;
    const original = [event('A', 15, 'mirror')];
    await collectUsageOnce({ ...options, onSourceArchiveComputed: value => { projection = value; },
      runTokscale: async () => report(original), runGraph: async () => graph(original, {}) });
    const fresh = await collectUsageOnce({ ...options, includeHistory: false, sourceArchiveSnapshot: projection,
      runTokscale: async () => report([event('B', freshTokens, 'mirror')]),
      runGraph: () => { throw new Error('native full refresh must not read History'); } });
    const peer = await collectUsageOnce({ ...base(t), deviceId: 'remote',
      runTokscale: async () => report([event('A', 15, 'native')]) });
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(fresh[name].totalTokens, freshTokens, 'cached projection keeps fresh native counters');
      assert.deepEqual(fresh.usageIdentity.periods[name].events.map(e => e.id), [id('B')], 'proof certifies the fresh native revision');
    }
    const at = now.getTime();
    for (const records of [[fresh, peer], [syncPayload(fresh), syncPayload(peer)]]) {
      const aggregate = aggregateDevices(records, 600000, at);
      for (const name of ['today', 'month', 'allTime']) assert.equal(aggregate.periods[name].totalTokens, freshTokens + 15);
    }
  });
}

test('healthy History-disabled full ticks retain unchanged native proof across all periods and warm deltas', async t => {
  const { aggregateDevices } = require('../../src/shared/usage');
  const { syncPayload } = require('../../src/shared/syncPayload');
  const options = base(t, { historyEnabled: true, includeHistory: true, dailyHistoryArchiveEnabled: true,
    getSessionUsageArchive: () => ({ version: 1, sessions: {} }) });
  options.dailyHistoryArchiveOptions = { path: path.join(options.homeDir, 'daily.json') };
  let projection;
  const original = [event('A', 15, 'mirror')];
  await collectUsageOnce({ ...options, onSourceArchiveComputed: value => { projection = value; },
    runTokscale: async () => report(original), runGraph: async () => graph(original, {}) });
  let captured;
  const fresh = await collectUsageOnce({ ...options, includeHistory: false, sourceArchiveSnapshot: projection,
    onAnchorComputed: value => { captured = value; }, runTokscale: async () => report(original),
    runGraph: () => { throw new Error('no interval graph'); } });
  let scans = 0;
  const warm = await collectUsageOnce({ ...options, includeHistory: false, sourceArchiveSnapshot: projection,
    todayOnlyAnchor: anchorOf(captured), runTokscale: async input => {
      scans++; assert.deepEqual(input.flags, ['--today']); return report(original);
    }, runGraph: () => { throw new Error('no warm graph'); } });
  assert.equal(scans, 1);
  const peer = await collectUsageOnce({ ...base(t), deviceId: 'remote', runTokscale: async () => report([event('A', 15)]) });
  for (const record of [fresh, warm]) {
    for (const name of ['today', 'month', 'allTime']) assert.deepEqual(record.usageIdentity.periods[name].events.map(e => e.id), [id('A')]);
    for (const pair of [[record, peer], [syncPayload(record), syncPayload(peer)]]) {
      const result = aggregateDevices(pair, 600000, now.getTime());
      for (const name of ['today', 'month', 'allTime']) assert.equal(result.periods[name].totalTokens, 15);
    }
  }
});

for (const mixed of [false, true]) {
  test(`History-disabled full capture claims selected retained A alongside ${mixed ? 'fresh B' : 'empty native usage'}`, async t => {
    const { aggregateDevices } = require('../../src/shared/usage');
    const workerUsage = require('../../worker/src/shared/usage');
    const { syncPayload } = require('../../src/shared/syncPayload');
    const options = base(t, { historyEnabled: true, includeHistory: true, dailyHistoryArchiveEnabled: true,
      getSessionUsageArchive: () => ({ version: 1, sessions: {} }) });
    options.dailyHistoryArchiveOptions = { path: path.join(options.homeDir, 'daily.json') };
    let projection;
    await collectUsageOnce({ ...options, onSourceArchiveComputed: value => { projection = value; },
      runTokscale: async () => report([event('A', 15, 'mirror')]), runGraph: async () => graph([event('A', 15, 'mirror')], {}) });
    const freshReport = () => {
      const result = report(mixed ? [event('B', 20, 'mirror')] : []);
      for (const row of result.entries) row.sessionId = 'fresh-session';
      for (const row of result.sourceUsage.sessions) row.sessionId = 'fresh-session';
      return result;
    };
    let captured;
    const selected = await collectUsageOnce({ ...options, includeHistory: false, sourceArchiveSnapshot: projection,
      onAnchorComputed: value => { captured = value; },
      runTokscale: async () => freshReport(), runGraph: () => { throw new Error('no interval graph'); } });
    const warm = await collectUsageOnce({ ...options, includeHistory: false, sourceArchiveSnapshot: projection,
      todayOnlyAnchor: anchorOf(captured), runTokscale: async input => {
        assert.deepEqual(input.flags, ['--today']); return freshReport();
      }, runGraph: () => { throw new Error('no warm graph'); } });
    const peer = await collectUsageOnce({ ...base(t), deviceId: 'remote', runTokscale: async () => report([event('A', 15)]) });
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(selected[name].totalTokens, mixed ? 35 : 15);
      assert.deepEqual(new Set(selected.usageIdentity.periods[name].events.map(e => e.id)), new Set(mixed ? [id('A'), id('B')] : [id('A')]));
    }
    for (const record of [selected, warm]) for (const hub of [{ aggregateDevices }, workerUsage]) for (const pair of [[record, peer], [syncPayload(record), syncPayload(peer)]]) {
      const result = hub.aggregateDevices(pair, 600000, now.getTime());
      for (const name of ['today', 'month', 'allTime']) assert.equal(result.periods[name].totalTokens, mixed ? 35 : 15);
    }
  });
}

test('full retained timed events preserve root-bound period proof without enabling model throughput', async t => {
  const { aggregateDevices } = require('../../src/shared/usage');
  const workerUsage = require('../../worker/src/shared/usage');
  const { syncPayload } = require('../../src/shared/syncPayload');
  const options = base(t, { historyEnabled: true, includeHistory: true, dailyHistoryArchiveEnabled: true,
    getSessionUsageArchive: () => ({ version: 1, sessions: {} }) });
  options.dailyHistoryArchiveOptions = { path: path.join(options.homeDir, 'daily.json') };
  const timed = event('A', 80, 'mirror');
  timed.contributions[0].tokens.output = 20;
  timed.contributions[0].performance = { timedTokens: 100, timedOutputTokens: 20, totalDurationMs: 1000 };
  const timedReport = events => {
    const result = report(events);
    for (const row of result.entries) Object.assign(row, { output: 20, performance: timed.contributions[0].performance });
    return result;
  };
  let projection;
  const first = await collectUsageOnce({ ...options, onSourceArchiveComputed: value => { projection = value; },
    runTokscale: async () => timedReport([timed]), runGraph: async () => graph([timed], {}) });
  const retained = await collectUsageOnce({ ...options, sourceArchiveSnapshot: projection,
    runTokscale: async () => report([]), runGraph: async () => graph([], {}) });
  const native = structuredClone(timed);
  native.observationKind = 'native';
  const peer = await collectUsageOnce({ ...base(t), deviceId: 'remote', runTokscale: async () => timedReport([native]) });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(first.usageIdentity.periods[name].events.length, 1);
    assert.equal(retained[name].totalTokens, 100);
    assert.equal(retained[name].timedTokens, 100);
    assert.equal(retained[name].modelThroughput, undefined);
    assert.equal(retained[name].capabilities.throughput, false);
    assert.equal(retained.usageIdentity.periods[name].events.length, 1);
  }
  assert.equal(retained.usageIdentity.history.events.length, 1);
  for (const hub of [{ aggregateDevices }, workerUsage]) {
    const result = hub.aggregateDevices([syncPayload(retained), syncPayload(peer)], 600000, now.getTime());
    for (const name of ['today', 'month', 'allTime']) assert.equal(result.periods[name].totalTokens, 100);
  }
});
