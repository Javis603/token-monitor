'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cursorAuth = require('../../src/shared/providers/cursor/auth');
const { parseHookLog, readCursorLocalSessions } = require('../../src/shared/providers/cursor/localSessions');
const { projectIdentity } = require('../../src/shared/sessionMetadata');
const { cursorDesktopStateCandidates } = require('../../src/shared/providers/cursor/desktopState');

const now = new Date(2026, 9, 21, 12);
const start = new Date(2026, 9, 21, 9).getTime();
const payload = (extra = {}) => ({ conversation_id: 'conversation', generation_id: 'turn',
  model: 'grok-4.7-high', workspace_roots: ['/D:/work/project'], hook_event_name: 'stop',
  input_tokens: 30, output_tokens: 5, cache_read_tokens: 20, cache_write_tokens: 0,
  user_email: 'private@example.test', text: 'private prompt', ...extra });
function block(time, row) {
  return `[${new Date(time).toISOString()}] Running hook\nINPUT:\n${JSON.stringify(row, null, 2)}\n\nOUTPUT:\n(empty)\n`;
}
const bill = { id: 'bill', model: 'grok-4.7-high', eventTime: start + 1500,
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 35 };

function fixture(t, platform = 'linux') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = cursorDesktopStateCandidates({ home: dir, platform, env: {} })[0];
  const log = path.join(path.resolve(path.dirname(state), '../../logs'), '20261021T090000/window1/output_090000/cursor.hooks.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  return { log, options: { homeDir: dir, platform, env: {}, now, projectIdentity,
    billingRows: [bill], cache: new Map(), metadata: new Map([['conversation', { title: 'Real title' }]]) } };
}

for (const newRun of [false, true]) {
  test(`unfinished turns ${newRun ? 'stop competing after a subsequent Cursor run' : 'still compete within the same Cursor run'}`, t => {
    const { log, options } = fixture(t);
    fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'orphan' })));
    const later = start + 60 * 60 * 1000;
    const nextLog = newRun ? log.replace('20261021T090000', '20261021T100000') : log;
    fs.mkdirSync(path.dirname(nextLog), { recursive: true });
    fs.appendFileSync(nextLog, block(later, payload({ hook_event_name: 'beforeSubmitPrompt' })) + block(later + 2000, payload()));
    const view = readCursorLocalSessions({ ...options, billingRows: [{ ...bill, eventTime: later + 1500 }] });
    assert.equal(view.sessions.today['cursor:conversation'].totalTokens, newRun ? 35 : 0);
    assert.equal(view.sessions.today['cursor:orphan'].tokenDataUnavailable, true);
  });
}

test('a subsequent run cannot complete an older run with a reused turn identity', t => {
  const { log, options } = fixture(t);
  fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt' })));
  const later = start + 60 * 60 * 1000;
  const nextLog = log.replace('20261021T090000', '20261021T100000');
  fs.mkdirSync(path.dirname(nextLog), { recursive: true });
  fs.writeFileSync(nextLog, block(later + 2000, payload()));
  const view = readCursorLocalSessions({ ...options, billingRows: [] });
  assert.equal(view.sessions.today['cursor:conversation'].tokenDataUnavailable, true);
  assert.equal(view.sessions.today['cursor:conversation'].totalTokens, 0);
});

test('a different desktop profile cannot retire an unfinished run', t => {
  const { log, options } = fixture(t, 'win32');
  options.env = { APPDATA: path.join(options.homeDir, 'alternate-roaming') };
  fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'orphan' })));
  const alternate = cursorDesktopStateCandidates({ home: options.homeDir, platform: 'win32', env: options.env })
    .find(file => !log.startsWith(path.resolve(path.dirname(file), '../../logs')));
  assert.ok(alternate);
  const later = start + 60 * 60 * 1000;
  const nextLog = path.join(path.resolve(path.dirname(alternate), '../../logs'),
    '20261021T100000/window1/output_100000/cursor.hooks.log');
  fs.mkdirSync(path.dirname(nextLog), { recursive: true });
  fs.writeFileSync(nextLog, block(later, payload({ hook_event_name: 'beforeSubmitPrompt' })) + block(later + 2000, payload()));
  const view = readCursorLocalSessions({ ...options, billingRows: [{ ...bill, eventTime: later + 1500 }] });
  assert.equal(view.sessions.today['cursor:conversation'].tokenDataUnavailable, true);
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`Cursor local details use the ${platform} desktop log layout`, t => {
    const { log, options } = fixture(t, platform);
    fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt' })) + block(start + 2000, payload()));
    const view = readCursorLocalSessions(options);
    assert.equal(view.sessions.today['cursor:conversation'].totalTokens, 35);
    assert.equal(Object.values(view.projects.today)[0].tokens, 35);
  });
}

test('hook parser retains only scalar identities, time, workspace and token counters', () => {
  const rows = parseHookLog(block(start, payload()));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, 'conversation');
  assert.equal(rows[0].projectPath, 'D:/work/project');
  assert.doesNotMatch(JSON.stringify(rows), /private|example|prompt/);
  assert.deepEqual(parseHookLog(block(start, payload()).split('\nOUTPUT:')[0]), []);
});

test('local sessions and projects recover a verified billing turn without duplicating accounting', t => {
  const { log, options } = fixture(t);
  const before = payload({ hook_event_name: 'beforeSubmitPrompt' });
  const stop = payload();
  fs.writeFileSync(log, block(start, before) + block(start + 2000, stop) + block(start + 2100, stop));
  const view = readCursorLocalSessions(options);
  const row = view.sessions.today['cursor:conversation'];
  assert.equal(row.title, 'Real title');
  assert.equal(row.totalTokens, 35);
  assert.equal(row.inputTokens, 10, 'Cursor input already includes cache reads');
  assert.equal(row.cacheReadTokens, 20);
  assert.equal(row.messageCount, 1, 'duplicate hooks must not duplicate calls');
  assert.equal(row.projectId, projectIdentity('d:/work/project').projectId);
  assert.equal(view.projects.today[row.projectId].tokens, 35);
  assert.equal(view.sessions.month['cursor:conversation'].totalTokens, 35);
  assert.equal(view.totalTokens, undefined, 'native detail is not an extra accounting source');
  const covered = readCursorLocalSessions({ ...options, periods: { today: { sessions: { 'cursor:conversation': row } } } });
  assert.equal(covered.sessions.today['cursor:conversation'], undefined);
  assert.deepEqual(covered.projects.today, {});
});

test('a current desktop login cannot assign another hook owner\'s historical billing', t => {
  const { log, options } = fixture(t);
  t.mock.method(cursorAuth, 'readCursorDesktopAccessToken', () => 'user_current::test-token');
  fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt' })) + block(start + 2000, payload()));
  const billingEmailHash = crypto.createHash('sha256').update('other@example.test').digest('hex');
  const view = readCursorLocalSessions({ ...options,
    billingRows: [{ ...bill, billingAccountId: 'user_current', billingEmailHash }] });
  assert.equal(view.sessions.today['cursor:conversation'].tokenDataUnavailable, true);
  assert.equal(view.sessions.today['cursor:conversation'].totalTokens, 0);
  const ownHash = crypto.createHash('sha256').update('private@example.test').digest('hex');
  const own = readCursorLocalSessions({ ...options,
    billingRows: [{ ...bill, billingAccountId: 'user_current', billingEmailHash: ownHash }] });
  assert.equal(own.sessions.today['cursor:conversation'].totalTokens, 35);
});

test('local turn counters restore details without a dashboard session or model attribution', t => {
  const { log, options } = fixture(t);
  fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt' }))
    + block(start + 2000, payload()) + block(start + 2100, payload()));
  const view = readCursorLocalSessions({ ...options, billingRows: [] });
  const row = view.sessions.today['cursor:conversation'];
  assert.equal(row.totalTokens, 35);
  assert.equal(row.inputTokens, 10, 'input includes cache and must not count it twice');
  assert.equal(row.cacheReadTokens, 20);
  assert.equal(row.tokenDataUnavailable, false);
  assert.equal(row.unpricedTokens, 35, 'a local token total does not establish billed cost');
  assert.equal(row.messageCount, 1);
  assert.deepEqual(row.models, {}, 'a turn total does not prove a per-model billing split');
  assert.equal(view.projects.today[row.projectId].tokens, 35);
  assert.equal(view.totalTokens, undefined);
  const covered = readCursorLocalSessions({ ...options, billingRows: [],
    periods: { today: { sessions: { 'cursor:conversation': row } } } });
  assert.equal(covered.sessions.today['cursor:conversation'], undefined);
  fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt' }))
    + block(start + 2000, payload({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 })));
  const zero = readCursorLocalSessions({ ...options, billingRows: [] }).sessions.today['cursor:conversation'];
  assert.equal(zero.totalTokens, 0);
  assert.equal(zero.tokenDataUnavailable, false, 'explicit complete zero counters remain known');
});

test('direct local counters require matching turn ownership and a complete valid vector', t => {
  const { log, options } = fixture(t);
  for (const [before, after] of [
    [null, payload()],
    [payload({ hook_event_name: 'beforeSubmitPrompt' }), payload({ user_email: 'other@example.test' })],
    [payload({ hook_event_name: 'beforeSubmitPrompt', user_email: null }), payload({ user_email: null })],
    [payload({ hook_event_name: 'beforeSubmitPrompt' }), payload({ output_tokens: undefined })],
    [payload({ hook_event_name: 'beforeSubmitPrompt' }), payload({ input_tokens: 10 })]
  ]) {
    fs.writeFileSync(log, (before ? block(start, before) : '') + block(start + 2000, after));
    const row = readCursorLocalSessions({ ...options, billingRows: [] }).sessions.today['cursor:conversation'];
    assert.equal(row.totalTokens, 0);
    assert.equal(row.tokenDataUnavailable, true);
  }
});

test('missing counters, mismatched bills and concurrent turns retain identity with unknown usage', t => {
  const { log, options } = fixture(t);
  fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt' }))
    + block(start + 2000, payload({ status: 'error', input_tokens: undefined })));
  let view = readCursorLocalSessions(options);
  assert.equal(view.sessions.today['cursor:conversation'].tokenDataUnavailable, true);
  assert.equal(Object.values(view.projects.today)[0].tokenDataUnavailable, true);
  fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt' })) + block(start + 2000, payload()));
  view = readCursorLocalSessions({ ...options, billingRows: [{ ...bill, outputTokens: 9, totalTokens: 39 }] });
  assert.equal(view.sessions.today['cursor:conversation'].tokenDataUnavailable, true);
  fs.appendFileSync(log, block(start + 100, payload({ conversation_id: 'other', generation_id: 'other', hook_event_name: 'beforeSubmitPrompt' }))
    + block(start + 2200, payload({ conversation_id: 'other', generation_id: 'other' })));
  view = readCursorLocalSessions(options);
  assert.ok(Object.values(view.sessions.today).every(row => row.tokenDataUnavailable));
});

test('periods use billing timestamps, honor project setting and drop deleted log cache entries', t => {
  const { log, options } = fixture(t);
  fs.writeFileSync(log, block(start, payload({ hook_event_name: 'beforeSubmitPrompt' })) + block(start + 2000, payload()));
  const view = readCursorLocalSessions({ ...options, projectsEnabled: false });
  assert.equal(view.sessions.today['cursor:conversation'].projectId, undefined);
  assert.deepEqual(view.projects.today, {});
  assert.equal(readCursorLocalSessions({ ...options, allTimeSince: '2026-11-01' }).sessions.allTime['cursor:conversation'], undefined);
  fs.unlinkSync(log);
  assert.deepEqual(readCursorLocalSessions(options).sessions.today, {});
  assert.equal(options.cache.size, 0);
});
