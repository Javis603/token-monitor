'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { codebuddyTurnThroughput, localDayStart } = require('../../src/shared/providers/codebuddy/turnThroughput');

// Windows are derived from the gap between records, so the fixture states
// timestamps directly; anything the reader is allowed to skip sits between the
// boundary and the response that reports usage.
function record(offsetMs, fields) {
  return JSON.stringify({ timestamp: DAY_START + offsetMs, ...fields });
}

function usage(output, total) {
  return { providerData: { rawUsage: { completion_tokens: output, total_tokens: total } } };
}

let DAY_START = localDayStart(Date.now());

function transcript(lines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-codebuddy-throughput-'));
  const sessionDir = path.join(home, '.codebuddy', 'projects', 'd--projects-demo');
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return { home, file, sessionDir };
}

test('measures each response from the record that fed it', () => {
  const { home } = transcript([
    record(0, { type: 'message', role: 'user', content: [] }),
    // Reasoning is written inside the response: it must not reset the window.
    record(2_000, { type: 'reasoning', providerData: {} }),
    record(4_000, { type: 'function_call', ...usage(400, 20_000) }),
    record(9_000, { type: 'function_call_result', name: 'Read' }),
    record(10_000, { type: 'message', role: 'assistant', ...usage(600, 21_000) })
  ]);
  const totals = codebuddyTurnThroughput({ homeDir: home, now: DAY_START + 60_000 });
  assert.deepEqual(totals, { timedDurationMs: 4_000 + 1_000, timedOutputTokens: 1_000, timedTokens: 41_000 });
});

test('turn boundaries close a window instead of spanning it', () => {
  const { home } = transcript([
    record(0, { type: 'message', role: 'user', content: [] }),
    record(1_000, { type: 'function_call', ...usage(100, 5_000) }),
    record(8_000, { type: 'function_call_result', name: 'Bash' }),
    // A finished turn: the next response must not be measured from before it.
    record(20_000, { type: 'turn-metrics', durationMs: 19_000, tokenDelta: 5_100 }),
    record(60_000, { type: 'message', role: 'user', content: [] }),
    record(62_000, { type: 'function_call', ...usage(100, 6_000) })
  ]);
  const totals = codebuddyTurnThroughput({ homeDir: home, now: DAY_START + 120_000 });
  assert.equal(totals.timedDurationMs, 1_000 + 2_000);
  assert.equal(totals.timedOutputTokens, 200);
});

test('drops windows that opened before today and files that ended before it', () => {
  const { home, file } = transcript([
    record(-30_000, { type: 'message', role: 'user', content: [] }),
    record(1_000, { type: 'function_call', ...usage(300, 9_000) }),
    record(-5_000, { type: 'message', role: 'user', content: [] }),
    record(-1_000, { type: 'function_call', ...usage(900, 9_000) })
  ]);
  // The window that ends today still counts, the one that ended yesterday does not.
  assert.equal(codebuddyTurnThroughput({ homeDir: home, now: DAY_START + 60_000 }).timedOutputTokens, 300);

  const yesterday = new Date(DAY_START - 24 * 60 * 60 * 1000);
  fs.utimesSync(file, yesterday, yesterday);
  assert.equal(codebuddyTurnThroughput({ homeDir: home, now: DAY_START + 61_000 }), null);
});

test('re-reads a transcript once it grows and keeps earlier totals stable', () => {
  const { home, file } = transcript([
    record(0, { type: 'message', role: 'user', content: [] }),
    record(3_000, { type: 'function_call', ...usage(500, 10_000) })
  ]);
  const first = codebuddyTurnThroughput({ homeDir: home, now: DAY_START + 60_000 });
  assert.equal(first.timedOutputTokens, 500);
  assert.deepEqual(codebuddyTurnThroughput({ homeDir: home, now: DAY_START + 61_000 }), first);

  fs.appendFileSync(file, '\n' + [
    record(9_000, { type: 'function_call_result', name: 'Read' }),
    record(12_000, { type: 'message', role: 'assistant', ...usage(250, 11_000) })
  ].join('\n'));
  const grown = codebuddyTurnThroughput({ homeDir: home, now: DAY_START + 62_000 });
  assert.equal(grown.timedOutputTokens, 750);
  assert.equal(grown.timedDurationMs, 6_000);
});

test('reports nothing rather than a zero rate when no record carries a window', () => {
  const { home } = transcript([
    record(0, { type: 'message', role: 'user', content: [] }),
    record(1_000, { type: 'session-meta', meta: {} })
  ]);
  assert.equal(codebuddyTurnThroughput({ homeDir: home, now: DAY_START + 60_000 }), null);
  assert.equal(codebuddyTurnThroughput({ homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tm-empty-')) }), null);
});
