'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CONTEXT_READ_WINDOW_MS, normalizeSessionContext, shouldReadSessionContext } = require('../../src/shared/sessionContext');
const { readCodexSessionContext, TAIL_READ_BUDGETS } = require('../../src/shared/providers/codex/sessionContext');
const { readDshSessionState } = require('../../src/shared/providers/dsh/sessionFiles');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');

const tmpDirs = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function tokenCountLine({ total, window: contextWindow, info }) {
  return JSON.stringify({
    timestamp: '2026-09-18T05:17:32.131Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: info === null ? null : {
        total_token_usage: { input_tokens: 999999, output_tokens: 1, total_tokens: 1000000 },
        last_token_usage: { input_tokens: total - 1, output_tokens: 1, total_tokens: total },
        model_context_window: contextWindow
      }
    }
  });
}

function responseLine(text) {
  return JSON.stringify({ type: 'response_item', payload: { type: 'message', text } });
}

function writeRollout(dir, name, lines) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

test('shouldReadSessionContext keeps the read to sessions that could still be open', () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  const inside = new Date(now - CONTEXT_READ_WINDOW_MS + 1000).toISOString();
  const outside = new Date(now - CONTEXT_READ_WINDOW_MS - 1000).toISOString();
  assert.equal(shouldReadSessionContext(inside, now), true);
  assert.equal(shouldReadSessionContext(outside, now), false);
  assert.equal(shouldReadSessionContext('', now), false);
  assert.equal(shouldReadSessionContext('not a date', now), false);
  // A transcript stamped ahead of this clock was just written, not written in
  // the future.
  assert.equal(shouldReadSessionContext(new Date(now + 60_000).toISOString(), now), true);
});

test('normalizeSessionContext requires both halves and reports overflow as reported', () => {
  assert.deepEqual(normalizeSessionContext({ contextTokens: 120, contextWindow: 200 }), { contextTokens: 120, contextWindow: 200 });
  assert.equal(normalizeSessionContext({ contextTokens: 0, contextWindow: 200 }), null);
  assert.equal(normalizeSessionContext({ contextTokens: 120, contextWindow: 0 }), null);
  assert.equal(normalizeSessionContext(null), null);
  assert.deepEqual(normalizeSessionContext({ contextTokens: 300, contextWindow: 200 }), { contextTokens: 300, contextWindow: 200 });

  // Non-scalars are rejected before coercion. The Codex reader passes parsed
  // transcript fields straight through, so without this a malformed record
  // would read as a real measurement: `Number(true)` is 1 and `Number([200])`
  // is 200, and the row would draw a gauge from it.
  assert.equal(normalizeSessionContext({ contextTokens: true, contextWindow: 200 }), null);
  assert.equal(normalizeSessionContext({ contextTokens: 120, contextWindow: [200] }), null);
  assert.equal(normalizeSessionContext({ contextTokens: {}, contextWindow: 200 }), null);
  assert.equal(normalizeSessionContext({ contextTokens: 120, contextWindow: null }), null);
  assert.equal(normalizeSessionContext({ contextTokens: '   ', contextWindow: 200 }), null);
  // Numeric strings are still accepted, since the DSH reader folds them.
  assert.deepEqual(normalizeSessionContext({ contextTokens: '150', contextWindow: '200' }), { contextTokens: 150, contextWindow: 200 });
});

test('readCodexSessionContext reads the newest reported window and last request', () => {
  const dir = tmpDir('codex-context-');
  const file = writeRollout(dir, 'rollout.jsonl', [
    tokenCountLine({ total: 10_000, window: 258_400 }),
    responseLine('a turn'),
    tokenCountLine({ total: 190_867, window: 950_000 }),
    responseLine('trailing output')
  ]);
  assert.deepEqual(readCodexSessionContext(file, { cache: new Map() }), {
    contextTokens: 190_867,
    contextWindow: 950_000
  });
});

test('readCodexSessionContext walks past a token_count that carries no usage', () => {
  const dir = tmpDir('codex-context-null-');
  const file = writeRollout(dir, 'rollout.jsonl', [
    tokenCountLine({ total: 42_000, window: 258_400 }),
    tokenCountLine({ info: null })
  ]);
  assert.deepEqual(readCodexSessionContext(file, { cache: new Map() }), {
    contextTokens: 42_000,
    contextWindow: 258_400
  });
});

test('readCodexSessionContext reports nothing until a transcript states a window', () => {
  const dir = tmpDir('codex-context-none-');
  const file = writeRollout(dir, 'rollout.jsonl', [responseLine('no usage yet'), 'not json at all']);
  assert.equal(readCodexSessionContext(file, { cache: new Map() }), null);
  assert.equal(readCodexSessionContext(path.join(dir, 'missing.jsonl'), { cache: new Map() }), null);
});
test('the turn-end marker is read from each client transcript that reports one', () => {
  const dir = tmpDir('turn-end-');
  const { readCodexTurnEnded } = require('../../src/shared/providers/codex/sessionContext');
  const event = (payload) => JSON.stringify({ timestamp: '2026-09-18T05:17:32.131Z', type: 'event_msg', payload });
  const finished = writeRollout(dir, 'finished.jsonl', [event({ type: 'task_started' }), event({ type: 'task_complete' })]);
  assert.equal(readCodexTurnEnded(finished, { cache: new Map() }), true);
  // A turn picked up after the last completion is generating again, so the
  // marker has to clear rather than latch.
  const generating = writeRollout(dir, 'generating.jsonl', [event({ type: 'task_complete' }), event({ type: 'task_started' })]);
  assert.equal(readCodexTurnEnded(generating, { cache: new Map() }), false);
  // An interrupted turn is finished too: nothing is generating.
  const aborted = writeRollout(dir, 'aborted.jsonl', [event({ type: 'task_started' }), event({ type: 'turn_aborted' })]);
  assert.equal(readCodexTurnEnded(aborted, { cache: new Map() }), true);
  // A transcript with no boundary at all reports nothing, which leaves the
  // caller on its time window rather than guessing.
  const silent = writeRollout(dir, 'silent.jsonl', [responseLine('no boundary here')]);
  assert.equal(readCodexTurnEnded(silent, { cache: new Map() }), undefined);
  assert.equal(readCodexTurnEnded(path.join(dir, 'missing.jsonl'), { cache: new Map() }), undefined);
});

test('readCodexSessionContext escalates the tail budget past one oversized turn', () => {
  const dir = tmpDir('codex-context-big-');
  const filler = responseLine('x'.repeat(4096));
  const lines = [tokenCountLine({ total: 77_000, window: 400_000 })];
  // More than the first budget of trailing output, so the newest reading is
  // only reachable on the second, larger read.
  while (lines.join('\n').length < TAIL_READ_BUDGETS[0] + 64 * 1024) lines.push(filler);
  const file = writeRollout(dir, 'rollout.jsonl', lines);
  assert.deepEqual(readCodexSessionContext(file, { cache: new Map() }), {
    contextTokens: 77_000,
    contextWindow: 400_000
  });
});

test('readCodexSessionContext re-reads only when the transcript changes', () => {
  const dir = tmpDir('codex-context-cache-');
  const file = writeRollout(dir, 'rollout.jsonl', [tokenCountLine({ total: 5_000, window: 200_000 })]);
  const cache = new Map();
  assert.deepEqual(readCodexSessionContext(file, { cache }), { contextTokens: 5_000, contextWindow: 200_000 });
  assert.equal(cache.size, 1);

  // An unchanged transcript answers from the cache rather than from the file:
  // replacing the cached reading in place is visible only if nothing is read.
  const [entry] = [...cache.values()];
  cache.set(file, { ...entry, context: { contextTokens: 1, contextWindow: 2 } });
  assert.deepEqual(readCodexSessionContext(file, { cache }), { contextTokens: 1, contextWindow: 2 });

  fs.appendFileSync(file, `${tokenCountLine({ total: 9_000, window: 200_000 })}\n`);
  assert.deepEqual(readCodexSessionContext(file, { cache }), { contextTokens: 9_000, contextWindow: 200_000 });
});

test('readDshSessionState folds the stated window and the newest occupancy', () => {
  const dir = tmpDir('dsh-context-');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id: 'session-1', createdAt: 1787137365000 }),
    JSON.stringify({ type: 'request/context', data: { provider: 'lmstudio', model: 'qwen3.6-35b-a3b', contextWindow: 262_144 } }),
    JSON.stringify({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1_715, outputTokens: 51 } } } }),
    JSON.stringify({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 1_869, outputTokens: 50 } } } }),
    // A provider that reports nothing for a request must not erase the reading
    // the previous one gave.
    JSON.stringify({ type: 'assistant/chunk', data: { turn: 2, step: 1, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } } } }),
    ''
  ].join('\n'));
  const state = readDshSessionState(file);
  assert.equal(state.contextWindow, 262_144);
  assert.equal(state.contextTokens, 1_919);
});

test('readDshSessionState takes the window of the model the session switched to', () => {
  const dir = tmpDir('dsh-context-switch-');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'request/context', data: { contextWindow: 131_072 } }),
    JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } } }),
    JSON.stringify({ type: 'request/context', data: { contextWindow: 262_144 } }),
    JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 20 } } } }),
    ''
  ].join('\n'));
  const state = readDshSessionState(file);
  assert.equal(state.contextWindow, 262_144);
  assert.equal(state.contextTokens, 220);
});

test('readDshSessionState clears a stale occupancy when the window changes', () => {
  const dir = tmpDir('dsh-context-reset-');
  const file = path.join(dir, 'session.jsonl');
  // A session that carried 190k of a 200k window and was then granted a 1M one:
  // the old occupancy is not a share of the new denominator, so keeping it would
  // report a nearly empty session. Nothing measured against the new window yet
  // means no reading until a usage chunk states one.
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'request/context', data: { contextWindow: 200_000 } }),
    JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 189_000, outputTokens: 1_000 } } } }),
    JSON.stringify({ type: 'request/context', data: { contextWindow: 1_000_000 } }),
    ''
  ].join('\n'));
  const switched = readDshSessionState(file);
  assert.equal(switched.contextWindow, 1_000_000);
  assert.equal(switched.contextTokens, 0, 'the old occupancy must not be re-paired with a new window');

  // A usage chunk against the new window restores a real reading.
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 300_000, outputTokens: 5_000 } } } }) + '\n');
  const repopulated = readDshSessionState(file, { offset: 0 });
  assert.equal(repopulated.contextWindow, 1_000_000);
  assert.equal(repopulated.contextTokens, 305_000);

  // A route change resets even when the advertised window is unchanged. These
  // records mark a provider/model/capacity change rather than a request — a real
  // DSH transcript here switches deepseek-v4-flash to deepseek-v4-pro, and both
  // advertise 1M — so the previous route's occupancy is not the new one's and
  // the reading has to wait for a usage chunk that belongs to the new route.
  const sameDir = tmpDir('dsh-context-same-');
  const sameFile = path.join(sameDir, 'session.jsonl');
  fs.writeFileSync(sameFile, [
    JSON.stringify({ type: 'request/context', data: { provider: 'p', model: 'a', contextWindow: 1_000_000 } }),
    JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 50_000, outputTokens: 1_000 } } } }),
    JSON.stringify({ type: 'request/context', data: { provider: 'p', model: 'b', contextWindow: 1_000_000 } }),
    ''
  ].join('\n'));
  const sameWindow = readDshSessionState(sameFile);
  assert.equal(sameWindow.contextWindow, 1_000_000);
  assert.equal(sameWindow.contextTokens, 0, 'an unchanged window is still a new route');

  // A route that advertises no capacity clears the old one rather than leaving
  // a gauge that never belonged to it.
  const noneDir = tmpDir('dsh-context-none-');
  const noneFile = path.join(noneDir, 'session.jsonl');
  fs.writeFileSync(noneFile, [
    JSON.stringify({ type: 'request/context', data: { model: 'a', contextWindow: 200_000 } }),
    JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 189_000, outputTokens: 1_000 } } } }),
    JSON.stringify({ type: 'request/context', data: { model: 'b' } }),
    ''
  ].join('\n'));
  const noWindow = readDshSessionState(noneFile);
  assert.equal(noWindow.contextWindow, 0, 'a route with no stated capacity has no gauge');
  assert.equal(noWindow.contextTokens, 0);
});

test('applySessionMetadata stamps context only on a session recent enough to still be open', () => {
  const home = tmpDir('codex-home-');
  const sessionsDir = path.join(home, '.codex', 'sessions', '2026', '09', '18');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const liveId = 'rollout-2026-09-18T05-00-00-01a0affa-4ffd-7653-a02c-785f96f419ce';
  const staleId = 'rollout-2026-09-18T01-00-00-01a0affa-4ffd-7653-a02c-785f96f419cf';
  const now = Date.parse('2026-09-18T06:00:00.000Z');
  for (const [id, minutesAgo] of [[liveId, 2], [staleId, 240]]) {
    const file = path.join(sessionsDir, `${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({
      timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 123_456 },
          model_context_window: 950_000
        }
      }
    })}\n`);
  }
  const session = (id) => ({ client: 'codex', sessionId: id, totalTokens: 1, models: {}, modelCosts: {}, providers: {} });
  const periods = {
    today: {
      sessions: {
        [`codex:${liveId}`]: session(liveId),
        [`codex:${staleId}`]: session(staleId)
      }
    }
  };
  applySessionMetadata(periods, home, { now, env: {}, resolveProjects: false });

  const live = periods.today.sessions[`codex:${liveId}`];
  assert.equal(live.contextTokens, 123_456);
  assert.equal(live.contextWindow, 950_000);
  const stale = periods.today.sessions[`codex:${staleId}`];
  assert.equal(stale.contextTokens, undefined);
  assert.equal(stale.contextWindow, undefined);
});
