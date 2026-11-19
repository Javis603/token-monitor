'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite = require('node:sqlite');
const { readT3SessionParents, readT3SessionRelations, readT3SessionRelationResult } = require('../../src/shared/t3SessionMetadata');
const { applySessionMetadata, applyT3SessionParents, applySessionIdentities } = require('../../src/shared/sessionMetadata');
const { normalizePeriod, mergePeriods, extractUsageFromTokscale, stripSessionTextFromPeriod } = require('../../src/shared/usage');

function store(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-t3-parents-'));
  const dir = path.join(home, '.t3', 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'statev2.sqlite');
  const db = new sqlite.DatabaseSync(file);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT PRIMARY KEY, thread_id TEXT, root_node_id TEXT, kind TEXT, provider_thread_id TEXT);
  `);
  const thread = (id, parent, relationship = 'subagent') => db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, NULL, ?)').run(
    id, 'New thread', JSON.stringify({ lineage: { parentThreadId: parent || null, relationshipToParent: parent ? relationship : null } })
  );
  const provider = (id, app, nativeId, driver = 'codex', strength = 'strong', instanceId) => db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)').run(
    id, app, driver, JSON.stringify({ providerInstanceId: instanceId, nativeThreadRef: { nativeId, driver, strength } })
  );
  const delegation = (childProvider, parentProvider, parentApp, id = childProvider) => {
    db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?)').run(`root-${id}`, parentApp, `root-${id}`, 'root_turn', parentProvider);
    db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?)').run(`task-${id}`, parentApp, `root-${id}`, 'subagent', childProvider);
    db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.forkedFrom', json(?)) WHERE thread_id = (SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ?)").run(JSON.stringify({ type: 'node', nodeId: `task-${id}` }), childProvider);
  };
  const read = (ids) => readT3SessionParents(ids, { homeDir: home, env: {} });
  return { home, db, file, thread, provider, delegation, read };
}

function pair(s, childDriver = 'claudeAgent', parentDriver = 'codex') {
  s.thread('parent');
  s.thread('child', 'parent');
  s.provider('launch-provider', 'parent', 'parent-native', parentDriver);
  s.provider('child-provider', 'child', 'child-native', childDriver);
  s.delegation('child-provider', 'launch-provider', 'parent');
}

function registry(s, instances) {
  fs.writeFileSync(path.join(path.dirname(s.file), 'settings.json'), JSON.stringify({ providerInstances: instances }));
}

test('ACP agent identity comes from its configured instance, with mixed-provider delegation and exact opaque ids', t => {
  const s = store(t);
  registry(s, { arbitrary: { driver: 'acpRegistry', config: { agentId: 'devin' } } });
  s.thread('parent'); s.thread('child', 'parent');
  s.provider('launch-provider', 'parent', 'parent-native');
  s.provider('main-devin', 'parent', 'like-paperback', 'acpRegistry', 'strong', 'arbitrary');
  s.provider('child-provider', 'child', 'bird-notebook', 'acpRegistry', 'strong', 'arbitrary');
  s.delegation('child-provider', 'launch-provider', 'parent'); runningTask(s);
  const periods = { month: normalizePeriod({ sessions: {
    a: { client: 'codex', sessionId: 'parent-native', totalTokens: 10, costUsd: 1, lastUsedAt: new Date().toISOString() },
    b: { client: 'devin', sessionId: 'like-paperback', totalTokens: 20, costUsd: 2, lastUsedAt: new Date().toISOString() },
    c: { client: 'devin', sessionId: 'bird-notebook', totalTokens: 30, costUsd: 3, lastUsedAt: new Date().toISOString() }
  } }) };
  const before = Object.entries(periods.month.sessions).map(([key, row]) => [key, row.totalTokens, row.costUsd]);
  applyT3SessionParents(periods, s.home, { env: {} });
  const ss = periods.month.sessions;
  assert.equal(ss['devin:like-paperback'].t3ThreadId, 'parent');
  assert.equal(ss['devin:bird-notebook'].t3ThreadId, 'child');
  assert.equal(ss['devin:bird-notebook'].parentSessionId, 'parent-native');
  assert.equal(ss['devin:bird-notebook'].parentClient, 'codex');
  const wire = normalizePeriod(periods.month);
  assert.equal(wire.sessions['devin:bird-notebook'].t3ThreadId, 'child');
  assert.equal(mergePeriods(wire).sessions['devin:like-paperback'].t3ThreadId, 'parent');
  assert.deepEqual(Object.entries(ss).map(([key, row]) => [key, row.totalTokens, row.costUsd]), before);
  const dock = require('../../src/electron/renderer/edgeDock/presentation');
  const grouped = dock.recentSessionRows({ periods }, 100);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].groupRows.length, 3);
  assert.equal(grouped[0].subagentCount, 1);
  assert.equal(grouped[0].totalTokens, 60);
  assert.equal(grouped[0].costUsd, 6);
  delete ss['codex:parent-native']; delete ss['devin:bird-notebook'].parentSessionId; delete ss['devin:bird-notebook'].parentClient;
  applyT3SessionParents(periods, s.home, { env: {} });
  assert.equal(ss['devin:bird-notebook'].parentSessionId, 'like-paperback', 'visible main provider switch is a proven parent');
});

for (const driver of ['cursor', 'opencode', 'grok', 'muse']) {
  test(`T3 ${driver} uses shared delegation without changing the accounting client`, t => {
    const s = store(t); pair(s, driver, driver);
    assert.deepEqual(s.read(['child-native']), new Map([[`${driver}:child-native`, {
      parentClient: driver, parentNativeId: 'parent-native'
    }]]));
  });
}

test('registry instances with identical native ids stay in distinct accounting client spaces', t => {
  const s = store(t);
  registry(s, { a: { driver: 'acpRegistry', config: { agentId: 'devin' } }, b: { driver: 'acpRegistry', config: { agentId: 'opencode' } } });
  s.thread('devin-main'); s.thread('open-main');
  s.provider('a', 'devin-main', 'opaque-native', 'acpRegistry', 'strong', 'a');
  s.provider('b', 'open-main', 'opaque-native', 'acpRegistry', 'strong', 'b');
  const read = () => readT3SessionRelations(['opaque-native'], { homeDir: s.home, env: {} });
  assert.equal(read().get('devin:opaque-native').threadId, 'devin-main');
  assert.equal(read().get('opencode:opaque-native').threadId, 'open-main');
  s.thread('conflict'); s.provider('conflict', 'conflict', 'opaque-native', 'acpRegistry', 'strong', 'a');
  assert.equal(read().has('devin:opaque-native'), false);
  assert.equal(read().get('opencode:opaque-native').threadId, 'open-main');
});

test('ACP configuration, strong native references and explicit lineage are all required', async t => {
  for (const [name, config] of [
    ['missing instance', null], ['local command', { agentId: 'devin', source: 'local' }],
    ['executable override', { agentId: 'devin', commandPath: '/custom/devin' }],
    ['unknown registry agent', { agentId: 'unknown' }], ['prototype key', { agentId: 'constructor' }]
  ]) await t.test(name, t => {
    const s = store(t); s.thread('parent'); s.thread('child', 'parent');
    if (config) registry(s, { acpRegistry_devin: { driver: 'acpRegistry', config } });
    s.provider('launch-provider', 'parent', 'parent-native');
    s.provider('child-provider', 'child', 'bird-notebook', 'acpRegistry', 'strong', 'acpRegistry_devin');
    s.delegation('child-provider', 'launch-provider', 'parent');
    assert.equal(readT3SessionRelations(['bird-notebook'], { homeDir: s.home, env: {} }).size, 0);
  });
  const s = store(t);
  registry(s, { a: { driver: 'acpRegistry', config: { agentId: 'devin' } } });
  s.thread('fork', 'parent', 'fork');
  s.provider('fork', 'fork', 'bird-notebook', 'acpRegistry', 'strong', 'a');
  assert.equal(s.read(['bird-notebook']).size, 0);
  assert.equal(readT3SessionRelations(['BIRD-NOTEBOOK'], { homeDir: s.home, env: {} }).size, 0, 'opaque identities are case sensitive');
});

test('accepted opaque ACP run identities survive native replacement with provider/root ownership validation', t => {
  const s = store(t); s.thread('main');
  registry(s, { a: { driver: 'acpRegistry', config: { agentId: 'devin' } } });
  s.provider('provider', 'main', 'current-native', 'acpRegistry', 'strong', 'a');
  s.db.exec(`CREATE TABLE orchestration_v2_projection_run_attempts (
    thread_id TEXT, provider_thread_id TEXT, root_node_id TEXT, status TEXT, payload_json TEXT)`);
  s.db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?)').run('root', 'main', 'root', 'root_turn', 'provider');
  const insert = s.db.prepare('INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, ?, ?)');
  insert.run('main', 'provider', 'root', 'completed', JSON.stringify({ nativeThreadId: 'old-native' }));
  insert.run('main', 'provider', 'root', 'queued', JSON.stringify({ nativeThreadId: 'queued-native' }));
  insert.run('other', 'provider', 'root', 'completed', JSON.stringify({ nativeThreadId: 'other-native' }));
  const facts = readT3SessionRelations(['old-native', 'current-native', 'queued-native', 'other-native'], { homeDir: s.home, env: {} });
  assert.deepEqual([...facts.keys()].sort(), ['devin:current-native', 'devin:old-native']);
});

test('T3 delegation binds the launch provider, with Codex and Claude cross-provider children', (t) => {
  const s = store(t);
  pair(s);
  s.provider('later-provider', 'parent', 'later-native', 'claudeAgent');
  s.thread('nested', 'child');
  s.provider('nested-provider', 'nested', 'nested-native');
  s.delegation('nested-provider', 'child-provider', 'child');
  assert.deepEqual(s.read(['child-native', 'nested-native', 'child', 'shared-provider-session']), new Map([
    ['claude:child-native', { parentClient: 'codex', parentNativeId: 'parent-native' }],
    ['codex:nested-native', { parentClient: 'claude', parentNativeId: 'child-native' }]
  ]));
});

test('T3 forks, invalid lineage, tombstones and unverifiable identities supply no parent link', async (t) => {
  const cases = [
    ['human fork', "UPDATE orchestration_v2_projection_threads SET payload_json = '{\"lineage\":{\"parentThreadId\":\"parent\",\"relationshipToParent\":\"fork\"}}' WHERE thread_id = 'child'"],
    ['malformed child', "UPDATE orchestration_v2_projection_threads SET payload_json = 'invalid' WHERE thread_id = 'child'"],
    ['child tombstone', "UPDATE orchestration_v2_projection_threads SET deleted_at = 'deleted' WHERE thread_id = 'child'"],
    ['parent tombstone', "UPDATE orchestration_v2_projection_threads SET deleted_at = 'deleted' WHERE thread_id = 'parent'"],
    ['wrong launching thread', "UPDATE orchestration_v2_projection_nodes SET thread_id = 'unrelated' WHERE kind = 'subagent'"],
    ['missing delegation reference', "UPDATE orchestration_v2_projection_threads SET payload_json = json_remove(payload_json, '$.forkedFrom') WHERE thread_id = 'child'"],
    ['wrong delegation reference', "UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.forkedFrom.nodeId', 'missing') WHERE thread_id = 'child'"],
    ['missing execution root', "DELETE FROM orchestration_v2_projection_nodes WHERE kind = 'root_turn'"],
    ['weak native identity', "UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef.strength', 'weak') WHERE provider_thread_id = 'child-provider'"],
    ['driver mismatch', "UPDATE orchestration_v2_projection_provider_threads SET driver = 'codex' WHERE provider_thread_id = 'child-provider'"],
    ['unsupported driver', "UPDATE orchestration_v2_projection_provider_threads SET driver = 'acpRegistry', payload_json = json_set(payload_json, '$.nativeThreadRef.driver', 'acpRegistry') WHERE provider_thread_id = 'child-provider'"]
  ];
  for (const [name, mutation] of cases) await t.test(name, (t) => {
    const s = store(t); pair(s); s.db.exec(mutation);
    assert.equal(s.read(['child-native']).size, 0);
  });
});

test('ambiguous native attribution fails closed; missing and incompatible stores are harmless', (t) => {
  const s = store(t); pair(s);
  s.thread('other'); s.provider('other-provider', 'other', 'other-native');
  // Two app-owned children claiming the same native identity disagree about its parent.
  s.thread('other-child', 'other');
  s.provider('other-child-provider', 'other-child', 'child-native', 'claudeAgent');
  s.delegation('other-child-provider', 'other-provider', 'other', 'contradiction');
  assert.equal(s.read(['child-native']).size, 0);
  assert.equal(readT3SessionParents(['child-native'], { t3DbPaths: [path.join(s.home, 'missing')] }).size, 0);
  s.db.exec('DROP TABLE orchestration_v2_projection_nodes');
  assert.equal(s.read(['child-native']).size, 0);
});

test('app parent enrichment is independent of titles and resolves period-specific rollout identities', (t) => {
  const s = store(t); pair(s);
  const native = '019a0000-1234-7000-8000-000000000001';
  s.db.prepare("UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef.nativeId', ?) WHERE provider_thread_id = 'launch-provider'").run(native);
  const row = (client, sessionId, totalTokens, startedAt) => ({ client, sessionId, totalTokens, costUsd: totalTokens / 100, startedAt, title: 'native label', turnEnded: false });
  const old = `rollout-2026-10-01T00-00-00-${native}`;
  const current = `rollout-2026-10-11T00-00-00-${native}`;
  const periods = {
    today: normalizePeriod({ sessions: { c: row('claude', 'child-native', 20), p: row('codex', current, 30) } }),
    month: normalizePeriod({ sessions: { c: row('claude', 'child-native', 50), p: row('codex', old, 100) } })
  };
  periods.today.sessions['claude:child-native'].turnEnded = false;
  const before = JSON.stringify(periods);
  const resolver = () => new Map([['child-native', { titleOnly: true, title: 'catalog label' }]]);
  applySessionMetadata(periods, s.home, { env: {}, sessionMetadataResolvers: new Map([['claude', resolver]]) });
  assert.equal(periods.today.sessions['claude:child-native'].parentSessionId, current);
  assert.equal(periods.month.sessions['claude:child-native'].parentSessionId, old);
  assert.equal(periods.today.sessions['claude:child-native'].parentClient, 'codex');
  assert.equal(periods.today.sessions['claude:child-native'].turnEnded, false);
  for (const name of ['today', 'month']) {
    const previous = JSON.parse(before)[name];
    for (const [key, session] of Object.entries(periods[name].sessions)) {
      assert.equal(session.totalTokens, previous.sessions[key].totalTokens);
      assert.equal(session.costUsd, previous.sessions[key].costUsd);
    }
  }
  periods.today.sessions['claude:child-native'].parentSessionId = 'native-authoritative';
  delete periods.today.sessions['claude:child-native'].parentClient;
  applyT3SessionParents(periods, s.home, { env: {} });
  assert.equal(periods.today.sessions['claude:child-native'].parentSessionId, 'native-authoritative');
  assert.equal(periods.today.sessions['claude:child-native'].parentClient, undefined);
});

test('broader-period parent supplies a safe orphan link; absent native parent never creates a fake session', (t) => {
  const s = store(t); pair(s);
  const periods = { today: normalizePeriod({ sessions: { c: { client: 'claude', sessionId: 'child-native', totalTokens: 20 } } }) };
  applyT3SessionParents(periods, s.home, { env: {} });
  assert.equal(periods.today.sessions['claude:child-native'].parentSessionId, undefined);
  periods.month = normalizePeriod({ sessions: { p: { client: 'codex', sessionId: 'parent-native', totalTokens: 30 } } });
  applyT3SessionParents(periods, s.home, { env: {} });
  assert.equal(periods.today.sessions['claude:child-native'].parentSessionId, 'parent-native');
  assert.equal(Object.keys(periods.today.sessions).length, 1);
});

test('cross-client links survive normalization, merge and title scrubbing without double accounting', () => {
  const input = { sessions: {
    c: { client: 'claude', sessionId: 'same-id', parentSessionId: 'same-id', parentClient: 'codex', totalTokens: 20, costUsd: 2, title: 'local only' },
    p: { client: 'codex', sessionId: 'same-id', totalTokens: 30, costUsd: 3 }
  } };
  const period = normalizePeriod(input);
  assert.equal(period.sessions['claude:same-id'].parentClient, 'codex');
  const scrubbed = stripSessionTextFromPeriod(period);
  assert.equal(scrubbed.sessions['claude:same-id'].title, undefined);
  assert.equal(scrubbed.sessions['claude:same-id'].parentClient, 'codex');
  const merged = mergePeriods(period, period);
  assert.equal(merged.sessions['claude:same-id'].totalTokens, 40);
  assert.equal(merged.sessions['codex:same-id'].totalTokens, 60);
  assert.equal(merged.sessions['claude:same-id'].parentClient, 'codex');
  const extracted = extractUsageFromTokscale({ entries: [{ client: 'claude', sessionId: 'same-id', parentSessionId: 'same-id', parentClient: 'codex', tokens: 20 }] });
  assert.equal(extracted.sessions['claude:same-id'].parentClient, 'codex');
  assert.equal(normalizePeriod({ sessions: { self: { client: 'claude', sessionId: 'same-id', parentSessionId: 'same-id' } } }).sessions['claude:same-id'].parentSessionId, undefined);
});

test('watch delta links a new child to an older idle parent without rescanning history or changing totals', async (t) => {
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const s = store(t); pair(s);
  let captured;
  let watchTick = false;
  const calls = [];
  const options = {
    clients: 'codex,claude', homeDir: s.home, projectsEnabled: false, historyEnabled: false,
    wslScanEnabled: false, osInfo: {}, env: {},
    sessionMetadataDeps: { scopedHome: true, sessionMetadataResolvers: new Map() },
    onAnchorComputed: (value) => { captured = value; },
    runTokscale: async ({ flags }) => {
      calls.push(flags);
      const entries = [];
      if (!flags.includes('--today')) entries.push({ client: 'codex', sessionId: 'parent-native', model: 'gpt', input: 100, cost: 1 });
      if (watchTick) entries.push({ client: 'claude', sessionId: 'child-native', model: 'claude', input: 20, cost: 0.2 });
      return { entries };
    }
  };
  const initial = await collectUsageOnce(options);
  const anchor = { dateKey: localTodayKey(), today: initial.today, month: initial.month, allTime: initial.allTime, todayPartitions: captured.todayPartitions };
  watchTick = true;
  calls.length = 0;
  const next = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['--today']);
  assert.equal(next.today.totalTokens, 20);
  assert.equal(next.month.totalTokens, 120);
  assert.equal(next.allTime.totalTokens, 120);
  assert.equal(next.month.costUsd, 1.2);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(next[name].sessions['claude:child-native'].parentSessionId, 'parent-native');
    assert.equal(next[name].sessions['claude:child-native'].parentClient, 'codex');
  }
  assert.equal(next.today.sessions['codex:parent-native'], undefined);
  assert.equal(initial.month.sessions['claude:child-native'], undefined);
});

test('pre-token activity rows receive T3 links without mutating accounting snapshots or entering sync', async (t) => {
  const { refreshSessionActivity } = require('../../src/shared/sessionActivityRegistry');
  const { normalizeDeviceRecord } = require('../../src/shared/usage');
  const s = store(t); pair(s);
  const summary = {
    deviceId: 'local',
    today: normalizePeriod({ sessions: { p: { client: 'codex', sessionId: 'parent-native', totalTokens: 30 } } }),
    nativeSessions: { today: { 'claude:child-native': { client: 'claude', sessionId: 'child-native', totalTokens: 0, title: 'local child' } } }
  };
  const before = JSON.stringify(summary);
  const next = await refreshSessionActivity(summary, [], { sessionMetadataDeps: { scopedHome: true } }, { homeDir: s.home, env: {} });
  assert.equal(next.nativeSessions.today['claude:child-native'].parentSessionId, 'parent-native');
  assert.equal(next.nativeSessions.today['claude:child-native'].parentClient, 'codex');
  assert.equal(JSON.stringify(summary), before);
  assert.equal(next.today, summary.today);
  const wire = normalizeDeviceRecord(next);
  assert.equal(wire.nativeSessions, undefined);
  assert.equal(wire.periods.today.sessions['claude:child-native'], undefined);
  assert.equal(wire.periods.today.sessions['codex:parent-native'].totalTokens, 30);
});

for (const client of ['codex', 'claude']) {
  test(`${client} unchanged pre-token activity keeps its linked snapshot between renewals`, async (t) => {
    const { refreshSessionActivity } = require('../../src/shared/sessionActivityRegistry');
    const adapter = require(`../../src/shared/providers/${client}/sessionActivity`);
    const s = store(t);
    pair(s, client === 'codex' ? 'codex' : 'claudeAgent', client === 'codex' ? 'claudeAgent' : 'codex');
    const parentClient = client === 'codex' ? 'claude' : 'codex';
    const clock = Date.now();
    const native = { client, sessionId: 'child-native', totalTokens: 0, costUsd: 0,
      lastUsedAt: new Date(clock).toISOString(), liveActivity: { state: 'running', observedAt: new Date(clock).toISOString() } };
    const summary = { today: normalizePeriod({ sessions: { p: { client: parentClient, sessionId: 'parent-native', totalTokens: 30 } } }) };
    const entry = { metadataDepsKey: `${client}MetadataDeps`, read: async () => ({ readings: new Map(), sessions: { [`${client}:child-native`]: { ...native } } }), project: adapter.projectActivity };
    const options = { sessionMetadataDeps: { scopedHome: true } };
    const shared = { homeDir: s.home, env: {} };
    const linked = await refreshSessionActivity(summary, [entry], options, shared, { now: () => clock });
    assert.equal(linked.nativeSessions.today[`${client}:child-native`].parentSessionId, 'parent-native');
    const stable = await refreshSessionActivity(linked, [entry], options, shared, { now: () => clock + 1000 });
    assert.equal(stable, linked, 'no-change poll must not trigger IPC/presentation repaint');
    const renewed = await refreshSessionActivity(linked, [entry], options, shared, { now: () => clock + 11000 });
    assert.notEqual(renewed, linked, 'real activity renewal still publishes');
    assert.equal(renewed.nativeSessions.today[`${client}:child-native`].parentClient, parentClient);
  });
}

test('empty or unresolved native views leave the original activity snapshot unchanged', async (t) => {
  const { refreshSessionActivity } = require('../../src/shared/sessionActivityRegistry');
  const s = store(t);
  for (const nativeSessions of [{}, { today: { 'claude:unknown': { client: 'claude', sessionId: 'unknown' } } }]) {
    const summary = { nativeSessions };
    assert.equal(await refreshSessionActivity(summary, [], {}, { homeDir: s.home, env: {} }), summary);
  }
});

test('multi-UUID Codex accounting names do not guess a native conversation from a filename hint', (t) => {
  const s = store(t); pair(s, 'codex', 'claudeAgent');
  const native = '019a0000-1234-7000-8000-000000000001';
  s.db.prepare("UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef.nativeId', ?) WHERE provider_thread_id = 'child-provider'").run(native);
  const sessionId = `rollout-2026-10-11T00-00-00-${native}-019a0000-1234-7000-8000-000000000002`;
  const periods = { today: normalizePeriod({ sessions: {
    c: { client: 'codex', sessionId, totalTokens: 20 },
    p: { client: 'claude', sessionId: 'parent-native', totalTokens: 30 }
  } }) };
  applyT3SessionParents(periods, s.home, { env: {} });
  assert.equal(periods.today.sessions[`codex:${sessionId}`].parentSessionId, undefined);
});

test('relationship query uses delegation node primary keys instead of scanning execution history', (t) => {
  const s = store(t); pair(s);
  const plans = [];
  class DatabaseSync extends sqlite.DatabaseSync {
    prepare(sql) {
      const statement = super.prepare(sql);
      if (!sql.startsWith('SELECT cp.thread_id')) return statement;
      return { all: (...args) => {
        plans.push(...super.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail));
        return statement.all(...args);
      } };
    }
  }
  assert.equal(readT3SessionParents(['child-native'], { homeDir: s.home, env: {}, sqlite: { DatabaseSync } }).size, 1);
  assert.ok(plans.some((detail) => detail.startsWith('SEARCH n USING INDEX') && detail.includes('(node_id=?)')), 'delegation lookup must use its explicit primary-key reference');
  assert.equal(plans.some((detail) => /^SCAN (n|root)\b/.test(detail)), false);
});


test('verified Codex header identity links children when the only parent is a multi-UUID continuation', t => {
  const s = store(t); pair(s);
  const parent = { client: 'codex', sessionId: 'rollout-2026-10-11T10-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    nativeSessionId: 'parent-native', totalTokens: 10 };
  const child = { client: 'claude', sessionId: 'child-native', totalTokens: 20 };
  const periods = { today: { sessions: { [`codex:${parent.sessionId}`]: parent, 'claude:child-native': child } } };
  applyT3SessionParents(periods, s.home, { env: {} });
  assert.equal(child.parentSessionId, parent.sessionId);
  assert.equal(child.parentClient, 'codex');
  assert.equal(Object.keys(periods.today.sessions).length, 2);
});

test('T3 app identity spans provider switches while human forks remain distinct', t => {
  const s = store(t); pair(s);
  s.provider('main-claude', 'parent', 'main-claude-native', 'claudeAgent');
  s.provider('child-codex', 'child', 'child-codex-native');
  s.thread('human-fork', 'parent', 'fork');
  s.provider('fork-provider', 'human-fork', 'fork-native');
  const periods = { today: normalizePeriod({ sessions: {
    a: { client: 'codex', sessionId: 'parent-native', totalTokens: 10 },
    b: { client: 'claude', sessionId: 'main-claude-native', totalTokens: 20 },
    c: { client: 'claude', sessionId: 'child-native', totalTokens: 30 },
    d: { client: 'codex', sessionId: 'child-codex-native', totalTokens: 40 },
    e: { client: 'codex', sessionId: 'fork-native', totalTokens: 50 }
  } }) };
  applyT3SessionParents(periods, s.home, { env: {} });
  const ss = periods.today.sessions;
  assert.equal(ss['claude:main-claude-native'].t3ThreadId, 'parent');
  assert.equal(ss['codex:child-codex-native'].t3ThreadId, 'child');
  assert.equal(ss['codex:child-codex-native'].parentSessionId, 'parent-native');
  assert.equal(ss['codex:fork-native'].t3ThreadId, 'human-fork');
  assert.equal(ss['codex:fork-native'].parentSessionId, undefined);
  delete ss['codex:parent-native'];
  delete ss['codex:child-codex-native'].parentSessionId;
  applyT3SessionParents(periods, s.home, { env: {} });
  assert.equal(ss['codex:child-codex-native'].parentClient, 'claude');
  assert.equal(ss['codex:child-codex-native'].parentSessionId, 'main-claude-native', 'another visible provider is still the proven parent app thread');
});

test('accepted run identities survive native replacement; pending or wrongly owned attempts do not establish app identity', t => {
  const s = store(t); s.thread('main');
  const old = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const current = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  s.provider('provider', 'main', current);
  s.db.exec(`CREATE TABLE orchestration_v2_projection_run_attempts (
    thread_id TEXT, provider_thread_id TEXT, root_node_id TEXT, status TEXT, payload_json TEXT)`);
  s.db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?)').run('root', 'main', 'root', 'root_turn', 'provider');
  const insert = s.db.prepare('INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, ?, ?)');
  insert.run('main', 'provider', 'root', 'completed', JSON.stringify({ nativeThreadId: old }));
  insert.run('main', 'provider', 'root', 'queued', JSON.stringify({ nativeThreadId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }));
  insert.run('other', 'provider', 'root', 'completed', JSON.stringify({ nativeThreadId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }));
  const plans = [];
  let historyQueries = 0, nativeQueries = 0;
  class DatabaseSync extends sqlite.DatabaseSync {
    prepare(sql) {
      const statement = super.prepare(sql);
      if (!sql.includes('SELECT p.driver,')) return statement;
      return { all: (...args) => {
        if (sql.includes('1 AS historical')) historyQueries++;
        else nativeQueries++;
        plans.push(...super.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail));
        return statement.all(...args);
      } };
    }
  }
  const ids = [old, current, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    ...Array.from({ length: 801 }, (_, i) => `unrelated-${i}`)];
  const facts = readT3SessionRelations(ids, { homeDir: s.home, env: {}, sqlite: { DatabaseSync } });
  assert.deepEqual([...facts.keys()].sort(), [`codex:${old}`, `codex:${current}`]);
  assert.equal(facts.get(`codex:${old}`).threadId, 'main');
  assert.equal(nativeQueries, 1, 'native providers are scanned once even beyond the old batch limit');
  assert.equal(historyQueries, 1, 'historical attempts are scanned once');
  assert.equal(plans.filter(detail => /^SCAN p\b/.test(detail)).length, 1, 'ownership joins do not rescan the provider table');
  assert.ok(plans.some(detail => detail.startsWith('SEARCH p USING INDEX') && detail.includes('(provider_thread_id=?)')));
  assert.equal(plans.some(detail => /^SCAN root\b/.test(detail)), false);
  assert.ok(plans.some(detail => detail.startsWith('SEARCH root USING INDEX') && detail.includes('(node_id=?)')));
});

for (const client of ['claude', 'devin']) test(`T3 ${client} identities survive wire, real SQLite archive and title removal while cross-device conflicts fail closed`, t => {
  const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
  let reopened;
  t.after(() => reopened?.close());
  const s = store(t); const make = t3ThreadId => normalizePeriod({ sessions: {
    a: { client, sessionId: 'a', totalTokens: 10, costUsd: 1, t3ThreadId, title: 'private' }
  } });
  const period = make('app-main');
  const worker = require('../../worker/src/shared/usage');
  assert.equal(worker.normalizePeriod(period).sessions[`${client}:a`].t3ThreadId, 'app-main');
  assert.equal(worker.mergePeriods(period, make('different')).sessions[`${client}:a`].t3ThreadId, undefined);
  const dbPath = path.join(s.home, 'archive.sqlite');
  const archive = createSessionUsageArchiveStore({ databasePath: dbPath, legacyPath: path.join(s.home, 'absent.json') });
  const result = archive.capture({ today: period, month: period, allTime: period }, new Date());
  assert.equal(result.error, null); archive.close();
  reopened = createSessionUsageArchiveStore({ databasePath: dbPath, legacyPath: path.join(s.home, 'absent.json') });
  assert.equal(reopened.read().sessions[`${client}:a`].periods.today.t3ThreadId, 'app-main');
  const scrubbed = stripSessionTextFromPeriod(period).sessions[`${client}:a`];
  assert.equal(scrubbed.t3ThreadId, 'app-main'); assert.equal(scrubbed.title, undefined);
  assert.equal(mergePeriods(period, make('different'), period).sessions[`${client}:a`].t3ThreadId, undefined);
  assert.equal(make('invalid thread text').sessions[`${client}:a`].t3ThreadId, undefined);
});

function runningTask(s, childProvider = 'child-provider', parentApp = 'parent', childApp = 'child') {
  s.db.exec(`CREATE TABLE IF NOT EXISTS orchestration_v2_projection_subagents (
    subagent_id TEXT PRIMARY KEY, thread_id TEXT, child_thread_id TEXT, origin TEXT)`);
  s.db.prepare('INSERT INTO orchestration_v2_projection_subagents VALUES (?, ?, ?, ?)')
    .run(`task-${childProvider}`, parentApp, childApp, 'app_owned');
  s.db.prepare('UPDATE orchestration_v2_projection_nodes SET provider_thread_id = NULL WHERE node_id = ?')
    .run(`task-${childProvider}`);
}

for (const parentDriver of ['codex', 'claudeAgent']) for (const childDriver of ['codex', 'claudeAgent']) {
  test(`running T3 ${childDriver} child binds to ${parentDriver} before its delegation node has a provider`, t => {
    const s = store(t); pair(s, childDriver, parentDriver); runningTask(s);
    const expected = { parentClient: parentDriver === 'codex' ? 'codex' : 'claude', parentNativeId: 'parent-native' };
    assert.deepEqual([...s.read(['child-native']).values()], [expected]);
    s.provider('switched-child', 'child', 'switched-native', childDriver === 'codex' ? 'claudeAgent' : 'codex');
    assert.deepEqual([...s.read(['switched-native']).values()], [expected], 'later provider runs retain the explicit child App identity');
    s.db.prepare('UPDATE orchestration_v2_projection_nodes SET provider_thread_id = ? WHERE node_id = ?')
      .run('child-provider', 'task-child-provider');
    assert.deepEqual([...s.read(['child-native']).values()], [expected], 'completion keeps the same relationship');
  });
}

test('running task ownership must match the child, parent, app origin and launching execution root', async t => {
  const cases = [
    ['wrong child', "UPDATE orchestration_v2_projection_subagents SET child_thread_id = 'other'"],
    ['wrong parent', "UPDATE orchestration_v2_projection_subagents SET thread_id = 'other'"],
    ['unproven native origin', "UPDATE orchestration_v2_projection_subagents SET origin = 'provider_native'"],
    ['absent task', 'DELETE FROM orchestration_v2_projection_subagents'],
    ['wrong root', "UPDATE orchestration_v2_projection_nodes SET thread_id = 'other' WHERE kind = 'root_turn'"],
    ['contradictory node provider', "UPDATE orchestration_v2_projection_nodes SET provider_thread_id = 'launch-provider' WHERE kind = 'subagent'"],
    ['human fork', "UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.lineage.relationshipToParent', 'fork') WHERE thread_id = 'child'"]
  ];
  for (const [name, mutate] of cases) await t.test(name, t => {
    const s = store(t); pair(s); runningTask(s); s.db.exec(mutate);
    assert.equal(s.read(['child-native']).size, 0);
  });
});

test('three active records in one T3 family become one running group through accounting and pre-token refresh paths', async t => {
  const { refreshSessionActivity } = require('../../src/shared/sessionActivityRegistry');
  const presentation = require('../../src/electron/renderer/edgeDock/presentation');
  const s = store(t); pair(s, 'codex'); runningTask(s);
  s.thread('other-child', 'parent'); s.provider('other-provider', 'other-child', 'other-native', 'claudeAgent');
  s.delegation('other-provider', 'launch-provider', 'parent'); runningTask(s, 'other-provider', 'parent', 'other-child');
  const now = Date.now();
  const make = (client, sessionId, totalTokens) => ({ client, sessionId, totalTokens, costUsd: totalTokens / 100,
    lastUsedAt: new Date(now).toISOString(), turnEnded: false,
    liveActivity: { state: 'running', observedAt: new Date(now).toISOString() },
    ...(!totalTokens ? { tokenDataUnavailable: true } : {}) });
  const parent = make('codex', 'parent-native', 100);
  const child = make('codex', 'child-native', 20);
  const other = make('claude', 'other-native', 30);
  const periods = { month: normalizePeriod({ totalTokens: 150, costUsd: 1.5, sessions: { parent, child, other } }) };
  applyT3SessionParents(periods, s.home, { env: {} });
  const stats = { periods };
  const rows = presentation.recentSessionRows(stats, 1, { runningOnly: true });
  assert.equal(rows.length, 1);
  assert.equal(presentation.runningSessionSummary(rows).count, 1);
  assert.equal(rows[0].groupRows.length, 3);
  assert.equal(rows[0].subagentCount, 2);
  assert.equal(rows[0].totalTokens, 150);
  assert.equal(rows[0].costUsd, 1.5);
  const original = JSON.stringify(periods);
  const nativeRows = { 'codex:child-native': make('codex', 'child-native', 0), 'claude:other-native': make('claude', 'other-native', 0) };
  const native = { today: nativeRows, month: nativeRows };
  const summary = await refreshSessionActivity({ periods, nativeSessions: native }, [], {}, { homeDir: s.home, env: {} });
  assert.equal(JSON.stringify(periods), original, 'activity enrichment never changes accounting');
  for (const name of ['today', 'month']) {
    assert.equal(summary.nativeSessions[name]['codex:child-native'].t3ThreadId, 'child');
    assert.equal(summary.nativeSessions[name]['codex:child-native'].parentSessionId, 'parent-native',
      'accounting rows with the same key must not hide native enrichment targets');
  }
  const pretokenStats = { periods: { month: { sessions: { 'codex:parent-native': parent } } }, nativeSessions: summary.nativeSessions };
  const pretokenRows = presentation.recentSessionRows(pretokenStats, 1, { runningOnly: true });
  assert.equal(pretokenRows.length, 1);
  assert.equal(pretokenRows[0].groupRows.length, 3);
  assert.equal(pretokenRows[0].subagentCount, 2);
  assert.equal(pretokenRows[0].totalTokens, 100, 'pre-token children contribute no duplicate usage');
});


test('ACP projection instance column must agree with its payload and uses only colocated settings', t => {
  const s = store(t); s.thread('main');
  registry(s, { a: { driver: 'acpRegistry', config: { agentId: 'devin' } } });
  s.provider('a', 'main', 'opaque-native', 'acpRegistry', 'strong', 'a');
  s.db.exec('ALTER TABLE orchestration_v2_projection_provider_threads ADD COLUMN provider_instance_id TEXT');
  s.db.exec("UPDATE orchestration_v2_projection_provider_threads SET provider_instance_id = 'a'");
  const read = () => readT3SessionRelations(['opaque-native'], { homeDir: s.home, env: {} });
  assert.equal(read().get('devin:opaque-native').threadId, 'main');
  s.db.exec("UPDATE orchestration_v2_projection_provider_threads SET provider_instance_id = 'different'");
  assert.equal(read().size, 0);
  s.db.exec("UPDATE orchestration_v2_projection_provider_threads SET provider_instance_id = 'a'");
  fs.writeFileSync(path.join(path.dirname(s.file), 'settings.json'), 'malformed');
  assert.equal(read().size, 0);
  registry(s, { a: { driver: 'acpRegistry', config: { agentId: 'devin' } } });
  s.db.exec("UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef.strength', 'weak')");
  assert.equal(read().size, 0);
});

test('unknown drivers and Pi file-path identities remain unbound instead of guessing an accounting id', t => {
  const s = store(t); s.thread('main');
  for (const driver of ['unknown', 'pi', 'antigravity', 'constructor']) s.provider(driver, 'main', 'same-id', driver);
  assert.equal(readT3SessionRelations(['same-id'], { homeDir: s.home, env: {} }).size, 0);
});


test('superseded started attempts keep historical identity and delegation through native restart', t => {
  const s = store(t); pair(s);
  const old = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  s.db.exec(`CREATE TABLE orchestration_v2_projection_run_attempts (
    thread_id TEXT, provider_thread_id TEXT, root_node_id TEXT, status TEXT, payload_json TEXT)`);
  s.db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?)')
    .run('child-root', 'child', 'child-root', 'root_turn', 'child-provider');
  const insert = s.db.prepare('INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, ?, ?)');
  insert.run('child', 'child-provider', 'child-root', 'superseded', JSON.stringify({ nativeThreadId: old }));
  insert.run('wrong', 'child-provider', 'child-root', 'superseded', JSON.stringify({ nativeThreadId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }));
  insert.run('child', 'child-provider', 'child-root', 'superseded', JSON.stringify({}));
  const facts = readT3SessionRelations([old, 'child-native', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'], { homeDir: s.home, env: {} });
  assert.equal(facts.get(`claude:${old}`).threadId, 'child');
  assert.equal(facts.get(`claude:${old}`).parentThreadId, 'parent');
  assert.equal(facts.has('claude:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), false);
  const periods = { month: normalizePeriod({ sessions: {
    a: { client: 'codex', sessionId: 'parent-native', totalTokens: 10, lastUsedAt: new Date().toISOString() },
    b: { client: 'claude', sessionId: old, totalTokens: 20, lastUsedAt: new Date().toISOString() },
    c: { client: 'claude', sessionId: 'child-native', totalTokens: 30, lastUsedAt: new Date().toISOString() }
  } }) };
  applyT3SessionParents(periods, s.home, { env: {} });
  const [group, ...others] = require('../../src/electron/renderer/edgeDock/presentation').recentSessionRows({ periods }, 100);
  assert.equal(others.length, 0); assert.equal(group.groupRows.length, 3);
  assert.equal(group.subagentCount, 1); assert.equal(group.totalTokens, 60);
});

for (const driver of ['codex', 'claudeAgent', 'acpRegistry']) test(`stored uppercase ${driver} UUIDs match normalized accounting IDs without changing opaque ACP IDs`, t => {
  const s = store(t); s.thread('main');
  registry(s, { a: { driver: 'acpRegistry', config: { agentId: 'claude-acp' } }, b: { driver: 'acpRegistry', config: { agentId: 'devin' } } });
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const old = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
  s.provider('p', 'main', id.toUpperCase(), driver, 'strong', 'a');
  s.db.exec(`CREATE TABLE orchestration_v2_projection_run_attempts (
    thread_id TEXT, provider_thread_id TEXT, root_node_id TEXT, status TEXT, payload_json TEXT)`);
  s.db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?)').run('root', 'main', 'root', 'root_turn', 'p');
  s.db.prepare('INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?, ?, ?)')
    .run('main', 'p', 'root', 'superseded', JSON.stringify({ nativeThreadId: old.toUpperCase() }));
  const client = driver === 'codex' ? 'codex' : 'claude';
  const facts = readT3SessionRelations([id, old], { homeDir: s.home, env: {} });
  assert.equal(facts.get(`${client}:${id}`).threadId, 'main');
  assert.equal(facts.get(`${client}:${old}`).threadId, 'main');
  s.provider('opaque', 'main', id.toUpperCase(), 'acpRegistry', 'strong', 'b');
  assert.equal(readT3SessionRelations([id], { homeDir: s.home, env: {} }).has(`devin:${id.toUpperCase()}`), false);
  assert.equal(readT3SessionRelations([id.toUpperCase()], { homeDir: s.home, env: {} }).get(`devin:${id.toUpperCase()}`).threadId, 'main');
});

for (const header of [true, false]) test(`Codex ${header ? 'header' : 'filename'} UUID candidates enrich consistently without changing accounting or opaque ACP identities`, t => {
  const s = store(t); s.thread('parent'); s.thread('child', 'parent'); s.thread('opaque');
  const parent = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const child = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
  s.provider('parent-provider', 'parent', parent);
  s.provider('child-provider', 'child', child);
  s.delegation('child-provider', 'parent-provider', 'parent');
  registry(s, { devin: { driver: 'acpRegistry', config: { agentId: 'devin' } } });
  s.provider('opaque-provider', 'opaque', child.toUpperCase(), 'acpRegistry', 'strong', 'devin');
  const dir = path.join(s.home, '.codex', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'parent-rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: parent.toUpperCase() } }) + '\n');
  fs.writeFileSync(path.join(dir, 'child-rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: child.toUpperCase() } }) + '\n');
  const parentId = header ? 'parent-rollout' : `rollout-${parent.toUpperCase()}`;
  const childId = header ? 'child-rollout' : `rollout-${child.toUpperCase()}`;
  const periods = { month: normalizePeriod({ sessions: {
    p: { client: 'codex', sessionId: parentId, totalTokens: 10, costUsd: 1 },
    c: { client: 'codex', sessionId: childId, totalTokens: 20, costUsd: 2 },
    d: { client: 'devin', sessionId: child, totalTokens: 30, costUsd: 3 }
  } }) };
  const before = Object.entries(periods.month.sessions).map(([key, row]) => [key, row.totalTokens, row.costUsd]);
  applySessionIdentities(periods, s.home, { env: {} });
  assert.equal(periods.month.sessions[`codex:${parentId}`].t3ThreadId, 'parent');
  assert.equal(periods.month.sessions[`codex:${childId}`].t3ThreadId, 'child');
  assert.equal(periods.month.sessions[`codex:${childId}`].parentSessionId, parentId);
  assert.equal(periods.month.sessions[`codex:${childId}`].parentClient, undefined);
  assert.equal(periods.month.sessions[`devin:${child}`].t3ThreadId, undefined, 'opaque UUID-shaped ACP ids stay case sensitive');
  assert.deepEqual(Object.entries(periods.month.sessions).map(([key, row]) => [key, row.totalTokens, row.costUsd]), before);
  if (header) assert.equal(periods.month.sessions[`codex:${childId}`].nativeSessionId, child.toUpperCase(), 'verified header identity is retained verbatim');
});

test('targeted relationship lookup queries only targets while historical parent evidence still resolves', t => {
  const s = store(t); pair(s);
  const periods = { today: normalizePeriod({ sessions: { c: { client: 'claude', sessionId: 'child-native', totalTokens: 10 } } }),
    month: normalizePeriod({ sessions: { p: { client: 'codex', sessionId: 'parent-native', totalTokens: 30 },
      h: { client: 'codex', sessionId: 'unrelated-history', totalTokens: 20 } } }) };
  const lookups = [];
  class DatabaseSync extends sqlite.DatabaseSync {
    prepare(sql) {
      const statement = super.prepare(sql);
      if (!sql.includes('SELECT p.driver,') || sql.includes('1 AS historical')) return statement;
      return { all: (...args) => { lookups.push(args); return statement.all(...args); } };
    }
  }
  const child = periods.today.sessions['claude:child-native'];
  applyT3SessionParents(periods, s.home, { env: {}, sqlite: { DatabaseSync } }, new Set([child]));
  assert.equal(child.parentSessionId, 'parent-native');
  assert.equal(child.parentClient, 'codex');
  const queriedIds = lookups.flatMap(args => args.flatMap(value => JSON.parse(value)));
  assert.deepEqual(queriedIds, ['child-native'], 'only the target native id is queried');
  assert.equal(queriedIds.includes('unrelated-history'), false);
  assert.equal(queriedIds.includes('parent-native'), false, 'historical evidence is not a DB lookup target');
  assert.equal(periods.month.sessions['codex:parent-native'].t3ThreadId, undefined, 'evidence is read-only');
});


test('anchored SQLite metadata preserves the resolvable Month parent pair across provider switches', async t => {
  const { collectUsageOnce } = require('../../src/shared/collector');
  const { localDayKey } = require('../../src/shared/history');
  const s = store(t); pair(s);
  s.provider('parent-claude', 'parent', 'claude-new-parent', 'claudeAgent');
  const scan = today => ({ entries: [
    { client: today ? 'codex' : 'claude', sessionId: today ? 'parent-native' : 'claude-new-parent', lastUsedAt: new Date().toISOString(), model: 'm', input: today ? 10 : 50, cost: 1 },
    { client: 'claude', sessionId: 'child-native', ...(today ? { parentSessionId: 'parent-native', parentClient: 'codex' } : {}), lastUsedAt: new Date().toISOString(), model: 'm', input: 20, cost: 2 }
  ] });
  let captured;
  const options = { clients: 'codex,claude', homeDir: s.home, projectsEnabled: false, historyEnabled: false,
    limitsEnabled: false, wslScanEnabled: false, osInfo: {}, env: {},
    sessionMetadataDeps: { scopedHome: true, sessionMetadataResolvers: new Map() },
    onAnchorComputed: value => { captured = value; }, runTokscale: async ({ flags }) => scan(flags.includes('--today')) };
  const full = await collectUsageOnce(options);
  assert.equal(full.today.sessions['claude:child-native'].parentClient, 'codex');
  assert.equal(full.month.sessions['claude:child-native'].parentSessionId, 'claude-new-parent');
  assert.equal(full.month.sessions['claude:child-native'].parentClient, undefined);
  const next = await collectUsageOnce({ ...options, todayOnlyAnchor: { dateKey: localDayKey(new Date()),
    today: full.today, month: full.month, allTime: full.allTime, todayPartitions: captured.todayPartitions,
    sessionIdentityVersion: captured.sessionIdentityVersion } });
  for (const name of ['month', 'allTime']) {
    const child = next[name].sessions['claude:child-native'];
    assert.equal(child.parentSessionId, 'claude-new-parent');
    assert.equal(child.parentClient, undefined, 'fresh Codex namespace cannot attach to the retained Claude parent ID');
    assert.equal(next[name].totalTokens, full[name].totalTokens);
    assert.equal(next[name].costUsd, full[name].costUsd);
  }
  const rows = require('../../src/electron/renderer/sessionRows');
  const groups = rows.groupSessionRows(rows.sessionRowsForPeriod(next.month));
  assert.equal(groups.length, 1); assert.equal(groups[0].groupRows.length, 2);
});


test('relationship queries retain every requested child across the 400-ID query boundary', t => {
  const s = store(t);
  s.thread('parent');
  s.provider('parent-provider', 'parent', 'parent-native');
  const ids = Array.from({ length: 401 }, (_, i) => `child-native-${i}`);
  for (const [i, id] of ids.entries()) {
    s.thread(`child-${i}`, 'parent');
    s.provider(`provider-${i}`, `child-${i}`, id, 'claudeAgent');
    s.delegation(`provider-${i}`, 'parent-provider', 'parent');
  }
  s.thread('unrequested', 'parent');
  s.provider('unrequested-provider', 'unrequested', 'unrequested-native', 'claudeAgent');
  s.delegation('unrequested-provider', 'parent-provider', 'parent');
  const facts = readT3SessionRelations([...ids, ids[0], 'missing-native'], { homeDir: s.home, env: {} });
  assert.equal(facts.size, ids.length);
  for (const [i, id] of ids.entries()) {
    assert.deepEqual(facts.get(`claude:${id}`), {
      threadId: `child-${i}`, parentThreadId: 'parent', parentClient: 'codex', parentNativeId: 'parent-native'
    });
  }
  assert.equal(facts.has('claude:unrequested-native'), false);
});

test('a malformed provider payload does not suppress valid relationship evidence in the same store', t => {
  const s = store(t);
  pair(s);
  s.thread('malformed');
  s.db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)')
    .run('malformed-provider', 'malformed', 'claudeAgent', '{broken');
  assert.deepEqual(s.read(['child-native', 'malformed-native']), new Map([['claude:child-native', {
    parentClient: 'codex', parentNativeId: 'parent-native'
  }]]));
});


test('relationship read status distinguishes legal emptiness from retryable and permanent failures', t => {
  const s = store(t);
  const read = (extra = {}) => readT3SessionRelationResult(['child-native'], { homeDir: s.home, env: {}, ...extra });
  assert.deepEqual(read(), { facts: new Map(), status: 'complete' }, 'valid empty T3 schema');
  assert.deepEqual(read({ t3DbPaths: [path.join(s.home, 'missing.sqlite')] }), { facts: new Map(), status: 'complete' });
  assert.deepEqual(readT3SessionRelationResult([], { sqlite: null }), { facts: new Map(), status: 'complete' });
  const emptyPath = path.join(s.home, 'empty.sqlite');
  const empty = new sqlite.DatabaseSync(emptyPath); empty.close();
  assert.equal(read({ t3DbPaths: [emptyPath] }).status, 'complete', 'empty SQLite file is legal zero facts');
  const unsupported = new sqlite.DatabaseSync(emptyPath);
  unsupported.exec('CREATE TABLE unrelated (id TEXT)'); unsupported.close();
  assert.equal(read({ t3DbPaths: [emptyPath] }).status, 'unavailable');
  const corrupt = path.join(s.home, 'corrupt.sqlite');
  fs.writeFileSync(corrupt, 'not sqlite');
  assert.equal(read({ t3DbPaths: [corrupt] }).status, 'unavailable');
  pair(s);
  s.db.exec('BEGIN EXCLUSIVE');
  try { assert.deepEqual(read(), { facts: new Map(), status: 'retryable' }); }
  finally { s.db.exec('ROLLBACK'); }
  assert.equal(read().facts.get('claude:child-native').parentNativeId, 'parent-native');
});

test('later store query failures discard partial facts without suppressing completed stores on permanent errors', t => {
  const s = store(t);
  pair(s);
  const copied = path.join(s.home, 'copied.sqlite');
  fs.copyFileSync(s.file, copied);
  let errorCode = 5;
  class DatabaseSync extends sqlite.DatabaseSync {
    constructor(file, options) { super(file, options); this.failLater = file === copied; }
    prepare(sql) {
      if (this.failLater && sql.includes('SELECT cp.thread_id')) throw Object.assign(new Error('injected later query failure'), { errcode: errorCode });
      return super.prepare(sql);
    }
  }
  const deps = { homeDir: s.home, env: {}, t3DbPaths: [s.file, copied], sqlite: { DatabaseSync } };
  assert.deepEqual(readT3SessionRelationResult(['child-native'], deps), { facts: new Map(), status: 'retryable' }, 'completed first-store facts are not applied while migration is incomplete');
  errorCode = 11;
  assert.equal(readT3SessionRelationResult(['child-native'], { ...deps, t3DbPaths: [copied] }).facts.size, 0, 'partial identity facts are discarded on permanent failure too');
  const result = readT3SessionRelationResult(['child-native'], deps);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.facts.get('claude:child-native').parentNativeId, 'parent-native', 'completed healthy store still supplies facts');
  errorCode = 6;
  assert.deepEqual(readT3SessionRelationResult(['child-native'], { ...deps, t3DbPaths: [copied, s.file] }), { facts: new Map(), status: 'retryable' }, 'later success cannot mask LOCKED');
});
