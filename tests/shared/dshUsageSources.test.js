'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { applyDshUsageSources } = require('../../src/shared/providers/dsh/usageSources');
const { parseDshDetailRecords } = require('../../src/shared/providers/dsh/sessionDetail');
const { readDshTranscriptRecords } = require('../../src/shared/providers/dsh/transcriptReader');
const { sourceFromRow } = require('../../src/shared/usageSource');
const { applyTokscaleSessionMetadata } = require('../../src/shared/sessionMetadata');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

const NOW = new Date(2026, 9, 8, 12);
const today = new Date(2026, 9, 8, 10).getTime();
const yesterday = new Date(2026, 9, 7, 10).getTime();
function assistant(seq, responseId, { time = today, output = 30, provider = 'codex', model = 'gpt-6-astra' } = {}) {
  return { type: 'assistant/message', seq, time, data: {
    message: { id: `message-${seq}`, source: { provider, model, replayState: { response: { responseId } } }, content: [] },
    usage: { inputTokens: 100, outputTokens: output, reasoningTokens: 10 }
  } };
}
function fixture(t, records, ledgerRows = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionsRoot = path.join(directory, 'sessions');
  const session = path.join(sessionsRoot, 'workspace', 'session-1');
  fs.mkdirSync(session, { recursive: true });
  const file = path.join(session, 'session.jsonl');
  fs.writeFileSync(file, [ { type: 'session', id: 'session-1', version: 0, createdAt: yesterday }, ...records ].map(JSON.stringify).join('\n') + '\n');
  const ledgerPath = path.join(directory, 'usage.jsonl');
  fs.writeFileSync(ledgerPath, ledgerRows.map(JSON.stringify).join('\n') + '\n');
  return { sessionsRoot, ledgerPath, now: NOW, file };
}
const ledger = (response_id, extra = {}) => ({ response_id, provider: 'codex', providerAccount: 'actual-account',
  in: 100, out: 30, ms: 120000, ttft_ms: 9000, ...extra });
const row = (extra = {}) => ({ client: 'dsh', sessionId: 'session-1', model: 'gpt-6-astra', input: 100,
  output: 20, reasoning: 10, ...extra });

test('gpt-6-astra response joins retain historical subscription account without importing ledger duration', async t => {
  const options = fixture(t, [assistant(1, 'response-1')], [ledger('response-1')]);
  const json = { entries: [row()] };
  await applyDshUsageSources(json, { ...options, flags: ['--today'] });
  assert.equal(json.entries[0].usageSourceReferences.length, 1);
  const reference = json.entries[0].usageSourceReferences[0];
  assert.equal(reference.usageSource.platform, 'codex');
  assert.equal(reference.usageSource.accessType, 'subscription');
  assert.match(reference.usageSource.accountId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(reference.outputTokens, 30);
  assert.equal(reference.lastUsedAt, new Date(today).toISOString());
  assert.equal(json.entries[0].performance, undefined);
  assert.equal(json.entries[0].usageSource, undefined);
  assert.equal(json.entries[0].usageSources, undefined);
  applyTokscaleSessionMetadata(json);
  const result = extractUsageFromTokscale(json);
  assert.equal(Object.values(result.modelUsageSources)[0].outputTokens, 30);
  assert.equal(result.timedDurationMs, 0);
  assert.deepEqual(result.modelSourceThroughput, Object.create(null));
  assert.equal(JSON.stringify(result).includes('actual-account'), false);
});

test('multiple actual accounts and platforms stay distinct, while nonmatching evidence remains unknown', async t => {
  const options = fixture(t, [assistant(1, 'a'), assistant(2, 'b'), assistant(3, 'api', { provider: 'deepseek' }),
    assistant(4, 'wrong-output'), assistant(5, 'wrong-platform'), assistant(6, ' missing ')],
  [ledger('a'), ledger('b', { providerAccount: 'other-account' }),
    ledger('api', { provider: 'deepseek', providerAccount: undefined, providerKeyId: 'key-id', host: 'api.deepseek.com' }),
    ledger('wrong-output', { out: 29 }), ledger('wrong-platform', { provider: 'anthropic' }), ledger('missing')]);
  const json = { entries: [row({ input: 600, output: 120, reasoning: 60 })] };
  await applyDshUsageSources(json, options);
  const refs = json.entries[0].usageSourceReferences;
  assert.equal(refs.length, 4);
  assert.equal(refs.filter(ref => ref.usageSource.accessType === 'subscription').length, 2);
  assert.equal(refs.filter(ref => ref.usageSource.accessType === 'api').length, 1);
  assert.equal(refs.find(ref => ref.usageSource.accessType === 'unknown').outputTokens, 90);
  assert.equal(refs.reduce((sum, ref) => sum + ref.outputTokens, 0), 180);
});

test('calendar periods, custom roots, duplicate records and changed transcripts follow native ownership', async t => {
  const recent = assistant(2, 'recent');
  const options = fixture(t, [assistant(1, 'old', { time: yesterday }), recent, recent], [ledger('old'), ledger('recent', { providerAccount: 'new-account' })]);
  const custom = { ...options, sessionsRoot: path.join(options.sessionsRoot, 'missing'), customScanPaths: { dsh: [options.sessionsRoot] } };
  const current = { entries: [row()] };
  await applyDshUsageSources(current, { ...custom, flags: ['--today'] });
  assert.equal(current.entries[0].usageSourceReferences.length, 1);
  const month = { entries: [row({ output: 40, reasoning: 20 })] };
  await applyDshUsageSources(month, { ...custom, flags: ['--month'] });
  assert.equal(month.entries[0].usageSourceReferences.length, 2);
  fs.appendFileSync(options.file, JSON.stringify(assistant(3, 'recent')) + '\n');
  const updated = { entries: [row({ output: 40, reasoning: 20 })] };
  await applyDshUsageSources(updated, { ...options, flags: ['--today'] });
  assert.equal(updated.entries[0].usageSourceReferences[0].outputTokens, 60);
});

test('two requests attach each historical account to its native served model', async t => {
  const first = assistant(1, 'r-a', { model: 'configured-alias' });
  first.data.message.source.replayState.response.responseModel = 'served-a';
  const second = assistant(2, 'r-b', { model: 'served-a' });
  second.data.message.source.replayState.response.responseModel = 'served-b';
  const options = fixture(t, [first, second], [ledger('r-a', { providerAccount: 'account-a' }), ledger('r-b', { providerAccount: 'account-b' })]);
  const json = { entries: [row({ model: 'served-a' }), row({ model: 'served-b' })] };
  await applyDshUsageSources(json, options);
  const accountId = account => sourceFromRow({ provider: 'codex', accountId: account, accessType: 'subscription' }).accountId;
  assert.deepEqual(json.entries.map(entry => entry.usageSourceReferences.map(ref => [ref.usageSource.accountId, ref.outputTokens])), [
    [[accountId('account-a'), 30]], [[accountId('account-b'), 30]]
  ]);
  applyTokscaleSessionMetadata(json);
  const sources = Object.values(extractUsageFromTokscale(json).modelUsageSources);
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map(source => source.accountId).sort(), [accountId('account-a'), accountId('account-b')].sort());
  assert.equal(json.entries.some(entry => entry.usageSources || entry.performance), false);
});

test('native routing uses trimmed served model, configured model, then the latest request header', async t => {
  const served = assistant(2, 'served', { model: 'configured' });
  served.data.message.source.replayState.response.responseModel = ' served ';
  const configured = assistant(3, 'configured', { model: ' configured ' });
  configured.data.message.source.replayState.response.responseModel = 7;
  const fromHeader = assistant(4, 'header', { model: ' ' });
  delete fromHeader.data.message.source.provider;
  fromHeader.data.message.source.replayState.response.responseModel = ' ';
  const nextHeader = assistant(6, 'next', { model: '' });
  delete nextHeader.data.message.source.provider;
  const unknown = assistant(8, 'unknown', { model: '' });
  delete unknown.data.message.source.provider;
  const options = fixture(t, [
    { type: 'request/header', data: { header: { config: { provider: 'codex', model: ' header ' } } } },
    served, configured, fromHeader,
    { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'next' } } } },
    nextHeader, { type: 'request/header', data: { header: { config: {} } } }, unknown
  ], [ledger('served'), ledger('configured'), ledger('header'),
    ledger('next', { provider: 'deepseek', providerAccount: undefined, providerKeyId: 'api-key', host: 'api.deepseek.com' }), ledger('unknown')]);
  const json = { entries: ['served', 'configured', 'header', 'next', 'unknown'].map(model => row({ model })) };
  await applyDshUsageSources(json, options);
  assert.deepEqual(json.entries.map(entry => entry.usageSourceReferences.map(ref => [ref.usageSource.platform, ref.usageSource.accessType, ref.outputTokens])), [
    [['codex', 'subscription', 30]], [['codex', 'subscription', 30]], [['codex', 'subscription', 30]],
    [['deepseek', 'api', 30]], [['unknown', 'unknown', 30]]
  ]);
});

for (const type of ['compaction/summary', 'assistant/attempt']) {
  test(`source dedup keeps distinct native ${type} identities and suppresses replayed records`, async t => {
    const first = assistant(1, 'first');
    first.type = type;
    delete first.data.message.id;
    const second = structuredClone(first);
    second.data.message.source.replayState.response.responseId = 'second';
    if (type === 'compaction/summary') {
      first.data.compactionId = 'first-summary';
      second.data.compactionId = 'second-summary';
    } else {
      first.data.attemptId = 'first-attempt';
      second.data.retryId = 'second-attempt';
      for (const record of [first, second]) record.data.stream = [{ type: 'chunk', chunk: { type: 'usage', usage: record.data.usage } }];
    }
    const options = fixture(t, [first, second, first, second], [ledger('first'), ledger('second')]);
    const json = { entries: [row({ input: 200, output: 40, reasoning: 20 })] };
    await applyDshUsageSources(json, options);
    assert.equal(json.entries[0].usageSourceReferences[0].outputTokens, 60);
  });
}

test('source dedup uses native served models while the default detail parser preserves its contract', async t => {
  const first = assistant(1, 'first', { model: 'configured' });
  first.data.message.source.replayState.response.responseModel = 'served-a';
  const second = structuredClone(first);
  second.data.message.source.replayState.response = { responseId: 'second', responseModel: 'served-b' };
  const detail = parseDshDetailRecords([first, second]);
  assert.equal(detail.length, 1);
  assert.equal(Object.hasOwn(detail[0], 'usageSource'), false);
  const options = fixture(t, [first, second], [ledger('first'), ledger('second')]);
  const json = { entries: [row({ model: 'served-a' }), row({ model: 'served-b' })] };
  await applyDshUsageSources(json, options);
  assert.deepEqual(json.entries.map(entry => entry.usageSourceReferences[0].outputTokens), [30, 30]);
});

test('native settlement replacement and retry-started boundaries retain only accepted source calls', async t => {
  const first = assistant(1, 'discarded', { model: 'old-model' });
  const replacement = assistant(2, 'accepted', { model: 'new-model' });
  const retry = assistant(4, 'retry', { model: 'new-model' });
  for (const record of [first, replacement, retry]) Object.assign(record.data, { turn: 1, step: 1 });
  const options = fixture(t, [first, replacement,
    { type: 'llm/retry-started', data: { turn: 1, step: 1 } }, retry],
  [ledger('discarded'), ledger('accepted'), ledger('retry', { providerAccount: 'retry-account' })]);
  const json = { entries: [row({ model: 'old-model' }), row({ model: 'new-model', output: 40, reasoning: 20 })] };
  await applyDshUsageSources(json, options);
  assert.equal(json.entries[0].usageSourceReferences, undefined);
  assert.equal(json.entries[1].usageSourceReferences.length, 2);
  assert.equal(json.entries[1].usageSourceReferences.reduce((sum, ref) => sum + ref.outputTokens, 0), 60);
});

test('source sanitation preserves native malformed usage precedence and typed stream selection', async t => {
  const stream = usage => ({ type: 'chunk', chunk: { type: 'usage', usage } });
  const message = assistant(1, 'message');
  delete message.data.usage;
  message.data.stream = [stream({ inputTokens: 100, outputTokens: 30, reasoningTokens: 10 }),
    { chunk: { usage: { outputTokens: 900 } } }];
  const attempt = assistant(2, 'attempt');
  attempt.type = 'assistant/attempt';
  attempt.data.stream = [stream({ outputTokens: 30 }), stream(null)];
  const topLevel = assistant(3, 'top-level');
  topLevel.data.usage = null;
  topLevel.data.stream = [stream({ outputTokens: 30 })];
  const summary = assistant(4, 'summary');
  summary.type = 'compaction/summary';
  delete summary.data.usage;
  summary.data.stream = [stream({ outputTokens: 30 })];
  const options = fixture(t, [message, attempt, topLevel, summary]);
  const expected = parseDshDetailRecords([message, attempt, topLevel, summary], { includeUsageSource: true });
  assert.deepEqual(expected.map(event => event.usageSource.responseId), ['message']);
  const records = await readRecords(options.file, { includeUsageSource: true });
  assert.deepEqual(parseDshDetailRecords(records, { includeUsageSource: true }), expected);
});

test('source ownership keeps native legacy and current fork boundaries', () => {
  const inherited = assistant(1, 'inherited');
  const own = assistant(3, 'own');
  const marker = { type: 'session/end-seed', seq: 2, data: { inherited: true } };
  const source = records => parseDshDetailRecords(records, { includeUsageSource: true }).map(event => event.usageSource.responseId);
  assert.deepEqual(source([{ type: 'session', seedLength: '3', isSeeded: true }, inherited, marker, own]), ['inherited', 'own']);
  assert.deepEqual(source([{ type: 'session', seedLength: 2.5 }, inherited, own]), ['inherited', 'own']);
  assert.deepEqual(source([inherited, { type: 'session', isSeeded: true }, own]), []);
  assert.deepEqual(source([{ type: 'session', isSeeded: true }, inherited, marker, own]), ['own']);
  assert.deepEqual(source([{ type: 'session', isSeeded: true }, inherited,
    { ...marker, seq: 2.5 }, own]), []);
});

test('source token signatures use integer buckets and native inclusive output', () => {
  const outputSubset = assistant(1, 'subset', { output: 5 });
  Object.assign(outputSubset.data.usage, { inputTokens: 3.5, cacheReadTokens: '7', cacheWriteTokens: 2 });
  const malformed = assistant(2, 'malformed', { output: 1.5 });
  malformed.data.usage = { inputTokens: '10', outputTokens: 1.5, reasoningTokens: '4' };
  const badTime = assistant(3, 'bad-time', { time: today + 0.5 });
  const events = parseDshDetailRecords([outputSubset, malformed, badTime], { includeUsageSource: true });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].tokens, { input: 0, output: 10, cacheRead: 0, cacheWrite: 2, reasoning: 10, total: 12 });
});

async function readRecords(file, options) {
  const records = [];
  for await (const record of readDshTranscriptRecords(file, options)) records.push(record);
  return records;
}

for (const compressed of [false, true]) {
  test(`${compressed ? 'compressed' : 'plain'} source reader enforces opt-in decoded and record bounds`, async t => {
    const options = fixture(t, []);
    const file = compressed ? options.file + '.zstd' : options.file;
    const payload = Buffer.from(JSON.stringify({ type: 'session', id: 'session-1' }) + '\n'
      + (JSON.stringify(assistant(1, 'repeat')) + '\n').repeat(20));
    fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(payload) : payload);
    await assert.rejects(readRecords(file, { maxDecodedBytes: 128 }), { code: 'DSH_TRANSCRIPT_DECODED_TOO_LARGE' });
    await assert.rejects(readRecords(file, { maxRecords: 5 }), { code: 'DSH_TRANSCRIPT_TOO_MANY_RECORDS' });
    assert.equal((await readRecords(file)).length, 21, 'default detail reads keep their existing limits');
  });
}

test('compressed-frame cancellation stops parsing immediately and closes all descriptors', async t => {
  const options = fixture(t, [], [ledger('repeat')]);
  const file = path.join(path.dirname(options.file), 'session.v3.jsonl.zstd');
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: 'session-1' }) + '\n'
    + (JSON.stringify(assistant(1, 'repeat')) + '\n').repeat(60000))));
  const controller = new AbortController();
  const parse = JSON.parse;
  let parsed = 0;
  t.mock.method(JSON, 'parse', (...args) => {
    const record = parse(...args);
    if (record?.type === 'assistant/message' && ++parsed === 1000) controller.abort(new Error('stop-in-frame'));
    return record;
  });
  const open = fs.openSync, close = fs.closeSync, opened = new Set();
  t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); opened.add(fd); return fd; });
  t.mock.method(fs, 'closeSync', fd => { opened.delete(fd); return close(fd); });
  await assert.rejects(applyDshUsageSources({ entries: [row()] }, { ...options, signal: controller.signal }), /stop-in-frame/);
  assert.equal(parsed, 1000);
  assert.equal(opened.size, 0);
});

test('an over-limit compressed source scan discards evidence from every frame', async t => {
  const options = fixture(t, [], [ledger('first')]);
  const file = path.join(path.dirname(options.file), 'session.v3.jsonl.zstd');
  const firstFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: 'session-1' }) + '\n'
    + JSON.stringify(assistant(1, 'first')) + '\n'));
  const tail = zlib.zstdCompressSync(Buffer.from((JSON.stringify(assistant(2, 'unknown')) + '\n').repeat(50000)));
  fs.writeFileSync(file, Buffer.concat([firstFrame, tail]));
  const json = { entries: [row()] };
  await applyDshUsageSources(json, options);
  assert.equal(json.entries[0].usageSourceReferences, undefined);
});

test('source-only header discovery avoids unbounded whole-file fallback', async t => {
  const options = fixture(t, [assistant(1, 'first')], [ledger('first')]);
  const file = path.join(path.dirname(options.file), 'session.v3.jsonl.zstd');
  const payload = Buffer.from(JSON.stringify({ type: 'session', id: 'session-1' }) + '\n'
    + (JSON.stringify({ type: 'tool/output', data: 'x'.repeat(65536) }) + '\n').repeat(40)
    + JSON.stringify(assistant(1, 'first')) + '\n');
  fs.writeFileSync(file, zlib.zstdCompressSync(payload));
  const readFile = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    assert.notEqual(target, file, 'source discovery must not decode the transcript through a whole-file read');
    return readFile(target, ...args);
  });
  const json = { entries: [row()] };
  await applyDshUsageSources(json, options);
  assert.equal(json.entries[0].usageSourceReferences[0].outputTokens, 30);
});

test('source discovery refreshes generations and a previously empty project without rewalking an unchanged tree', async t => {
  const options = fixture(t, [assistant(1, 'first')], [ledger('first'), ledger('next')]);
  const emptyProject = path.join(options.sessionsRoot, 'empty-workspace');
  fs.mkdirSync(emptyProject);
  const readdir = fs.readdirSync;
  let walks = 0;
  t.mock.method(fs, 'readdirSync', (directory, ...args) => {
    if (String(directory).startsWith(options.sessionsRoot)) walks += 1;
    return readdir(directory, ...args);
  });
  await applyDshUsageSources({ entries: [row()] }, options);
  const initialWalks = walks;
  const unchanged = { entries: [row()] };
  await applyDshUsageSources(unchanged, options);
  assert.equal(walks, initialWalks);
  assert.equal(unchanged.entries[0].usageSourceReferences[0].outputTokens, 30);
  const generation = path.join(path.dirname(options.file), 'session.v3.jsonl');
  fs.writeFileSync(generation, [ { type: 'session', id: 'session-1' }, assistant(2, 'next'), assistant(3, 'first') ].map(JSON.stringify).join('\n') + '\n');
  const refreshed = { entries: [row()] };
  await applyDshUsageSources(refreshed, options);
  assert.equal(refreshed.entries[0].usageSourceReferences[0].outputTokens, 60);
  const otherDirectory = path.join(emptyProject, 'session-2');
  fs.mkdirSync(otherDirectory);
  fs.writeFileSync(path.join(otherDirectory, 'session.jsonl'), [ { type: 'session', id: 'session-2' }, assistant(1, 'first') ].map(JSON.stringify).join('\n') + '\n');
  const next = { entries: [row(), row({ sessionId: 'session-2' })] };
  await applyDshUsageSources(next, options);
  assert.equal(next.entries[1].usageSourceReferences[0].outputTokens, 30);
});

test('a source index retries a header that was incomplete on its first discovery', async t => {
  const options = fixture(t, [], [ledger('first')]);
  fs.writeFileSync(options.file, '{"type":"session","id":');
  const before = { entries: [row({ sessionId: 'header-session' })] };
  await applyDshUsageSources(before, options);
  assert.equal(before.entries[0].usageSourceReferences, undefined);
  fs.writeFileSync(options.file, [ { type: 'session', id: 'header-session' }, assistant(1, 'first') ].map(JSON.stringify).join('\n') + '\n');
  const after = { entries: [row({ sessionId: 'header-session' })] };
  await applyDshUsageSources(after, options);
  assert.equal(after.entries[0].usageSourceReferences[0].outputTokens, 30);
});

test('missing history supplies no identity, and an aborted source scan cannot silently finish', async t => {
  const options = fixture(t, []);
  const json = { entries: [row({ sessionId: 'absent' })] };
  await applyDshUsageSources(json, options);
  assert.equal(json.entries[0].usageSourceReferences, undefined);
  const controller = new AbortController();
  controller.abort(new Error('stop-dsh-source-scan'));
  await assert.rejects(applyDshUsageSources(json, { ...options, signal: controller.signal }), /stop-dsh-source-scan/);
});
