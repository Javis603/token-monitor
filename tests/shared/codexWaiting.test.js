'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readCodexSessionState } = require('../../src/shared/providers/codex/sessionContext');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const live = require('../../src/shared/sessionLive');
const usage = require('../../src/shared/usage');
const archive = require('../../src/shared/usage/sessionUsageArchive');
const presentation = require('../../src/electron/renderer/edgeDock/presentation');
const sessionRows = require('../../src/electron/renderer/sessionRows');

const now = Date.parse('2026-10-08T12:00:00Z');
const entry = (type, payload = {}) => JSON.stringify({ type: 'response_item', payload: { type, ...payload } });
const event = (type) => JSON.stringify({ type: 'event_msg', payload: { type } });
const question = (callId = 'question-1') => entry('function_call', {
  name: 'request_user_input', call_id: callId, arguments: '{"questions":[{"question":"private text"}]}'
});
const answer = (callId = 'question-1', output = 'Right') => entry('function_call_output', { call_id: callId, output });
const session = (extra = {}) => ({ client: 'codex', sessionId: 'test', totalTokens: 100,
  lastUsedAt: new Date(now).toISOString(), turnEnded: false, waitingForInput: true, ...extra });
const period = (row) => usage.normalizePeriod({ sessions: { [row.client + ':' + row.sessionId]: row } });

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-waiting-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.codex', 'sessions', '2026', '10', '08');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'rollout-2026-10-08T12-00-00-test.jsonl');
  const cache = new Map();
  const write = (lines) => fs.writeFileSync(file, lines.join('\n') + '\n');
  const append = (...lines) => fs.appendFileSync(file, lines.join('\n') + '\n');
  const read = () => readCodexSessionState(file, { cache });
  return { home, file, id: path.basename(file, '.jsonl'), cache, write, append, read };
}

test('Codex unanswered question clears on matching answer or error without a mode exception', (t) => {
  const f = fixture(t);
  f.write([event('task_started'), question()]);
  const waiting = f.read();
  assert.equal(waiting.waitingForInput, true);
  assert.equal(waiting.turnEnded, false);
  f.append(answer('unrelated'));
  assert.equal(f.read().waitingForInput, true);
  f.append(answer('question-1', 'request_user_input is unavailable in Default mode'));
  assert.equal(f.read().waitingForInput, false);
  assert.equal(waiting.waitingForInput, true);
  assert.equal(waiting.pendingInputCalls.size, 1);
  assert.equal(readCodexSessionState(f.file, { cache: new Map() }).waitingForInput, false);
});

test('Codex tracks simultaneous questions and clears pending input at turn boundaries', (t) => {
  const f = fixture(t);
  f.write([event('task_started'), question('a'), question('b'), answer('a')]);
  assert.equal(f.read().waitingForInput, true);
  f.append(answer('b'));
  assert.equal(f.read().waitingForInput, false);
  for (const boundary of ['task_complete', 'turn_aborted', 'task_started']) {
    f.append(question(), event(boundary));
    assert.equal(f.read().waitingForInput, false, boundary);
    assert.equal(f.read().pendingInputCalls.size, 0);
  }
});

test('Codex tool execution and words about waiting never become question waiting', (t) => {
  const f = fixture(t);
  f.write([event('task_started'), entry('custom_tool_call', {
    name: 'exec', call_id: 'command', input: 'request_user_input require_escalated waiting'
  }), entry('function_call', { name: 'exec_command', call_id: 'shell' }),
  entry('message', { text: 'waiting for permission' })]);
  assert.equal(f.read().waitingForInput, false);
  f.append(question());
  assert.equal(f.read().waitingForInput, true);
  f.write([event('task_started'), answer()]);
  assert.equal(f.read().waitingForInput, false, 'truncation resets pending requests');
});

test('Codex partial records are not evidence and a completed no-newline answer clears waiting', (t) => {
  const f = fixture(t);
  f.write([event('task_started')]);
  const call = question();
  fs.appendFileSync(f.file, call.slice(0, 40));
  assert.equal(f.read().waitingForInput, false);
  fs.appendFileSync(f.file, call.slice(40) + '\n');
  assert.equal(f.read().waitingForInput, true);
  fs.appendFileSync(f.file, answer());
  assert.equal(f.read().waitingForInput, false);
});

test('Codex metadata carries a question and its resolution into every period', (t) => {
  const f = fixture(t);
  f.write([event('task_started'), question()]);
  const key = 'codex:' + f.id;
  const periods = Object.fromEntries(['today', 'month', 'allTime'].map((name) =>
    [name, { sessions: { [key]: session({ sessionId: f.id, waitingForInput: false }) } }]));
  const enrich = () => applySessionMetadata(periods, f.home, {
    now: Date.now(), env: {}, resolveProjects: false
  });
  enrich();
  for (const p of Object.values(periods)) assert.equal(p.sessions[key].waitingForInput, true);
  f.append(answer());
  enrich();
  for (const p of Object.values(periods)) assert.equal(p.sessions[key].waitingForInput, false);
});

test('a Codex warm watch tick carries question resolution into month and allTime', async (t) => {
  const f = fixture(t);
  const { collectUsageOnce } = require('../../src/shared/collector');
  const { localDayKey } = require('../../src/shared/history');
  const key = 'codex:' + f.id;
  f.write([event('task_started'), question()]);
  const options = {
    clients: 'codex', allTimeSince: '2024-01-01', deviceId: 'waiting-test', agentVersion: 'test',
    homeDir: f.home, env: {}, projectsEnabled: false, limitsEnabled: false, historyEnabled: false,
    codexLocalUsageEnabled: false, anchorPersistenceEnabled: false,
    runTokscale: async () => ({ entries: [{ client: 'codex', sessionId: f.id, model: 'gpt-6-luna', input: 100, output: 0, cost: 0 }] }),
    collectWslUsage: async () => ({ bundle: { today: {}, month: {}, allTime: {} }, detected: [] })
  };
  const full = await collectUsageOnce(options);
  for (const name of ['today', 'month', 'allTime']) assert.equal(full[name].sessions[key].waitingForInput, true);
  f.append(answer());
  const warm = await collectUsageOnce({ ...options, todayOnlyAnchor: {
    dateKey: localDayKey(new Date()), today: full.today, month: full.month,
    allTime: full.allTime, todayPartitions: { codex: full.today }
  } });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(warm[name].sessions[key].waitingForInput, false, name);
    assert.equal(warm[name].sessions[key].totalTokens, full[name].sessions[key].totalTokens);
  }
});

test('Codex question state normalizes and merges by transcript time, with clearing winning ties', () => {
  const waiting = session();
  const cleared = session({ waitingForInput: false, lastUsedAt: new Date(now + 1000).toISOString() });
  for (const rows of [[waiting, cleared], [cleared, waiting]]) {
    assert.equal(usage.mergePeriods(...rows.map(period)).sessions['codex:test'].waitingForInput, false);
  }
  for (const rows of [[waiting, session({ waitingForInput: false })], [session({ waitingForInput: false }), waiting]]) {
    assert.equal(usage.mergePeriods(...rows.map(period)).sessions['codex:test'].waitingForInput, false);
  }
  const unknown = session(); delete unknown.waitingForInput;
  assert.equal(usage.mergePeriods(period(waiting), period(unknown)).sessions['codex:test'].waitingForInput, true);
  const normalized = usage.normalizeDeviceRecord({ deviceId: 'test', today: { sessions: { 'codex:test': waiting } } });
  assert.equal(normalized.periods.today.sessions['codex:test'].waitingForInput, true);
  assert.equal(period(session({ client: 'claude' })).sessions['claude:test'].waitingForInput, undefined);
  assert.equal(period(session({ waitingForInput: 'true' })).sessions['codex:test'].waitingForInput, undefined);
});

test('Codex pending questions respect the existing activity window, completion and archive suppression', () => {
  assert.equal(live.sessionActivityState(session(), now), 'waiting');
  assert.equal(live.isRunningSession(session(), now), false);
  assert.equal(live.sessionActivityState(session(), now + live.RUNNING_WINDOW_MS + 1), 'idle');
  assert.equal(live.sessionActivityState(session({ turnEnded: true }), now), 'ended');
  for (const flag of ['archived', 'deleted', 'sourceDeleted']) {
    assert.equal(live.sessionActivityState(session({ [flag]: true }), now), 'idle');
  }
  assert.equal(live.sessionActivityState(session({ client: 'other' }), now), 'running');
});

test('Codex waiting reaches session rows and Dock projection without counting as running', () => {
  const saved = Date.now;
  Date.now = () => now;
  try {
    const rows = presentation.recentSessionRows({ periods: { month: period(session()) } }, 1);
    assert.equal(rows[0].waitingForInput, true);
    assert.equal(presentation.waitingSessionSummary(rows, now).count, 1);
    assert.equal(presentation.runningSessionSummary(rows, now).count, 0);
    assert.equal(presentation.nextRunningExpiryAt(rows, now), now + live.RUNNING_WINDOW_MS + 1);
    assert.equal(sessionRows.sessionRowsForPeriod(period(session()), { now: new Date(now) })[0].activityState, 'waiting');
  } finally { Date.now = saved; }
});

test('Codex question metadata stays out of historical archives and restored sessions', () => {
  const record = { today: period(session()) };
  const first = archive.updateSessionUsageArchive(null, record, now);
  assert.equal(first.archive.sessions['codex:test'].periods.today.waitingForInput, undefined);
  record.today.sessions['codex:test'].waitingForInput = false;
  assert.equal(archive.updateSessionUsageArchive(first.archive, record, now + 1000).changedKeys.size, 0);
  const restored = archive.applySessionUsageArchive({ today: usage.emptyPeriod() }, first.archive, { now });
  assert.equal(restored.today.sessions['codex:test'].waitingForInput, undefined);
  assert.equal(live.sessionActivityState(restored.today.sessions['codex:test'], now), 'idle');
});
