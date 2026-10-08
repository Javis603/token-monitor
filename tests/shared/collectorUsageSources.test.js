'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');

const NOW = new Date(2026, 9, 9, 14);
const MODEL = 'gpt-6-astra';
const CODEX_SESSION = 'rollout-2026-10-09T12-00-00-source-integration';
const at = (month, day, second = 0) => new Date(2026, month, day, 12, 0, second);
const usage = n => ({ input_tokens: 100 * n, output_tokens: 40 * n, cached_input_tokens: 20 * n,
  reasoning_output_tokens: 10 * n, total_tokens: 140 * n });

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-collector-sources-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(homeDir)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(homeDir), /^tm-collector-sources-/);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const dshDir = path.join(homeDir, '.dsh', 'sessions', 'workspace', 'dsh-source-integration');
  const codexDir = path.join(homeDir, '.codex', 'sessions');
  fs.mkdirSync(dshDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  const dshFile = path.join(dshDir, 'session.jsonl');
  const codexFile = path.join(codexDir, `${CODEX_SESSION}.jsonl`);
  const usageLedgerPath = path.join(homeDir, 'usage.jsonl');
  const calls = [at(8, 30), at(9, 8), at(9, 9)];
  function writeHistory() {
    const dsh = [{ type: 'session', id: 'dsh-source-integration', version: 0, createdAt: calls[0].getTime() }];
    const codex = [{ type: 'session_meta', timestamp: calls[0].toISOString(), payload: { id: 'native-source-thread', model_provider: 'magpie' } }];
    const ledger = [];
    for (const [index, start] of calls.entries()) {
      const response = `source-${index}`;
      dsh.push({ type: 'assistant/message', seq: index + 1, time: start.getTime(), data: {
        message: { id: response, source: { provider: 'opencode-go', model: MODEL,
          replayState: { response: { responseId: `dsh-${response}` } } }, content: [] },
        usage: { inputTokens: 100, outputTokens: 30, reasoningTokens: 10 }
      } });
      codex.push({ type: 'turn_context', timestamp: start.toISOString(), payload: { model: MODEL, turn_id: `turn-${index}` } },
        { type: 'token_usage_record', timestamp: new Date(start.getTime() + 1000).toISOString(), payload: {
          thread_id: 'native-source-thread', turn_id: `turn-${index}`, response_id: `codex-${response}`,
          usage: usage(1), thread_token_usage: usage(index + 1) } },
        { type: 'event_msg', timestamp: new Date(start.getTime() + 1000).toISOString(), payload: {
          type: 'token_count', info: { last_token_usage: usage(1), total_token_usage: usage(index + 1) } } });
      ledger.push({ response_id: `dsh-${response}`, provider: 'opencode-go', host: 'opencode.ai',
        providerAccount: `historical-dsh-account-${index}`, in: 100, out: 30, ms: 900000 },
      { response_id: `codex-${response}`, provider: 'codex', providerAccount: `historical-codex-account-${index}`,
        in: 80, out: 40, ms: 900000 });
    }
    fs.writeFileSync(dshFile, dsh.map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(codexFile, codex.map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(usageLedgerPath, ledger.map(JSON.stringify).join('\n') + '\n');
  }
  writeHistory();
  const scans = [];
  let activeScans = 0;
  const runTokscale = async ({ flags }) => {
    scans.push([...flags]);
    assert.equal(activeScans++, 0, 'native period scans stay serial');
    await new Promise(resolve => setImmediate(resolve));
    activeScans -= 1;
    const count = calls.filter(time => flags.includes('--today') ? time.getDate() === 9 && time.getMonth() === 9
      : flags.includes('--month') ? time.getMonth() === 9 : true).length;
    // No workspace metadata: projects opt-out must still retain source evidence.
    return { entries: [
      { client: 'dsh', sessionId: 'dsh-source-integration', model: MODEL,
        input: 100 * count, output: 20 * count, reasoning: 10 * count, messageCount: count },
      { client: 'codex', sessionId: CODEX_SESSION, model: MODEL, input: 80 * count, cacheRead: 20 * count,
        output: 30 * count, reasoning: 10 * count, messageCount: count,
        performance: { totalDurationMs: 1000 * count, timedTokens: 140 * count } }
    ] };
  };
  const options = { homeDir, usageLedgerPath, runTokscale, now: NOW, clients: 'codex,dsh',
    allTimeSince: '2024-01-01', projectsEnabled: false, limitsEnabled: false, historyEnabled: false,
    sessionUsageArchiveEnabled: false, dailyHistoryArchiveEnabled: false, wslScanEnabled: false,
    deviceId: 'source-integration' };
  return { options, scans, calls, writeHistory };
}

function assertPeriod(period, count, sourceCount) {
  assert.equal(period.outputTokens, 70 * count);
  assert.equal(period.timedOutputTokens, 40 * count);
  assert.equal(period.timedDurationMs, 1000 * count, 'ledger latency never replaces native duration');
  assert.deepEqual(period.modelThroughput[MODEL], { timedTokens: 140 * count,
    timedOutputTokens: 40 * count, timedDurationMs: 1000 * count });
  const sources = Object.values(period.modelUsageSources);
  assert.equal(sources.length, sourceCount);
  assert.equal(sources.reduce((sum, source) => sum + source.outputTokens, 0), 70 * count);
  assert.ok(sources.every(source => source.model === MODEL && source.accessType === 'subscription'
    && /^sha256:[a-f0-9]{64}$/.test(source.accountId) && Number.isFinite(Date.parse(source.lastUsedAt))));
  assert.equal(sources.filter(source => source.client === 'dsh' && source.platform === 'opencode-go').length, sourceCount / 2);
  assert.equal(sources.filter(source => source.client === 'codex' && source.platform === 'codex').length, sourceCount / 2);
  assert.equal(JSON.stringify(period).includes('historical-'), false);
  assert.ok(Object.values(period.sessions).every(session => !session.projectId));
}

test('collector enriches each serial native window independently with projects disabled and no workspace metadata', async t => {
  const f = fixture(t);
  const summary = await collectUsageOnce(f.options);
  assert.deepEqual(f.scans, [['--today'], ['--month'], ['--since', '2024-01-01']]);
  assertPeriod(summary.today, 1, 2);
  assertPeriod(summary.month, 2, 4);
  assertPeriod(summary.allTime, 3, 6);
  const timed = Object.values(summary.today.modelSourceThroughput).filter(source => source.timedDurationMs > 0);
  assert.equal(timed.length, 1);
  assert.equal(timed[0].platform, 'codex');
  assert.equal(timed[0].accessType, 'subscription');
  assert.equal(Object.values(summary.today.modelSourceThroughput).some(source => source.client === 'dsh'), false);
  assert.ok(Object.values(summary.month.modelSourceThroughput).every(source => !source.accountId),
    'a mixed native row retains account references without assigning grouped duration to an account');
});

test('today anchor enriches only the fresh native scan and carries exact source deltas into broader windows', async t => {
  const f = fixture(t);
  const initial = await collectUsageOnce(f.options);
  f.calls.push(at(9, 9, 10));
  f.writeHistory();
  f.scans.length = 0;
  const summary = await collectUsageOnce({ ...f.options, todayOnlyAnchor: {
    dateKey: localTodayKey(NOW), today: initial.today, month: initial.month, allTime: initial.allTime
  } });
  assert.deepEqual(f.scans, [['--today']]);
  assertPeriod(summary.today, 2, 4);
  assertPeriod(summary.month, 3, 6);
  assertPeriod(summary.allTime, 4, 8);
  assert.ok(Object.values(summary.today.modelSourceThroughput).every(source => !source.accountId));
});
