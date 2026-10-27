'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cursorAuth = require('../../src/shared/providers/cursor/auth');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cursor-reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(cursorAuth, 'runCursorSync', async () => {});
  const time = day => new Date(2026, 9, day, 9).getTime();
  const row = (id, day, count) => ({ id, eventTime: time(day), model: 'cursor-auto',
    inputTokens: count, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: count });
  const account = (id, rows) => {
    const accountKey = crypto.createHash('sha256').update(id).digest('hex');
    const filePath = path.join(dir, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ version: 2, accountKey, rows }));
    return { accountId: id, accountKey, filePath };
  };
  const native = (id, rows) => {
    const file = path.join(dir, '.config', 'tokscale', 'cursor-cache', `usage.${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ _tokscale: { accountId: id }, usageEventsDisplay: rows.map(r => ({
      timestamp: r.eventTime, model: 'auto', tokenUsage: { inputTokens: r.inputTokens }
    })) }));
  };
  const options = { clients: 'cursor', homeDir: dir, env: {}, now: new Date(2026, 9, 21, 12),
    deviceId: 'test', allTimeSince: '2026-01-01', osInfo: {}, wslScanEnabled: false,
    projectsEnabled: false, codexLocalUsageEnabled: false, historyEnabled: false,
    runTokscale: async () => ({ entries: [] }),
    lookupModelPricing: async () => ({ pricing: { inputCostPerToken: 0.000002 } }) };
  return { dir, time, row, account, native, options };
}

test('account-scoped billing survives sparse native recovery and other account activity', async t => {
  const f = fixture(t);
  const old = f.row('old', 19, 40), matched = f.row('matched', 20, 20);
  f.native('work', [matched]);
  f.native('personal', [f.row('other-account', 21, 999)]);
  const work = f.account('work', [old, matched, f.row('unmatched-bill', 20, 10)]);
  const result = await collectUsageOnce({ ...f.options, cursorBillingAccounts: [work] });
  assert.equal(result.month.clients.cursor, 50,
    'keep the historical gap and unmatched bills after exact native matches; never use another account watermark');
});

test('opaque native overlap withholds that day without erasing other missing days', async t => {
  const f = fixture(t);
  f.native('work', [f.row('different-native', 20, 7)]);
  const result = await collectUsageOnce({ ...f.options,
    cursorBillingAccounts: [f.account('work', [f.row('gap', 19, 40), f.row('ambiguous', 20, 20)])] });
  assert.equal(result.month.clients.cursor, 40);
});

test('billing requires explicit account selection and never imports the unscoped legacy ledger', async t => {
  const f = fixture(t);
  const legacy = f.account('work', [f.row('legacy', 20, 10)]);
  const result = await collectUsageOnce({ ...f.options, cursorBillingItemsPath: legacy.filePath });
  assert.equal(result.month.clients.cursor || 0, 0);
});

test('a ledger from another account cannot be attached to the selected account', async t => {
  const f = fixture(t);
  const other = f.account('personal', [f.row('other', 20, 10)]);
  const work = f.account('work', []);
  const result = await collectUsageOnce({ ...f.options,
    cursorBillingAccounts: [{ ...work, filePath: other.filePath }] });
  assert.equal(result.month.clients.cursor || 0, 0);
});

test('anonymous native calls with identical counters and timestamps retain their multiplicity', async t => {
  const f = fixture(t);
  const first = f.row('first', 20, 10), second = f.row('second', 20, 10);
  f.native('work', [first, second]);
  const result = await collectUsageOnce({ ...f.options, cursorBillingAccounts: [f.account('work', [first, second])] });
  assert.equal(result.month.clients.cursor || 0, 0, 'both native calls must be excluded from supplementation');
});

test('historical native recovery replaces an old Today anchor before suppressing matching bills', async t => {
  const f = fixture(t);
  const bill = f.row('historical', 20, 10);
  const selected = [f.account('work', [bill])];
  let captured;
  const first = await collectUsageOnce({ ...f.options, cursorBillingAccounts: selected,
    onAnchorComputed: value => { captured = value; } });
  assert.equal(first.month.clients.cursor, 10);
  const anchor = { dateKey: localTodayKey(f.options.now), ...captured.windowsPeriods,
    todayPartitions: captured.todayPartitions, cursorBillingNativeSignature: captured.cursorBillingNativeSignature };
  f.native('work', [bill]);
  const calls = [];
  const runTokscale = async ({ flags }) => {
    calls.push(flags);
    return { entries: flags.includes('--today') ? [] : [{ client: 'cursor', model: 'auto',
      inputTokens: 10, totalTokens: 10, session: 'native' }] };
  };
  const second = await collectUsageOnce({ ...f.options, cursorBillingAccounts: selected, todayOnlyAnchor: anchor,
    runTokscale, onAnchorComputed: value => { captured = value; } });
  assert.equal(second.month.clients.cursor, 10, 'the recovered historical native call must already be counted');
  assert.equal(calls.length, 3, 'a historical coverage change requires serial full-period scans');
  const refreshedAnchor = { dateKey: anchor.dateKey, ...captured.windowsPeriods,
    todayPartitions: captured.todayPartitions, cursorBillingNativeSignature: captured.cursorBillingNativeSignature };
  calls.length = 0;
  const stable = await collectUsageOnce({ ...f.options, cursorBillingAccounts: selected,
    todayOnlyAnchor: refreshedAnchor, runTokscale });
  assert.equal(calls.length, 1, 'unchanged historical coverage retains the fast Today scan');
  assert.equal(stable.month.clients.cursor, 10);
});
