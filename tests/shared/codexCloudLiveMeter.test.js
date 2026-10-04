'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudLiveMeter, renderCloudLiveHtml } = require('../../src/shared/providers/codex/cloudLiveMeter');
const tid = '01900000-0000-7000-8000-000000000001';
const turn = '01900000-0000-7000-8000-000000000002';
function counts(input = 90, output = 10) { return { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedInputTokens: 20, reasoningOutputTokens: 2 }; }
function message(input = 90, output = 10, last = null) {
  return { method: 'thread/tokenUsage/updated', params: { threadId: tid, turnId: turn, tokenUsage: { total: counts(input, output), last: last || counts(input, output) } } };
}
test('cloud snapshots replace rather than add cumulative totals', () => {
  const m = new CloudLiveMeter(tid); m.observe(message(90)); m.observe(message(140)); m.observe(message(190));
  const r = m.report(); assert.equal(r.total.totalTokens, 200); assert.equal(r.samples.length, 3); assert.equal(r.canCombineWithLocal, false);
});
test('contiguous duplicate delivery is not an additional measurement', () => {
  const m = new CloudLiveMeter(tid); m.observe(message()); m.observe(message());
  assert.equal(m.report().coverage.receivedEvents, 2); assert.equal(m.report().coverage.duplicateEvents, 1); assert.equal(m.report().total.totalTokens, 100);
});
test('missing notifications are unknown, never zero', () => {
  const r = new CloudLiveMeter(tid).report(); assert.equal(r.total, null); assert.equal(r.measurement, 'unavailable');
});
test('foreign thread and non-token messages are ignored', () => {
  const m = new CloudLiveMeter(tid), e = message(); e.params.threadId = turn;
  m.observe(e); m.observe({ method: 'item/agentMessage/delta', params: { threadId: tid, delta: 'PRIVATE_BODY' } });
  assert.equal(m.report().coverage.receivedEvents, 0); assert.ok(!JSON.stringify(m.report()).includes('PRIVATE_BODY'));
});
test('server request cannot pretend to be a notification', () => {
  const m = new CloudLiveMeter(tid); assert.equal(m.observe({ ...message(), id: 1 }), null); assert.equal(m.report().total, null);
});
test('cache and reasoning remain subsets, not extra tokens', () => {
  const m = new CloudLiveMeter(tid); m.observe(message()); const r = m.report();
  assert.equal(r.total.totalTokens, 100); assert.equal(r.total.cachedInputTokens, 20); assert.equal(r.total.reasoningOutputTokens, 2);
});
for (const invalid of [-1, 1.5, Infinity, NaN, '100', true, Number.MAX_SAFE_INTEGER + 1]) {
  test(`unsafe count ${invalid} invalidates the observation`, () => {
    const m = new CloudLiveMeter(tid), e = message(); e.params.tokenUsage.total.inputTokens = invalid;
    m.observe(e); assert.equal(m.report().status, 'ambiguous'); assert.equal(m.report().total, null);
  });
}
test('decrease equal to an older sample is detected, not globally deduplicated away', () => {
  const m = new CloudLiveMeter(tid); m.observe(message(90)); m.observe(message(190)); m.observe(message(90));
  assert.equal(m.report().problem, 'NONMONOTONIC_COUNTER'); assert.equal(m.report().total, null);
});
test('single request cannot exceed cumulative usage', () => {
  const m = new CloudLiveMeter(tid); m.observe(message(90, 10, counts(200, 10)));
  assert.equal(m.report().problem, 'INVALID_ENGINE_USAGE');
});
test('bounded retained history still preserves the latest cumulative snapshot', () => {
  const m = new CloudLiveMeter(tid, { maxSamples: 1 }); m.observe(message(90)); m.observe(message(190));
  assert.equal(m.report().samples.length, 1); assert.equal(m.report().coverage.sampleHistoryTruncated, true); assert.equal(m.report().total.totalTokens, 200);
});
test('invalid identifiers and timestamps cannot mint a report', () => {
  assert.throws(() => new CloudLiveMeter('bad'));
  const m = new CloudLiveMeter(tid), e = message(); e.params.turnId = 'bad'; m.observe(e);
  assert.equal(m.report().problem, 'INVALID_TURN_ID'); assert.throws(() => new CloudLiveMeter(tid).observe(message(), 'not-a-date'));
});
test('unknown optional breakdowns remain unknown', () => {
  const m = new CloudLiveMeter(tid); const e = message();
  delete e.params.tokenUsage.total.cachedInputTokens; delete e.params.tokenUsage.last.cachedInputTokens;
  m.observe(e); assert.equal(m.report().total.cachedInputTokens, null);
});
test('explicit zero is distinct from missing', () => {
  const m = new CloudLiveMeter(tid); const c = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0 };
  m.observe({ method: 'thread/tokenUsage/updated', params: { threadId: tid, turnId: turn, tokenUsage: { total: c, last: c } } });
  assert.equal(m.report().total.totalTokens, 0); assert.equal(m.report().status, 'observed');
});
test('HTML has no remote resources and escapes all external text', () => {
  const m = new CloudLiveMeter(tid); m.observe(message()); const r = m.report(); r.threadId = '<script>bad</script>'; r.testOnly = true;
  const html = renderCloudLiveHtml(r); assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes("default-src 'none'")); assert.ok(html.includes('隔离云端验证任务'));
});


test('callers cannot mutate retained engine counters through observe or report', () => {
  const meter = new CloudLiveMeter(tid);
  const delivered = meter.observe(message());
  delivered.total.totalTokens = 999999;
  delivered.last.inputTokens = 999999;
  const first = meter.report();
  first.total.inputTokens = 555555;
  first.samples[0].total.totalTokens = 666666;
  const next = meter.report();
  assert.equal(next.total.inputTokens, 90);
  assert.equal(next.total.totalTokens, 100);
  assert.equal(next.lastRequest.inputTokens, 90);
  assert.equal(next.samples[0].total.totalTokens, 100);
});
