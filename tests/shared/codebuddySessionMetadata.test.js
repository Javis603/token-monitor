'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applySessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
const { mergePeriods } = require('../../src/shared/usage');
const { readSessionMetadata } = require('../../src/shared/providers/codebuddy/sessionMetadata');

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function fixture(lines) {
  const file = path.join(tmpDir('codebuddy-meta-'), 'session.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const title = (value) => JSON.stringify({ type: 'ai-title', aiTitle: value });
const turnMetrics = (durationMs, tokenDelta) => JSON.stringify({ type: 'turn-metrics', durationMs, tokenDelta });
const assistant = (status, messageId = `msg-${status}`) => JSON.stringify({
  type: 'message',
  role: 'assistant',
  status,
  providerData: { messageId }
});
const user = (text, providerData = {}) => JSON.stringify({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
  providerData
});

test('reads the newest ai-title, which is the session the client named', () => {
  // The client appends a fresh ai-title as the session evolves, so the last
  // non-empty one is the answer; a record that cleans down to nothing is not.
  const file = fixture([title('first name'), title('   '), title('the  current   name')]);
  assert.equal(readSessionMetadata(file, { cache: new Map() }).title, 'the current name');

  // A transcript the client never titled reports no title at all rather than an
  // empty one, which is what leaves the row on its client · model fallback.
  const untitled = fixture([user('hi')]);
  assert.equal(readSessionMetadata(untitled, { cache: new Map() }).title, '');
});

test('truncates a title at the shared code-point budget', () => {
  const file = fixture([title('x'.repeat(200))]);
  const read = readSessionMetadata(file, { cache: new Map() }).title;
  assert.equal(Array.from(read).length, 96);
  assert.ok(read.endsWith('…'));
});

test('reports the turn boundary from the newest response status', () => {
  // `status` is the response's own account of whether it finished, and the
  // newest one describes the current turn: a completion followed by an
  // `incomplete` stream is working again.
  const ended = fixture([assistant('completed')]);
  assert.equal(readSessionMetadata(ended, { cache: new Map() }).turnEnded, true);

  const working = fixture([assistant('completed'), assistant('incomplete', 'msg-2')]);
  assert.equal(readSessionMetadata(working, { cache: new Map() }).turnEnded, false);

  // A prompt accepted after the completion means that completion no longer
  // describes the current turn; without this the old status latched and a
  // session that had just been prompted kept reading as finished.
  const prompted = fixture([assistant('completed'), user('next thing')]);
  assert.equal(readSessionMetadata(prompted, { cache: new Map() }).turnEnded, false);

  // ...and the model answering again restores the reading.
  const answered = fixture([assistant('completed'), user('next thing'), assistant('completed', 'msg-2')]);
  assert.equal(readSessionMetadata(answered, { cache: new Map() }).turnEnded, true);
});

test('does not count harness user records as prompts', () => {
  // Slash commands, local command echo, compaction digests and teammate input
  // all arrive as `role: 'user'`. Counting one as a prompt would retire a real
  // completion and leave the session reading as working.
  const flagged = fixture([
    assistant('completed'),
    user('caveat', { skipRun: true }),
    user('meta', { isMeta: true }),
    user('summary', { isCompactInternal: true })
  ]);
  assert.equal(readSessionMetadata(flagged, { cache: new Map() }).turnEnded, true);

  // The same traffic also arrives with no flag at all, recognisable only by the
  // envelope the client opens it with.
  const enveloped = fixture([
    assistant('completed'),
    user('<system-reminder data-role="tool-hint">…</system-reminder>'),
    user('<local-command-stdout></local-command-stdout>'),
    user('<command-name>/clear</command-name>'),
    user('<teammate-message teammate_id="x">hi</teammate-message>'),
    user('   ')
  ]);
  assert.equal(readSessionMetadata(enveloped, { cache: new Map() }).turnEnded, true);

  // A real prompt that merely looks like markup is still a prompt.
  const real = fixture([assistant('completed'), user('<b>did this render?</b>')]);
  assert.equal(readSessionMetadata(real, { cache: new Map() }).turnEnded, false);
});

test('leaves the boundary unstated when no response has been recorded', () => {
  // `undefined` is "no evidence", which is deliberately distinct from `false`
  // ("a turn is under way"): only the latter may clear an earlier reading.
  const silent = fixture([user('hi'), title('named')]);
  assert.equal(readSessionMetadata(silent, { cache: new Map() }).turnEnded, undefined);
  assert.equal(readSessionMetadata('', { cache: new Map() }).turnEnded, undefined);
});

test('drops an oversized record instead of retaining it', () => {
  // The reading that can be lost to the line bound is a turn boundary, never a
  // title: the oversized records are tool output (a 2 MB function_call_result on
  // a real machine), while an ai-title record is a few hundred bytes. Dropping
  // leaves the previous reading in place, so the completion still stands.
  const huge = JSON.stringify({
    type: 'function_call_result',
    output: 'x'.repeat(100 * 1024),
    providerData: { callId: 'call-1' }
  });
  const file = fixture([assistant('completed'), title('named anyway'), huge]);
  const metadata = readSessionMetadata(file, { cache: new Map() });
  assert.equal(metadata.title, 'named anyway');
  assert.equal(metadata.turnEnded, true);

  // The record is dropped as a whole, so a prompt buried in one cannot retire
  // the completion either — the documented cost of the bound.
  const oversizedPrompt = JSON.stringify({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'y'.repeat(100 * 1024) }],
    providerData: {}
  });
  const promptFile = fixture([assistant('completed'), oversizedPrompt]);
  assert.equal(readSessionMetadata(promptFile, { cache: new Map() }).turnEnded, true);
});

test('sums turn-metrics into the raw throughput counters', () => {
  // tokscale reports no `performance` block for this client, so the per-turn
  // `durationMs`/`tokenDelta` records are the only duration evidence a
  // transcript holds — kept as the same raw sums the scan's entries carry for
  // every other client, so a row divides them into tok/s at display time.
  const file = fixture([turnMetrics(48945, 226885), assistant('completed'), turnMetrics(31733, 148816)]);
  const metadata = readSessionMetadata(file, { cache: new Map() });
  assert.equal(metadata.timedDurationMs, 80678);
  assert.equal(metadata.timedTokens, 375701);

  // A transcript that never measured a turn states nothing; an explicit 0 is
  // not forwarded as a measured zero.
  const silent = fixture([assistant('completed'), title('named')]);
  assert.equal(readSessionMetadata(silent, { cache: new Map() }).timedDurationMs, 0);

  // Malformed or non-positive figures never move a sum a row divides into a
  // headline tok/s.
  const malformed = fixture([
    turnMetrics(0, 5000),
    turnMetrics(-100, 5000),
    turnMetrics(1200, 'oops'),
    turnMetrics(800, 4000)
  ]);
  const read = readSessionMetadata(malformed, { cache: new Map() });
  assert.equal(read.timedDurationMs, 2000);
  assert.equal(read.timedTokens, 4000);
});

test('caches by file identity, size and mtime, and refreshes on append', () => {
  const cache = new Map();
  const file = fixture([title('before')]);
  assert.equal(readSessionMetadata(file, { cache }).title, 'before');
  assert.equal(cache.size, 1);

  // An untouched transcript is answered from the cache — a tick asks about every
  // session it knows, and re-reading idle files is the cost this avoids.
  assert.equal(readSessionMetadata(file, { cache }).title, 'before');

  // A transcript being written right now is re-read in full rather than resumed.
  fs.appendFileSync(file, `${title('after')}\n${assistant('incomplete')}\n${turnMetrics(2500, 9000)}\n`);
  const refreshed = readSessionMetadata(file, { cache });
  assert.equal(refreshed.title, 'after');
  assert.equal(refreshed.turnEnded, false);
  // The new turn's duration rides the same refresh — a live session's rate
  // follows the turn it is in the middle of.
  assert.equal(refreshed.timedDurationMs, 2500);
  assert.equal(refreshed.timedTokens, 9000);
});

test('decorates a session row through the shared metadata pass', () => {
  const home = tmpDir('codebuddy-home-');
  const sessionId = '01a07fd0-dc59-7af6-afa5-ef402c7a91ff';
  const cwd = path.join(home, '.codebuddy', 'projects', 'some-project');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    path.join(cwd, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }], timestamp: 1788851508705, cwd: '/Users/remix' })}\n`
      .concat(`${title('排查额度偏差')}\n`)
      .concat(`${assistant('completed')}\n`)
  );

  const periods = {
    today: { sessions: { [`codebuddy:${sessionId}`]: { client: 'codebuddy', sessionId } } },
    month: { sessions: {} },
    allTime: { sessions: {} }
  };
  applySessionMetadata(periods, home, {
    // Spread flat, the way the collector merges `sessionMetadataDeps` into the
    // deps object `applySessionMetadata` receives.
    codebuddyMetadataDeps: { cache: new Map() }
  });

  const session = periods.today.sessions[`codebuddy:${sessionId}`];
  assert.equal(session.title, '排查额度偏差');
  assert.equal(session.turnEnded, true);
  // Project identity rides the shared file reader, which reads `cwd` out of the
  // transcript — no CodeBuddy-specific project handling is needed for it.
  const identity = projectIdentity('/Users/remix');
  assert.equal(session.projectId, identity.projectId);
  assert.equal(session.projectLabel, identity.projectLabel);
});

test('fills the throughput counters the scan left empty', () => {
  // tokscale reports no `performance` block for this client, so the row's
  // counters arrive at 0 and the session would never show a tok/s reading.
  // The transcript's per-turn durations fill exactly that gap, as the same
  // raw sums every other client's entries carry.
  const home = tmpDir('codebuddy-throughput-');
  const sessionId = '01a1399e-7e04-7ae1-9e7e-6e922a4e73d3';
  const dir = path.join(home, '.codebuddy', 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${turnMetrics(48945, 226885)}\n${turnMetrics(31733, 148816)}\n${assistant('completed')}\n`
  );

  const periods = {
    today: {
      timedDurationMs: 0,
      timedTokens: 0,
      timedOutputTokens: 0,
      sessions: {
        [`codebuddy:${sessionId}`]: {
          client: 'codebuddy',
          sessionId,
          // The scan's own output total: the gate counts it whole against the
          // measured turns, on the same scale as every other client's row.
          outputTokens: 800,
          timedDurationMs: 0,
          timedTokens: 0,
          timedOutputTokens: 0
        }
      }
    },
    month: { sessions: {} },
    allTime: { sessions: {} }
  };
  const deps = { codebuddyMetadataDeps: { cache: new Map() } };
  applySessionMetadata(periods, home, deps);

  const session = periods.today.sessions[`codebuddy:${sessionId}`];
  assert.equal(session.timedDurationMs, 80678);
  // The session carries the two counters a row divides at display time;
  // `timedTokens` is a period-level total only, so it lands on the period.
  assert.equal(session.timedOutputTokens, 800);
  // The row divides these into its own reading: ~10 output tokens per second
  // of measured turn time, the scale a real session shows.
  assert.equal(Math.round(session.timedOutputTokens * 1000 / session.timedDurationMs), 10);

  // The period totals move with the session, so the footer's average and live
  // readings cover this client too.
  assert.equal(periods.today.timedDurationMs, 80678);
  assert.equal(periods.today.timedTokens, 375701);
  assert.equal(periods.today.timedOutputTokens, 800);

  // One tick decorates `today` more than once (progress emissions, then the
  // final pass); the guard skips a session the first pass filled, so the
  // totals move exactly once.
  applySessionMetadata(periods, home, deps);
  assert.equal(periods.today.timedDurationMs, 80678);
  assert.equal(periods.today.timedTokens, 375701);
  assert.equal(periods.today.timedOutputTokens, 800);
});

test('keeps the filled counters through the merge and normalize paths', () => {
  // A decorated session is rebuilt on its way out of the collector
  // (`mergeSession` off `emptySession`, then `normalizeSession`), and only
  // the fields those carry survive. The two display counters are exactly
  // what they carry — `timedTokens` stays period-level on purpose.
  const home = tmpDir('codebuddy-merge-throughput-');
  const sessionId = '01a1399e-7e04-7ae1-9e7e-6e922a4e73d3';
  const dir = path.join(home, '.codebuddy', 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${turnMetrics(48945, 226885)}\n${turnMetrics(31733, 148816)}\n${assistant('completed')}\n`
  );

  const periods = {
    today: {
      timedDurationMs: 0,
      timedTokens: 0,
      timedOutputTokens: 0,
      sessions: {
        [`codebuddy:${sessionId}`]: {
          client: 'codebuddy',
          sessionId,
          outputTokens: 800,
          timedDurationMs: 0,
          timedOutputTokens: 0
        }
      }
    },
    month: { sessions: {} },
    allTime: { sessions: {} }
  };
  applySessionMetadata(periods, home, { codebuddyMetadataDeps: { cache: new Map() } });

  // The merge path the collector runs on its way out rebuilds every session
  // off `emptySession`, so only the fields that path carries survive — and
  // the two display counters are exactly what it carries.
  const merged = mergePeriods(periods.today);
  const rebuilt = merged.sessions[`codebuddy:${sessionId}`];
  assert.equal(rebuilt.timedDurationMs, 80678);
  assert.equal(rebuilt.timedOutputTokens, 800);
});

test('leaves throughput alone when the scan already measured the session', () => {
  const home = tmpDir('codebuddy-scan-throughput-');
  const sessionId = '01a13a0f-0000-7000-8000-000000000001';
  const dir = path.join(home, '.codebuddy', 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${turnMetrics(48945, 226885)}\n`);

  const periods = {
    today: {
      timedDurationMs: 1234,
      timedTokens: 5678,
      timedOutputTokens: 90,
      sessions: {
        [`codebuddy:${sessionId}`]: {
          client: 'codebuddy',
          sessionId,
          outputTokens: 84723,
          timedDurationMs: 1234,
          timedTokens: 5678,
          timedOutputTokens: 90
        }
      }
    },
    month: { sessions: {} },
    allTime: { sessions: {} }
  };
  applySessionMetadata(periods, home, { codebuddyMetadataDeps: { cache: new Map() } });

  const session = periods.today.sessions[`codebuddy:${sessionId}`];
  assert.equal(session.timedDurationMs, 1234);
  assert.equal(session.timedTokens, 5678);
  assert.equal(session.timedOutputTokens, 90);
  assert.equal(periods.today.timedDurationMs, 1234);
});
