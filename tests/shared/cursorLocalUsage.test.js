'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { localNativeCoverage, readCursorLocalUsage } = require('../../src/shared/providers/cursor/localUsage');
const { readCursorLocalTurnUsage } = require('../../src/shared/providers/cursor/localSessions');
const cursorAuth = require('../../src/shared/providers/cursor/auth');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { readDailyHistoryArchive, graphFromDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-observed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const time = day => new Date(2026, 9, day, 9).getTime();
  const log = path.join(dir, '.config/Cursor/logs/20261026T090000/window1/output_090000/cursor.hooks.log');
  const cacheDir = path.join(dir, '.config/tokscale/cursor-cache');
  const file = path.join(dir, '.config/tokscale/cursor-local-usage.json');
  const options = { homeDir: dir, env: {}, platform: 'linux', now: new Date(2026, 9, 26, 12) };
  function hooks(at = time(26), overrides = {}, target = log) {
    const row = { conversation_id: 'session', generation_id: 'turn', user_email: 'private@example.test',
      workspace_roots: ['/private/project'], model: 'selected-model', input_tokens: 30, output_tokens: 5,
      cache_read_tokens: 20, cache_write_tokens: 0, prompt: 'do not retain this prompt', ...overrides };
    const block = (timestamp, event) => `[${new Date(timestamp).toISOString()}] Running hook\nINPUT:\n${JSON.stringify({ ...row, hook_event_name: event }, null, 2)}\n\nOUTPUT:\n(empty)\n`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, block(at, 'beforeSubmitPrompt') + block(at + 2000, 'stop'));
  }
  function native(at, count = 35, archive = false) {
    const target = path.join(cacheDir, archive ? 'archive/usage.old.json' : 'usage.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ usageEventsDisplay: [{ timestamp: at, model: 'model',
      tokenUsage: { inputTokens: count } }] }));
  }
  return { dir, log, file, options, time, hooks, native, cacheDir };
}

test('complete local turns persist exact input plus output without prompts, owners or selected models', t => {
  const f = fixture(t); f.hooks();
  const [row] = readCursorLocalUsage(f.options);
  assert.equal(row.totalTokens, 35);
  assert.equal(row.inputTokens, 10);
  assert.equal(row.cacheReadTokens, 20);
  assert.equal(row.outputTokens, 5);
  assert.equal(row.model, 'unknown');
  assert.match(row.id, /^[a-f0-9]{64}$/);
  const saved = fs.readFileSync(f.file, 'utf8');
  assert.doesNotMatch(saved, /private|selected-model|session|turn|prompt|workspace|email/i);
  fs.unlinkSync(f.log);
  assert.deepEqual(readCursorLocalUsage(f.options), [row], 'rotation cannot retract observed usage');
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved, 'unchanged ticks do not rewrite the ledger');
});

test('structured local model evidence fills the model and catalog estimate without Grok', async t => {
  const f = fixture(t);
  f.hooks(f.time(26), { model: 'cursor-grok-4.6-high', model_id: 'grok-4.6',
    model_params: [{ id: 'effort', value: 'high' }, { id: 'fast', value: 'false' }],
    input_tokens: 277246, output_tokens: 124, cache_read_tokens: 267008 });
  assert.equal(readCursorLocalUsage(f.options)[0].model, 'grok-4.6');
  t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  const result = await collectUsageOnce({ ...f.options, clients: 'cursor', deviceId: 'test', osInfo: {},
    wslScanEnabled: false, projectsEnabled: true, includeHistory: true,
    runTokscale: async () => ({ entries: [] }), runGraph: async () => ({ contributions: [] }),
    pricingRevision: 'local-model-regression', lookupModelPricing: async model => {
      assert.equal(model, 'grok-4.6');
      return { resolution: { exactModelIdentity: true, stripped: false },
        pricing: { inputCostPerToken: 2e-6, outputCostPerToken: 6e-6, cacheReadInputTokenCost: 5e-7 } };
    } });
  for (const period of ['today', 'month', 'allTime']) {
    assert.equal(result[period].models['grok-4.6'], 277370);
    assert.equal(result[period].models.unknown, undefined);
    assert.ok(Math.abs(result[period].costUsd - 0.154724) < 1e-9);
    assert.equal(result[period].unpricedTokens || 0, 0);
    assert.equal(result.cursorLocalModelEstimates[period]['grok-4.6'], 277370);
  }
  assert.ok(Math.abs(result.history.summary.totalCost - 0.154724) < 1e-9);
  const session = Object.values(result.nativeSessions.today)[0];
  const project = Object.values(result.nativeProjects.today)[0];
  assert.ok(Math.abs(session.cursorEstimatedCostUsd - 0.154724) < 1e-9);
  assert.ok(Math.abs(project.cursorEstimatedCostUsd - 0.154724) < 1e-9);
  assert.equal(session.unpricedTokens || 0, 0);
  const sessionRows = require('../../src/electron/renderer/sessionRows').sessionRowsForPeriod({}, { nativeSessions: result.nativeSessions.today });
  const projectRows = require('../../src/electron/renderer/projectRows').projectRowsForPeriod({}, { nativeProjects: result.nativeProjects.today });
  assert.ok(Math.abs(sessionRows[0].cost - 0.154724) < 1e-9);
  assert.ok(Math.abs(projectRows[0].cost - 0.154724) < 1e-9);
  const wire = require('../../src/shared/usage').normalizeDeviceRecord(result);
  assert.equal(wire.cursorLocalModelEstimates, undefined);
  assert.equal(require('../../src/shared/syncPayload').syncPayload(result).cursorLocalModelEstimates, undefined);
  assert.equal(wire.periods.today.models['grok-4.6'], 277370);
});

test('duplicate hook executions in different windows count a generation once', t => {
  const f = fixture(t); f.hooks();
  f.hooks(f.time(26) + 100, {}, f.log.replace('window1', 'window2'));
  assert.equal(readCursorLocalTurnUsage(f.options).rows.length, 1);
  assert.equal(readCursorLocalUsage(f.options).length, 1);
});

test('version-one counters gain model evidence without changing tokens and retain it after rotation', t => {
  const f = fixture(t); f.hooks();
  const [before] = readCursorLocalUsage(f.options);
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, rows: [before], conflicts: [] }));
  fs.unlinkSync(f.log);
  f.hooks(f.time(26), { model_id: 'grok-4.6', model_params: [{ id: 'fast', value: 'false' }] });
  const [after] = readCursorLocalUsage(f.options);
  assert.equal(after.model, 'grok-4.6'); assert.equal(after.totalTokens, before.totalTokens);
  fs.unlinkSync(f.log);
  assert.deepEqual(readCursorLocalUsage(f.options), [after]);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).version, 2);
});

test('conflicting model metadata retains exact counters but permanently removes model pricing', t => {
  const f = fixture(t);
  f.hooks(f.time(26), { model_id: 'grok-4.6', model_params: [{ id: 'fast', value: 'false' }] });
  assert.equal(readCursorLocalUsage(f.options)[0].model, 'grok-4.6');
  f.hooks(f.time(26) + 100, { model_id: 'grok-4.7', model_params: [{ id: 'fast', value: 'false' }] }, f.log.replace('window1', 'window2'));
  const [row] = readCursorLocalUsage(f.options);
  assert.equal(row.model, 'unknown'); assert.equal(row.modelConflict, true); assert.equal(row.totalTokens, 35);
  fs.rmSync(path.join(f.dir, '.config/Cursor/logs'), { recursive: true });
  assert.deepEqual(readCursorLocalUsage(f.options), [row]);
});

test('conflicting counters retire a prior observation durably', t => {
  const f = fixture(t); f.hooks();
  assert.equal(readCursorLocalUsage(f.options).length, 1);
  f.hooks(f.time(26) + 100, { output_tokens: 6 }, f.log.replace('window1', 'window2'));
  assert.equal(readCursorLocalUsage(f.options).length, 0);
  fs.rmSync(path.join(f.dir, '.config/Cursor/logs'), { recursive: true });
  assert.equal(readCursorLocalUsage(f.options).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).conflicts.length, 1);
});

test('persisted counter conflicts keep local session and project details unavailable after rotation', async t => {
  const f = fixture(t);
  const model = { model_id: 'grok-4.6', model_params: [{ id: 'fast', value: 'false' }] };
  f.hooks(f.time(26), model);
  f.hooks(f.time(26) + 5000, { ...model, conversation_id: 'accepted-session', generation_id: 'accepted',
    workspace_roots: ['/accepted/project'] });
  t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  const options = { ...f.options, clients: 'cursor', deviceId: 'test', osInfo: {},
    wslScanEnabled: false, projectsEnabled: true, includeHistory: true,
    runTokscale: async () => ({ entries: [] }), runGraph: async () => ({ contributions: [] }),
    pricingRevision: 'local-conflict-regression', lookupModelPricing: async () => ({
      resolution: { exactModelIdentity: true, stripped: false },
      pricing: { inputCostPerToken: 2e-6, outputCostPerToken: 6e-6, cacheReadInputTokenCost: 5e-7 }
    }) };
  const first = await collectUsageOnce(options);
  assert.equal(first.today.clients.cursor, 70);
  const rejectedProject = first.nativeSessions.today['cursor:session'].projectId;
  const acceptedProject = first.nativeSessions.today['cursor:accepted-session'].projectId;
  const conflictingLog = f.log.replace('20261026T090000', '20261026T100000');
  f.hooks(f.time(26) + 10000, { ...model, output_tokens: 6 }, conflictingLog);
  for (const rotated of [false, true]) {
    if (rotated) fs.unlinkSync(conflictingLog);
    const result = await collectUsageOnce(options);
    assert.equal(result.history.summary.totalTokens, 35);
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(result[period].clients.cursor, 35, 'accepted accounting remains unchanged');
      const rejected = result.nativeSessions[period]['cursor:session'];
      assert.equal(rejected.tokenDataUnavailable, true, 'rejected generations must not fall back to hook counters');
      assert.equal(rejected.totalTokens, 0);
      assert.deepEqual(rejected.models, {});
      assert.equal(rejected.cursorEstimatedCostUsd, undefined);
      const project = result.nativeProjects[period][rejectedProject];
      assert.equal(project.tokenDataUnavailable, true);
      assert.equal(project.tokens, 0);
      assert.equal(project.cursorEstimatedCostUsd, undefined);
      const accepted = result.nativeSessions[period]['cursor:accepted-session'];
      assert.equal(accepted.totalTokens, 35);
      assert.equal(accepted.tokenDataUnavailable, false);
      assert.ok(accepted.cursorEstimatedCostUsd > 0);
      assert.equal(result.nativeProjects[period][acceptedProject].tokens, 35);
    }
    assert.equal(JSON.parse(fs.readFileSync(f.file)).conflicts.length, 1);
  }
});

test('missing or conflicting ownership never produces an accounting observation', t => {
  const f = fixture(t); f.hooks(f.time(26), { user_email: '' });
  assert.equal(readCursorLocalUsage(f.options).length, 0);
  const raw = fs.readFileSync(f.log, 'utf8').replace('"user_email": ""', '"user_email": "one@example.test"');
  fs.writeFileSync(f.log, raw.replace(/"user_email": ""/g, '"user_email": "two@example.test"'));
  assert.equal(readCursorLocalUsage(f.options).length, 0);
});

test('incomplete counters and explicit zero counters do not invent consumption', t => {
  const f = fixture(t);
  f.hooks(f.time(26), { cache_read_tokens: undefined });
  f.hooks(f.time(26), { generation_id: 'zero', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 });
  assert.equal(readCursorLocalUsage(f.options).length, 0);
});

for (const archived of [false, true]) test(`native ${archived ? 'archived' : 'live'} usage owns its entire UTC day`, t => {
  const f = fixture(t); f.hooks(); f.hooks(f.time(24), { generation_id: 'older' });
  f.native(f.time(26) + 1000, 2, archived);
  const rows = readCursorLocalUsage(f.options);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventTime, f.time(24) + 2000);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).rows.length, 2, 'native precedence does not destroy observations');
});

for (const invalid of ['malformed', 'legacy', 'missing-schema']) test(`${invalid} native coverage blocks uncertain supplementation`, t => {
  const f = fixture(t); f.hooks(); fs.mkdirSync(f.cacheDir, { recursive: true });
  fs.writeFileSync(path.join(f.cacheDir, invalid === 'legacy' ? 'usage.csv' : 'usage.json'),
    invalid === 'legacy' ? 'legacy,unknown' : invalid === 'malformed' ? '{bad' : '{}');
  assert.equal(localNativeCoverage(f.options).unavailable, true);
  assert.equal(readCursorLocalUsage(f.options).length, 0);
});

test('an explicit billing connection takes precedence and a cutoff only affects projection', t => {
  const f = fixture(t); f.hooks();
  assert.equal(readCursorLocalUsage({ ...f.options, cursorBillingAccounts: [{ accountId: 'selected' }] }).length, 0);
  assert.equal(readCursorLocalUsage({ ...f.options, nativeCoverageUnknown: true }).length, 0);
  assert.equal(readCursorLocalUsage({ ...f.options, allTimeSince: new Date(f.time(26) + 3000).toISOString() }).length, 0);
  assert.equal(readCursorLocalUsage(f.options).length, 1);
});

test('dated legacy CSV covers its dates without blocking unrelated recent days', t => {
  const f = fixture(t); f.hooks();
  fs.mkdirSync(path.join(f.cacheDir, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(f.cacheDir, 'archive/usage-old.csv'),
    `Date,Model,Total Tokens\n"${new Date(f.time(24)).toISOString()}","old,model",35\n`);
  assert.equal(localNativeCoverage(f.options).unavailable, false);
  assert.equal(readCursorLocalUsage(f.options).length, 1);
  f.hooks(f.time(24), { generation_id: 'older' });
  assert.equal(readCursorLocalUsage(f.options).length, 1, 'the CSV day still takes native precedence');
});

test('a corrupt saved ledger fails without replacing the last file', t => {
  const f = fixture(t); f.hooks();
  fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, '{broken');
  assert.throws(() => readCursorLocalUsage(f.options));
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
});

test('local accounting fills Today, Month, All Time and History outside native anchors', async t => {
  const f = fixture(t); f.hooks(); t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  let captured;
  const options = { ...f.options, clients: 'cursor,claude', deviceId: 'test', osInfo: {}, wslScanEnabled: false,
    codexLocalUsageEnabled: false, projectsEnabled: true, includeHistory: true,
    dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: path.join(f.dir, 'history.json') },
    runTokscale: async () => ({ entries: [] }), runGraph: async () => ({ contributions: [] }),
    onAnchorComputed: value => { captured = value; } };
  const result = await collectUsageOnce(options);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(result[name].clients.cursor, 35); assert.equal(result[name].models.unknown, 35);
    assert.equal(result[name].unpricedTokens, 35); assert.equal(captured.windowsPeriods[name].totalTokens, 0);
  }
  assert.equal(result.history.summary.totalTokens, 35);
  assert.equal(Object.values(result.nativeProjects.today)[0].tokens, 35);
  const retained = graphFromDailyHistoryArchive(readDailyHistoryArchive({ path: path.join(f.dir, 'history.json') }));
  assert.deepEqual(retained.contributions, [], 'the separate ledger must stay out of generic history retention');
  const anchor = { dateKey: localTodayKey(f.options.now), ...captured.windowsPeriods,
    todayPartitions: captured.todayPartitions, cursorBillingNativeSignature: captured.cursorBillingNativeSignature };
  for (const targetClients of [['cursor'], ['claude'], []]) {
    const next = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients });
    assert.equal(next.month.clients.cursor, 35, 'warm and other-client ticks do not add the observation twice');
  }
  f.hooks(f.time(26) + 5000, { generation_id: 'next' });
  const changed = await collectUsageOnce({ ...options, includeHistory: false, todayOnlyAnchor: anchor, targetClients: ['claude'] });
  assert.equal(changed.today.clients.cursor, 70);
  assert.equal(changed.history.summary.totalTokens, 70, 'new local observations refresh History before its periodic interval');
});

test('historical native recovery rescans before removing local supplementation', async t => {
  const f = fixture(t); f.hooks(f.time(24)); t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  let captured;
  const options = { ...f.options, clients: 'cursor', deviceId: 'test', osInfo: {}, wslScanEnabled: false,
    historyEnabled: false, codexLocalUsageEnabled: false, runTokscale: async () => ({ entries: [] }),
    onAnchorComputed: value => { captured = value; } };
  const first = await collectUsageOnce(options); assert.equal(first.month.clients.cursor, 35);
  const anchor = { dateKey: localTodayKey(f.options.now), ...captured.windowsPeriods,
    todayPartitions: captured.todayPartitions, cursorBillingNativeSignature: captured.cursorBillingNativeSignature };
  f.native(f.time(24));
  const calls = [];
  const runTokscale = async ({ flags }) => { calls.push(flags); return { entries: flags.includes('--today') ? []
    : [{ client: 'cursor', model: 'actual-model', inputTokens: 35, totalTokens: 35, session: 'native' }] }; };
  const recovered = await collectUsageOnce({ ...options, runTokscale, todayOnlyAnchor: anchor });
  assert.equal(recovered.month.clients.cursor, 35); assert.equal(calls.length, 3);
  const refreshed = { dateKey: anchor.dateKey, ...captured.windowsPeriods,
    todayPartitions: captured.todayPartitions, cursorBillingNativeSignature: captured.cursorBillingNativeSignature };
  calls.length = 0;
  const stable = await collectUsageOnce({ ...options, runTokscale, todayOnlyAnchor: refreshed });
  assert.equal(stable.month.clients.cursor, 35); assert.equal(calls.length, 1);
});
