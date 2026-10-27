'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readSessionTitle } = require('../../src/shared/providers/claude/sessionMetadata');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const { normalizePeriod, mergePeriods, applyPeriodDelta } = require('../../src/shared/usage');
const { updateSessionUsageArchive, normalizeSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');

const at = '2026-10-25T10:00:00.000Z';
const next = '2026-10-25T10:01:00.000Z';
const record = entry => JSON.stringify(entry) + '\n';
const assistant = extra => ({ type: 'assistant', message: { model: 'claude-opus-5', content: [], stop_reason: 'end_turn' }, ...extra });
const prompt = extra => ({ type: 'user', message: { content: 'Next task' }, ...extra });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-effort-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'projects', 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const cache = new Map();
  let bytesRead = 0;
  const deps = { cache, fs: { ...fs, readSync(...args) {
    const count = fs.readSync(...args); bytesRead += count; return count;
  } } };
  const read = () => { readSessionTitle(file, deps); return cache.get(file)?.reasoningEffort; };
  return { home, file, cache, deps, read, bytesRead: () => bytesRead };
}

test('Claude effort shares the title scan and append cache, with per-turn overrides', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, record(assistant({ effort: 'high' })));
  assert.equal(f.read(), 'high');
  const bytes = f.bytesRead();
  assert.equal(f.read(), 'high');
  assert.equal(f.bytesRead(), bytes, 'unchanged index adds no file read');
  for (const [fields, expected] of [
    [{ effort: 'high', perTurnEffort: 'low' }, 'low'],
    [{ effort: 'xhigh', perTurnEffort: null }, 'xhigh'],
    [{ perTurnEffort: 'max' }, 'max'],
    [{ effort: 'medium' }, 'medium'],
    [{ effort: 'high', perTurnEffort: '<script>' }, null],
    [{ effort: null }, null], [{}, null]
  ]) {
    fs.appendFileSync(f.file, record(assistant(fields)));
    assert.equal(f.read(), expected);
  }
  assert.equal(f.bytesRead(), fs.statSync(f.file).size, 'only appended bytes are scanned');
});

test('Claude new prompts clear effort while bookkeeping, children and API errors do not replace it', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, record(assistant({ effort: 'high' })));
  for (const entry of [
    prompt({ message: { content: [{ type: 'tool_result', content: 'done' }] } }),
    prompt({ isMeta: true }), prompt({ isCompactSummary: true }),
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'api-request-blob', message: { role: 'system', content: [{ type: 'text', text: 'Request metadata' }] } },
    assistant({ isSidechain: true, effort: 'low' }),
    assistant({ isApiErrorMessage: true, perTurnEffort: 'low' })
  ]) {
    fs.appendFileSync(f.file, record(entry));
    assert.equal(f.read(), 'high');
  }
  fs.appendFileSync(f.file, record(prompt()));
  assert.equal(f.read(), null);
  const response = record(assistant({ effort: 'low' })).trimEnd();
  fs.appendFileSync(f.file, response.slice(0, -2));
  assert.equal(f.read(), null, 'partial response does not invent a setting');
  fs.appendFileSync(f.file, response.slice(-2));
  assert.equal(f.read(), 'low', 'complete record without newline is accepted');
  fs.writeFileSync(f.file, record({ type: 'custom-title', customTitle: 'Older client' }));
  assert.equal(f.read(), undefined, 'replacement without configuration supplies no evidence');
});

for (const size of [10, 600_000]) test(`Claude ${size}-byte response content without configuration or a stop reason preserves effort`, t => {
  const f = fixture(t);
  const message = stop_reason => ({ content: [{ type: 'text', text: 'x'.repeat(size) }], stop_reason });
  fs.writeFileSync(f.file, record(assistant({ effort: 'high' })));
  assert.equal(f.read(), 'high');
  for (const reason of [null, undefined, '', 7]) {
    fs.appendFileSync(f.file, record(assistant({ message: message(reason) })));
    assert.equal(f.read(), 'high', 'a mid-response metadata miss supplies no clear');
  }
  fs.appendFileSync(f.file, record(assistant({ message: message(null), perTurnEffort: null })));
  assert.equal(f.read(), 'high', 'no per-turn override is not an explicit session clear');
  for (const [fields, expected] of [[{ effort: 'low' }, 'low'], [{ perTurnEffort: 'max' }, 'max'],
    [{ effort: null }, null], [{ effort: '<invalid>' }, null]]) {
    fs.appendFileSync(f.file, record(assistant({ message: message(null), ...fields })));
    assert.equal(f.read(), expected, 'explicit settings still apply before a stop reason');
  }
  for (const reason of ['tool_use', 'end_turn']) {
    fs.appendFileSync(f.file, record(assistant({ effort: 'high' })));
    assert.equal(f.read(), 'high');
    fs.appendFileSync(f.file, record(assistant({ message: message(reason) })));
    assert.equal(f.read(), null, 'a completed response observation without configuration still clears');
  }
  assert.equal(f.bytesRead(), fs.statSync(f.file).size, 'metadata follows the existing append-only read');
});

test('oversized Claude records use bounded fragments and reject nested effort', t => {
  const f = fixture(t);
  const huge = 'x'.repeat(600_000);
  const large = extra => assistant({ message: { model: 'claude-opus-5', content: [
    { type: 'tool_use', input: { padding: huge, effort: 'fake', perTurnEffort: 'fake' } }
  ], stop_reason: 'end_turn' }, uuid: 'response', timestamp: at, ...extra });
  for (const [fields, expected] of [[{ effort: 'high', perTurnEffort: 'low' }, 'low'],
    [{ effort: 'max', perTurnEffort: null }, 'max'], [{}, null]]) {
    fs.writeFileSync(f.file, record(large(fields)));
    assert.equal(f.read(), expected);
    assert.equal(f.cache.get(f.file).trailing.length, 0);
  }
  fs.writeFileSync(f.file, record(assistant({ effort: 'high' })) + record(prompt()));
  assert.equal(f.read(), null, 'truncate resets the index before the next append');
  const full = record(large({ effort: 'medium' })).trimEnd();
  fs.appendFileSync(f.file, full.slice(0, -5));
  assert.equal(f.read(), null);
  fs.appendFileSync(f.file, full.slice(-5));
  assert.equal(f.read(), null, 'oversized effort waits for the line terminator');
  fs.appendFileSync(f.file, '\n');
  assert.equal(f.read(), 'medium');
  fs.appendFileSync(f.file, record(large({ isSidechain: true, effort: 'low' })));
  assert.equal(f.read(), 'medium');
  fs.appendFileSync(f.file, record({ effort: 'xhigh', ...large({}) }));
  assert.equal(f.read(), 'xhigh', 'root fields before message content use the bounded head');
  fs.appendFileSync(f.file, record({ isSidechain: true, effort: 'low', ...large({}) }));
  assert.equal(f.read(), 'xhigh', 'sidechain flags before content remain authoritative');
  fs.appendFileSync(f.file, record(large({ isApiErrorMessage: true, perTurnEffort: 'low' })));
  assert.equal(f.read(), 'xhigh', 'oversized synthetic errors cannot replace a successful response');
});

test('Claude prefix configuration applies without stop reason or tail metadata after the line ends', t => {
  for (const size of [10, 600_000]) for (const [prefix, suffix, expected] of [
    [{ effort: 'low' }, {}, 'low'],
    [{ effort: null }, {}, null],
    [{ effort: 'high', perTurnEffort: 'low' }, {}, 'low'],
    [{ perTurnEffort: 'max' }, {}, 'max'],
    [{}, {}, 'high'],
    [{ effort: 'low', isSidechain: true }, {}, 'high'],
    [{ effort: 'low' }, { isSidechain: true }, 'high'],
    [{ effort: 'low', isApiErrorMessage: true }, {}, 'high'],
    [{ effort: 'low' }, { isApiErrorMessage: true }, 'high']
  ]) {
    const f = fixture(t);
    fs.writeFileSync(f.file, record(assistant({ effort: 'high' })));
    assert.equal(f.read(), 'high');
    const response = JSON.stringify({ type: 'assistant', ...prefix, message: {
      role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(size) }]
    }, ...suffix });
    fs.appendFileSync(f.file, response);
    assert.equal(f.read(), size > 64 * 1024 ? 'high' : expected,
      'bounded fragments wait for newline; ordinary JSON can apply at EOF');
    fs.appendFileSync(f.file, '\n');
    assert.equal(f.read(), expected, 'terminated records apply configuration with ownership guards');
    assert.equal(f.bytesRead(), fs.statSync(f.file).size, 'reads remain append-only');
    f.cache.clear();
    assert.equal(f.read(), expected, 'cold and incremental reads agree');
  }
});

test('complete oversized responses without root suffix metadata clear effort like ordinary responses', t => {
  for (const size of [10, 600_000]) {
    const f = fixture(t);
    fs.writeFileSync(f.file, record(assistant({ effort: 'high' })));
    assert.equal(f.read(), 'high');
    // No uuid, timestamp, sessionId or effort follows message. The bounded
    // message suffix still supplies the stop reason once the line ends.
    const response = record({ type: 'assistant', message: {
      content: [{ type: 'text', text: 'x'.repeat(size) }], stop_reason: 'end_turn'
    } }).trimEnd();
    fs.appendFileSync(f.file, response.slice(0, -2));
    assert.equal(f.read(), 'high', 'incomplete responses retain earlier evidence');
    fs.appendFileSync(f.file, response.slice(-2));
    assert.equal(f.read(), size > 64 * 1024 ? 'high' : null,
      'ordinary JSON can apply at EOF; oversized effort waits for a newline');
    fs.appendFileSync(f.file, '\n');
    assert.equal(f.read(), null, 'a complete response with no effort clears the setting');
    fs.appendFileSync(f.file, record(assistant({ effort: 'high' })));
    assert.equal(f.read(), 'high');
    fs.appendFileSync(f.file, record({ isSidechain: true, type: 'assistant', message: {
      content: [{ type: 'text', text: 'x'.repeat(size) }], stop_reason: 'end_turn'
    } }));
    assert.equal(f.read(), 'high', 'sidechains with no configuration cannot clear main effort');
  }
});

test('historical Claude effort flows through metadata, wire normalization and archives', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, record(assistant({ effort: 'high' })));
  fs.utimesSync(f.file, new Date(at), new Date(at));
  const periods = { today: normalizePeriod({ totalTokens: 10, sessions: { 'claude:session': {
    client: 'claude', sessionId: 'session', totalTokens: 10, lastUsedAt: at
  } } }) };
  applySessionMetadata(periods, f.home, { scopedHome: true, now: Date.parse(next) + 86400_000,
    env: {}, resolveProjects: false, claudeMetadataDeps: f.deps });
  const session = periods.today.sessions['claude:session'];
  assert.equal(session.reasoningEffort, 'high', 'effort is independent of the live-context age gate');
  const archive = updateSessionUsageArchive(null, periods, new Date(next)).archive;
  const restored = applySessionUsageArchive({ today: normalizePeriod({}) }, normalizeSessionUsageArchive(archive), { now: new Date(next) });
  assert.equal(restored.today.sessions['claude:session'].reasoningEffort, 'high');
  const normalized = normalizePeriod(periods.today);
  assert.equal(normalized.sessions['claude:session'].reasoningEffort, 'high');
  for (const effort of ['low', null]) {
    const fresh = normalizePeriod({ totalTokens: 10, sessions: { 'claude:session': { ...session, lastUsedAt: next, reasoningEffort: effort } } });
    for (const [merged, tokens] of [[mergePeriods(normalized, fresh), 20], [mergePeriods(fresh, normalized), 20], [applyPeriodDelta(normalized, fresh, normalized), 10]]) {
      assert.equal(merged.sessions['claude:session'].reasoningEffort, effort);
      assert.equal(merged.totalTokens, tokens);
    }
  }
});

test('a split oversized sidechain user cannot clear main effort before its trailing flag arrives', t => {
  for (const asString of [false, true]) for (const sidechain of [true, false]) {
    const f = fixture(t);
    fs.writeFileSync(f.file, record(assistant({ effort: 'high' })));
    assert.equal(f.read(), 'high');
    const text = 'x'.repeat(600_000) + ' quote " backslash \\ braces {} []';
    const full = record({ type: 'user', message: { content: asString ? text : [{ type: 'text', text }] },
      isSidechain: sidechain }).trimEnd();
    const split = full.indexOf(',"isSidechain"');
    fs.appendFileSync(f.file, full.slice(0, split));
    assert.equal(f.read(), 'high', 'unwritten ownership must not clear main effort');
    fs.appendFileSync(f.file, full.slice(split));
    assert.equal(f.read(), 'high', 'even complete oversized JSON waits for its line terminator');
    fs.appendFileSync(f.file, '\n');
    assert.equal(f.read(), sidechain ? 'high' : null, 'complete ownership decides whether to clear');
    assert.equal(f.bytesRead(), fs.statSync(f.file).size, 'both scans read only the appended bytes');
  }
});

test('a nested tool suffix cannot prove completion of an oversized assistant record', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, record(assistant({ effort: 'high' })));
  assert.equal(f.read(), 'high');
  // This prefix ends with a syntactically valid fake message suffix. The
  // actual assistant's tool input and outer record have not closed yet.
  const prefix = '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"padding":"'
    + 'x'.repeat(600_000) + '","nested":{"stop_reason":"end_turn"}}';
  fs.appendFileSync(f.file, prefix);
  assert.equal(f.read(), 'high', 'nested closure cannot clear a partial outer response');
  fs.appendFileSync(f.file, '}],"stop_reason":"end_turn"}}');
  assert.equal(f.read(), 'high', 'outer closure alone does not finish the JSONL line');
  fs.appendFileSync(f.file, '\n');
  assert.equal(f.read(), null, 'the actual completed response with no effort clears normally');
  assert.equal(f.bytesRead(), fs.statSync(f.file).size);
});

test('oversized effort waits for LF or CRLF across append scans and cold reads', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, record(assistant({ effort: 'high' })));
  assert.equal(f.read(), 'high');
  const full = record(assistant({ message: { content: [{ type: 'text', text: 'x'.repeat(600_000)
    + '"quoted" \\ {} []' }], stop_reason: 'end_turn' }, effort: 'low' })).trimEnd();
  const split = full.indexOf('\\"quoted') + 1;
  assert.ok(split > 600_000);
  fs.appendFileSync(f.file, full.slice(0, split));
  assert.equal(f.read(), 'high');
  fs.appendFileSync(f.file, full.slice(split, -1));
  assert.equal(f.read(), 'high', 'closed inner values still do not close the root');
  fs.appendFileSync(f.file, full.slice(-1));
  assert.equal(f.read(), 'high', 'complete oversized JSON without a newline retains prior effort');
  f.cache.clear();
  assert.equal(f.read(), 'high', 'cold reads use the same line boundary');
  const bytes = f.bytesRead();
  fs.appendFileSync(f.file, '\r');
  assert.equal(f.read(), 'high', 'CR alone does not terminate a JSONL line');
  fs.appendFileSync(f.file, '\n');
  assert.equal(f.read(), 'low');
  assert.equal(f.bytesRead() - bytes, 2, 'only the appended terminator is read');
  f.cache.clear();
  assert.equal(f.read(), 'low', 'a cold read agrees after the line terminator');
});
