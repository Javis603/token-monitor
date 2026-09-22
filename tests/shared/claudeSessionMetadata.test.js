'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  TITLE_MAX_CODE_POINTS,
  TITLE_READ_CHUNK_BYTES,
  claudeContextWindow,
  cleanTitle,
  readSessionContext,
  readSessionTitle
} = require('../../src/shared/providers/claude/sessionMetadata');

function fixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-claude-title-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { dir, file };
}

test('readSessionTurnEnded follows the newest stop_reason, and tool_use is not an end', (t) => {
  // Claude stamps every assistant record with why it stopped. `tool_use` means
  // it paused to run tools and is still mid-turn; anything else means nothing
  // further is being generated. Treating tool_use as an end would mark almost
  // every working session as finished, which is the opposite mistake.
  const { readSessionTurnEnded } = require('../../src/shared/providers/claude/sessionMetadata');
  const assistant = (stop) => JSON.stringify({ type: 'assistant', message: { id: `msg_${stop}`, stop_reason: stop } });

  const ended = fixture([assistant('tool_use'), assistant('end_turn')]);
  t.after(() => fs.rmSync(ended.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(ended.file, { cache: new Map() }), true);

  // The newest record wins: a tool_use after an end_turn is working again.
  const working = fixture([assistant('end_turn'), assistant('tool_use')]);
  t.after(() => fs.rmSync(working.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(working.file, { cache: new Map() }), false);

  // max_tokens and stop_sequence are ends too: generation stopped.
  const truncated = fixture([assistant('max_tokens')]);
  t.after(() => fs.rmSync(truncated.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(truncated.file, { cache: new Map() }), true);

  // A transcript that never recorded one reports no evidence rather than
  // guessing, which is distinct from `false` ("a turn is under way").
  const silent = fixture([JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
  t.after(() => fs.rmSync(silent.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(silent.file, { cache: new Map() }), undefined);
  assert.equal(readSessionTurnEnded('', { cache: new Map() }), undefined);

  // A prompt accepted after a completion starts the next turn, so that
  // completion no longer describes the current one. Without this the old
  // `end_turn` latched and a session that had just been prompted still read as
  // finished — which is what a real transcript did on 57 of 196 sessions.
  const prompted = fixture([assistant('end_turn'), JSON.stringify({ type: 'user', message: { content: 'next thing' } })]);
  t.after(() => fs.rmSync(prompted.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(prompted.file, { cache: new Map() }), false);

  // ...and the assistant answering again restores the reading.
  const answered = fixture([
    assistant('end_turn'),
    JSON.stringify({ type: 'user', message: { content: 'next thing' } }),
    assistant('end_turn')
  ]);
  t.after(() => fs.rmSync(answered.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(answered.file, { cache: new Map() }), true);

  // A tool_result shares the user type and must NOT retire the completion:
  // it is the plumbing of the turn in progress (14070 of 16393 user records on
  // one real machine), so treating it as a prompt would mark every working
  // session finished.
  const toolResult = fixture([
    assistant('end_turn'),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
  ]);
  t.after(() => fs.rmSync(toolResult.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(toolResult.file, { cache: new Map() }), true);

  // Neither does client bookkeeping that rides the same type.
  const bookkeeping = fixture([
    assistant('end_turn'),
    JSON.stringify({ type: 'user', isMeta: true, message: { content: 'caveat text' } })
  ]);
  t.after(() => fs.rmSync(bookkeeping.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(bookkeeping.file, { cache: new Map() }), true);

  // The state survives the append-only resume, which rebuilds the index from the
  // cached one rather than re-reading the whole file. A field dropped from that
  // carry-over silently reverts to the empty default on the next tick, so a
  // completion would come back from the dead the moment the transcript grows.
  const appended = fixture([assistant('end_turn')]);
  t.after(() => fs.rmSync(appended.dir, { recursive: true, force: true }));
  const appendCache = new Map();
  assert.equal(readSessionTurnEnded(appended.file, { cache: appendCache }), true);
  fs.appendFileSync(appended.file, JSON.stringify({ type: 'user', message: { content: 'keep going' } }) + '\n');
  assert.equal(readSessionTurnEnded(appended.file, { cache: appendCache }), false, 'the prompt must survive the append resume');

  // The three states are distinct, and a caller has to be able to tell them
  // apart: `true` = finished, `false` = a turn is under way, `undefined` = the
  // transcript states nothing. Collapsing the last two is what let a stale
  // `true` from an earlier tick survive, since only an explicit `false` can
  // clear it.
  const waiting = fixture([assistant('end_turn'), JSON.stringify({ type: 'user', message: { content: 'go' } })]);
  t.after(() => fs.rmSync(waiting.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(waiting.file, { cache: new Map() }), false, 'a waiting prompt is active, not unknown');

  const midTool = fixture([assistant('tool_use')]);
  t.after(() => fs.rmSync(midTool.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(midTool.file, { cache: new Map() }), false, 'a tool pause is active, not unknown');

  // A record too large to hold is still read for its boundary. The scanner
  // drops anything past its line budget to bound memory, and the turn state
  // rides the same pass — so a pasted screenshot (real ones here reach 1.9 MB,
  // and 476 records exceed the 64 KiB guard) used to take the prompt with it and
  // leave the previous completion latched.
  const Huge = 'z'.repeat(300 * 1024);
  const bigPrompt = fixture([assistant('end_turn'), JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: Huge }] } })]);
  t.after(() => fs.rmSync(bigPrompt.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(bigPrompt.file, { cache: new Map() }), false, 'an oversized prompt is still a prompt');

  // ...and an oversized record that is NOT a prompt must not be mistaken for one.
  const bigToolResult = fixture([
    assistant('end_turn'),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: Huge }] } })
  ]);
  t.after(() => fs.rmSync(bigToolResult.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(bigToolResult.file, { cache: new Map() }), true, 'an oversized tool_result does not retire the completion');

  // Client bookkeeping rides the same oversized shape.
  const bigMeta = fixture([assistant('end_turn'), JSON.stringify({ type: 'user', isMeta: true, message: { content: Huge } })]);
  t.after(() => fs.rmSync(bigMeta.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(bigMeta.file, { cache: new Map() }), true, 'an oversized meta record is not a prompt');

  // An oversized ASSISTANT record closes with the field that decides the turn,
  // and on a record larger than one 256 KiB read chunk those closing bytes
  // arrive in the next chunk. They used to be dropped before the fragment scan
  // ran, so the reading from before the record survived: a huge answer that
  // paused for tools still looked like the finished turn it replaced.
  const bigAssistant = (stopReason) => JSON.stringify({
    type: 'assistant',
    message: { id: `msg_${stopReason}`, content: Huge, stop_reason: stopReason }
  });
  const stopped = fixture([assistant('end_turn'), bigAssistant('tool_use')]);
  t.after(() => fs.rmSync(stopped.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(stopped.file, { cache: new Map() }), false, 'the oversized assistant paused for tools');

  const finished = fixture([assistant('tool_use'), bigAssistant('end_turn')]);
  t.after(() => fs.rmSync(finished.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(finished.file, { cache: new Map() }), true, 'the oversized assistant finished the turn');

  // A transcript being written right now has no trailing newline at all, so the
  // oversized record ends at EOF rather than at a newline.
  const unterminated = fixture([]);
  t.after(() => fs.rmSync(unterminated.dir, { recursive: true, force: true }));
  fs.writeFileSync(unterminated.file, bigAssistant('end_turn'));
  assert.equal(readSessionTurnEnded(unterminated.file, { cache: new Map() }), true, 'an oversized record at EOF is still read');
  fs.writeFileSync(unterminated.file, bigAssistant('tool_use'));
  assert.equal(readSessionTurnEnded(unterminated.file, { cache: new Map() }), false, '...and its reason is the newer one');

  // EOF is often only a write boundary, not the end of the record: a transcript
  // being appended to stops mid-record, and the next tick reads only the new
  // bytes. The fragments therefore have to survive, or the suffix that arrives
  // later carries no head and can never be recognised as an assistant record
  // again — the completion would be lost for good.
  const resume = fixture([]);
  t.after(() => fs.rmSync(resume.dir, { recursive: true, force: true }));
  const resumeCache = new Map();
  const parted = bigAssistant('tool_use');
  const cut = parted.indexOf('"stop_reason"');
  // The earlier records are complete; only the oversized one is mid-write, so it
  // is unterminated exactly as a live transcript is.
  fs.writeFileSync(resume.file, [
    assistant('end_turn'),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'go on' }] } })
  ].join('\n') + '\n' + parted.slice(0, cut));
  // Half-written: the prompt already retired the old completion, and the new
  // record states no reason yet.
  assert.equal(readSessionTurnEnded(resume.file, { cache: resumeCache }), false, 'a half-written answer is not a finished turn');
  // The writer finishes the record on a later tick, same cache.
  fs.appendFileSync(resume.file, parted.slice(cut) + '\n');
  assert.equal(readSessionTurnEnded(resume.file, { cache: resumeCache }), false, 'the appended stop_reason is read');

  // ...and the same resume can turn the reading back on.
  const resumeEnded = fixture([]);
  t.after(() => fs.rmSync(resumeEnded.dir, { recursive: true, force: true }));
  const endedCache = new Map();
  const endedPart = bigAssistant('end_turn');
  const endedCut = endedPart.indexOf('"stop_reason"');
  fs.writeFileSync(resumeEnded.file, [
    assistant('tool_use'),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'go on' }] } })
  ].join('\n') + '\n' + endedPart.slice(0, endedCut));
  assert.equal(readSessionTurnEnded(resumeEnded.file, { cache: endedCache }), false, 'still generating');
  fs.appendFileSync(resumeEnded.file, endedPart.slice(endedCut) + '\n');
  assert.equal(readSessionTurnEnded(resumeEnded.file, { cache: endedCache }), true, 'the completed answer is read from the suffix');

  // The oversized path has to accept exactly what the ordinary parser accepts,
  // or the same record is a prompt when it fits on one line and not a prompt
  // when it does not. A plain string content is one of those shapes: Claude
  // writes it for a pasted blob, and `isUserPrompt` already treats it as a real
  // prompt, while the fragment scan used to look only for array blocks.
  const stringPrompt = fixture([assistant('end_turn'), JSON.stringify({ type: 'user', message: { content: Huge } })]);
  t.after(() => fs.rmSync(stringPrompt.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(stringPrompt.file, { cache: new Map() }), false, 'an oversized string prompt is still a prompt');

  // ...and a blank string is not one, which the ordinary parser also rejects.
  const blankString = fixture([assistant('end_turn'), JSON.stringify({ type: 'user', message: { content: ' '.repeat(300 * 1024) } })]);
  t.after(() => fs.rmSync(blankString.dir, { recursive: true, force: true }));
  assert.equal(readSessionTurnEnded(blankString.file, { cache: new Map() }), true, 'whitespace is not a prompt at any size');

  // The title still resolves from the same shared index, so asking for both
  // costs one pass rather than two.
  const both = fixture([
    JSON.stringify({ type: 'ai-title', aiTitle: 'Shared pass' }),
    assistant('end_turn')
  ]);
  t.after(() => fs.rmSync(both.dir, { recursive: true, force: true }));
  const cache = new Map();
  assert.equal(readSessionTurnEnded(both.file, { cache }), true);
  assert.equal(readSessionTitle(both.file, { cache }), 'Shared pass');
});

test('Claude session context uses the latest API input occupancy and model capacity', (t) => {
  const assistant = ({ model, input, write, read, output = 0 }) => JSON.stringify({
    type: 'assistant',
    message: {
      model,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: write,
        cache_read_input_tokens: read,
        output_tokens: output
      }
    }
  });
  const { dir, file } = fixture([
    assistant({ model: 'claude-sonnet-4-5-20250929', input: 500, write: 1_000, read: 48_000 }),
    assistant({ model: 'claude-opus-5', input: 700, write: 2_000, read: 120_000, output: 9_999 })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    // Claude Code's official used_percentage excludes output_tokens.
    contextTokens: 122_700,
    contextWindow: 1_000_000
  });
  assert.equal(claudeContextWindow('claude-sonnet-4-5-20250929'), 200_000);
  assert.equal(claudeContextWindow('claude-opus-4-6'), 200_000);
  assert.equal(claudeContextWindow('us.anthropic.claude-opus-4-8-v1:0'), 200_000);
  assert.equal(claudeContextWindow('us.anthropic.claude-sonnet-5-v1:0'), 1_000_000);
  assert.equal(claudeContextWindow('global.anthropic.claude-sonnet-5-v1:0'), 1_000_000);
  assert.equal(claudeContextWindow('anthropic.claude-sonnet-5'), 1_000_000);
  assert.equal(claudeContextWindow('gateway/anthropic.claude-sonnet-5'), 200_000);
  assert.equal(claudeContextWindow('deepseek-v4.1-flash'), 200_000);
  assert.equal(claudeContextWindow('deepseek-v4.1-flash[1m]'), 1_000_000);
  assert.equal(claudeContextWindow('claude-ocx2-command-code--deepseek-v4.1-flash'), 200_000);
  assert.equal(claudeContextWindow(''), 0);
});

test('Claude session context clears on compaction and repopulates on the next response', (t) => {
  const usage = (tokens) => JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-haiku-4-5-20251001',
      stop_reason: 'end_turn',
      usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  });
  const { dir, file } = fixture([usage(80_000)]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new Map();

  assert.deepEqual(readSessionContext(file, { cache }), { contextTokens: 80_000, contextWindow: 200_000 });
  fs.appendFileSync(file, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: {} })}\n`);
  assert.deepEqual(readSessionContext(file, { cache }), { contextTokens: 0, contextWindow: 0 });
  fs.appendFileSync(file, `${usage(12_000)}\n`);
  assert.deepEqual(readSessionContext(file, { cache }), { contextTokens: 12_000, contextWindow: 200_000 });
  fs.appendFileSync(file, `${JSON.stringify({
    type: 'user',
    isCompactSummary: true,
    message: { content: 'x'.repeat(300 * 1024) }
  })}\n`);
  assert.deepEqual(readSessionContext(file, { cache }), { contextTokens: 0, contextWindow: 0 });
});

test('Claude session context survives oversized assistant field ordering', (t) => {
  const contentFirst = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_big',
      type: 'message',
      role: 'assistant',
      content: 'x'.repeat(300 * 1024),
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1_000, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 300_000 }
    }
  });
  const modelFirst = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_bigger',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: 'x'.repeat(300 * 1024),
      stop_reason: 'end_turn',
      usage: { input_tokens: 4_000, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 600_000 }
    }
  });
  const nestedUsage = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_nested_usage',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'x'.repeat(300 * 1024) },
        {
          type: 'tool_use',
          input: {
            model: 'nested-model',
            usage: { input_tokens: 7 }
          }
        }
      ],
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 4_000, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 600_000 }
    }
  });
  const { dir, file } = fixture([contentFirst]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 303_000,
    contextWindow: 1_000_000
  });

  fs.writeFileSync(file, `${modelFirst}\n`);
  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 609_000,
    contextWindow: 1_000_000
  });

  fs.writeFileSync(file, `${nestedUsage}\n`);
  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 609_000,
    contextWindow: 1_000_000
  });
});

test('Claude session context ignores malformed usage instead of clearing a valid reading', (t) => {
  const valid = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn',
      usage: { input_tokens: 20_000, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 50_000 }
    }
  });
  const malformed = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      usage: { cache_creation_input_tokens: 2_000, cache_read_input_tokens: 100_000 }
    }
  });
  const { dir, file } = fixture([valid, malformed]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 71_000,
    contextWindow: 200_000
  });
});

test('Claude session context keeps its reading through zero-occupancy client notices', (t) => {
  // Claude writes its own turns as assistant records with a full `usage`
  // object whose counters are all zero: the session-limit notice, an API
  // error, and the "No response requested." acknowledgement. Each is a valid
  // record but not a measurement, and treating it as one blanked a gauge whose
  // window still held the previous turn. On one real machine 38 transcripts
  // ended on one of these, 27 of them the session-limit notice.
  const assistant = (usage, model = 'claude-opus-5') => JSON.stringify({
    type: 'assistant',
    message: { model, stop_reason: 'stop_sequence', usage }
  });
  const zeroed = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  const { dir, file } = fixture([
    assistant({ input_tokens: 2_000, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 254_936 })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new Map();

  assert.deepEqual(readSessionContext(file, { cache }), { contextTokens: 257_936, contextWindow: 1_000_000 });

  fs.appendFileSync(file, `${assistant(zeroed, '<synthetic>')}\n`);
  assert.deepEqual(readSessionContext(file, { cache }), {
    contextTokens: 257_936,
    contextWindow: 1_000_000
  });

  // Still measured against the model that actually answered, so a later turn
  // replaces it rather than the notice pinning the old reading.
  fs.appendFileSync(file, `${assistant({ input_tokens: 1_500, cache_creation_input_tokens: 0, cache_read_input_tokens: 51_000 })}\n`);
  assert.deepEqual(readSessionContext(file, { cache }), { contextTokens: 52_500, contextWindow: 1_000_000 });
});

test('oversized records are recognized when the root discriminator lands past the head', (t) => {
  // Claude serializes a record's `message` before its root `type`. An oversized
  // `content` therefore pushes the root discriminator past the 64 KiB head, so
  // reading the head alone classified the record as neither assistant nor user:
  // the context reading stayed at the previous turn, and an oversized prompt did
  // not start a new one. Every oversized assistant record on one real machine
  // put `"type":"assistant"` at byte 68k-93k, never inside the head.
  const huge = 'x'.repeat(300 * 1024);
  const { readSessionTurnEnded } = require('../../src/shared/providers/claude/sessionMetadata');
  const realAssistant = JSON.stringify({
    parentUuid: 'p1',
    isSidechain: false,
    message: {
      id: 'msg_big',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: huge }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2_000, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 254_936, output_tokens: 40 }
    },
    apiBlockIndex: 0,
    type: 'assistant',
    uuid: 'u1',
    timestamp: '2026-01-01T00:00:00.000Z'
  });
  const prior = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_prior', model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 51_000 } }
  });
  const realPrompt = JSON.stringify({
    parentUuid: 'p2',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'text', text: huge }] },
    apiBlockIndex: 0,
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-01-01T00:00:01.000Z'
  });
  const finished = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_done', model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } }
  });

  const { dir, file } = fixture([prior, realAssistant]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 257_936,
    contextWindow: 1_000_000
  });

  fs.writeFileSync(file, `${finished}\n${realPrompt}\n`);
  assert.equal(readSessionTurnEnded(file, { cache: new Map() }), false, 'an oversized prompt still starts a turn');

  // The in-head role is the reliable signal, so a tool input naming another
  // record type must not change how the record is read.
  const nestedType = JSON.stringify({
    parentUuid: 'p3',
    isSidechain: false,
    message: {
      id: 'msg_nested',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', input: { type: 'user', text: huge } }],
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 3_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 40_000 }
    },
    apiBlockIndex: 0,
    type: 'assistant',
    uuid: 'u3',
    timestamp: '2026-01-01T00:00:02.000Z'
  });
  fs.writeFileSync(file, `${nestedType}\n`);
  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 43_000,
    contextWindow: 1_000_000
  });
  assert.equal(readSessionTurnEnded(file, { cache: new Map() }), false, 'a tool_use pause is not an end');
});

test('Claude session context distinguishes absent from malformed optional cache counters', (t) => {
  const assistant = (usage) => JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn',
      usage
    }
  });
  const { dir, file } = fixture([
    assistant({ input_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 20_000 }),
    assistant({ input_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 'broken' })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 120_000,
    contextWindow: 200_000
  });

  fs.writeFileSync(file, `${assistant({
    input_tokens: 100_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 20_000
  })}\n${assistant({
    input_tokens: 1_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1.5
  })}\n`);
  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 120_000,
    contextWindow: 200_000
  });

  fs.writeFileSync(file, `${assistant({
    input_tokens: 100_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 20_000
  })}\n${assistant({
    input_tokens: '1.5',
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  })}\n`);
  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 120_000,
    contextWindow: 200_000
  });

  const oversizedMalformed = JSON.stringify({
    type: 'assistant',
    message: {
      content: 'x'.repeat(300 * 1024),
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 'broken' }
    }
  });
  fs.writeFileSync(file, `${assistant({
    input_tokens: 100_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 20_000
  })}\n${oversizedMalformed}\n`);
  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 120_000,
    contextWindow: 200_000
  });

  fs.writeFileSync(file, `${assistant({ input_tokens: 50_000 })}\n`);
  assert.deepEqual(readSessionContext(file, { cache: new Map() }), {
    contextTokens: 50_000,
    contextWindow: 200_000
  });
});

test('Claude session metadata reads the persisted AI title without exposing prompts', (t) => {
  const { dir, file } = fixture([
    JSON.stringify({ type: 'user', message: { content: 'private prompt' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: '  Improve   session list  ' }),
    JSON.stringify({ type: 'assistant', message: { content: 'private answer' } })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(readSessionTitle(file), 'Improve session list');
});

test('Claude session metadata stays empty when no AI title was persisted', (t) => {
  const { dir, file } = fixture([
    JSON.stringify({ type: 'user', message: { content: 'do not use this as a title' } })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(readSessionTitle(file), '');
});

test('Claude session metadata prefers a persisted custom title', (t) => {
  const { dir, file } = fixture([
    JSON.stringify({ type: 'ai-title', aiTitle: 'Generated title' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My own title' })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(readSessionTitle(file), 'My own title');
});

test('Claude session metadata invalidates a cached miss when the transcript grows', (t) => {
  const { dir, file } = fixture([JSON.stringify({ type: 'user' })]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new Map();

  assert.equal(readSessionTitle(file, { cache }), '');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Arrived later' })}\n`);
  assert.equal(readSessionTitle(file, { cache }), 'Arrived later');
});

test('Claude session metadata finds a custom title anywhere in a long transcript', (t) => {
  const padding = `${JSON.stringify({ type: 'user', padding: 'x'.repeat(TITLE_READ_CHUNK_BYTES * 2) })}\n`;
  const { dir, file } = fixture([]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(file, `${padding}${JSON.stringify({ type: 'custom-title', customTitle: 'Middle title' })}\n${padding}`);
  assert.equal(readSessionTitle(file, { cache: new Map() }), 'Middle title');
});

test('Claude session metadata keeps a discovered custom title and reads only appended bytes', (t) => {
  const longTitle = 'x'.repeat(TITLE_MAX_CODE_POINTS + 20);
  const padding = `${JSON.stringify({ type: 'user', padding: 'x'.repeat(TITLE_READ_CHUNK_BYTES * 2) })}\n`;
  const { dir, file } = fixture([
    JSON.stringify({ type: 'custom-title', customTitle: longTitle })
  ]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new Map();
  let bytesRead = 0;
  const measuredFs = {
    ...fs,
    readSync(...args) {
      const count = fs.readSync(...args);
      bytesRead += count;
      return count;
    }
  };

  assert.equal(Array.from(cleanTitle(longTitle)).length, TITLE_MAX_CODE_POINTS);
  assert.equal(readSessionTitle(file, { cache, fs: measuredFs }), cleanTitle(longTitle));

  fs.appendFileSync(file, padding);
  const appendedBytes = Buffer.byteLength(padding);
  bytesRead = 0;
  assert.equal(readSessionTitle(file, { cache, fs: measuredFs }), cleanTitle(longTitle));
  assert.equal(bytesRead, appendedBytes);
});

test('Claude session metadata indexes title records appended before a large write', (t) => {
  const { dir, file } = fixture([JSON.stringify({ type: 'ai-title', aiTitle: 'Generated title' })]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = new Map();

  assert.equal(readSessionTitle(file, { cache }), 'Generated title');
  fs.appendFileSync(file, [
    JSON.stringify({ type: 'custom-title', customTitle: 'Renamed title' }),
    JSON.stringify({ type: 'user', padding: 'x'.repeat(TITLE_READ_CHUNK_BYTES * 2) })
  ].join('\n') + '\n');

  assert.equal(readSessionTitle(file, { cache }), 'Renamed title');
});
