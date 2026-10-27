'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseOllamaUsageHtml, parseOllamaBalance, fetchOllamaLimits, rememberOllamaValidation } = require('../../src/shared/providers/ollama/limits');
const { normalizeLimitProvider } = require('../../src/shared/limits/core');
const { creditsMeterPercent } = require('../../src/shared/limits/balanceDisplay');
const { hashKey } = require('../../src/shared/hashKey');
const { monthly, free, wallet } = require('../fixtures/ollamaCookieUsage.cjs');

test('Cookie monthly included dollars preserve amounts, plan, identity and reset', () => {
  const parsed = parseOllamaUsageHtml(monthly);
  assert.equal(parsed.planName, 'pro');
  assert.equal(parsed.accountEmail, 'fixture@example.com');
  assert.equal(parsed.windows.length, 1);
  assert.deepEqual(parsed.windows[0], {
    kind: 'billing', metric: 'credits', label: 'Included credits', used: 7.5, limit: 60,
    remaining: 52.5, currency: 'USD', usedPercent: 12.5,
    resetsAt: '2026-11-25T12:00:00.000Z', showMeter: true
  });
});

test('Free usage is a monthly percentage without fabricated money or duration', () => {
  const parsed = parseOllamaUsageHtml(free);
  assert.equal(parsed.planName, 'free');
  assert.equal(parsed.windows.length, 1);
  assert.deepEqual(parsed.windows[0], {
    kind: 'billing', label: 'Monthly', usedPercent: 69.5,
    resetsAt: '2026-11-25T12:00:00.000Z', showMeter: true
  });
});

test('wallet amounts remain independent without an inferred allowance or percentage', () => {
  const parsed = parseOllamaUsageHtml(wallet);
  assert.equal(parsed.planName, 'pro');
  assert.deepEqual(parsed.windows, [
    { kind: 'billing', metric: 'credits', label: 'Credit balance', remaining: 18.25, currency: 'USD', showMeter: false, resetDescription: 'Refills to $30 in 3 weeks.' },
    { kind: 'billing', metric: 'spend', label: 'Monthly credits used', used: 4.5, currency: 'USD', showMeter: false }
  ]);
  const row = normalizeLimitProvider({ provider: 'ollama', status: 'ok', windows: parsed.windows });
  for (const window of row.windows) {
    assert.equal(window.usedPercent, null);
    assert.equal(window.limit, null);
    assert.equal(window.resetsAt, null);
    assert.equal(window.showMeter, false);
  }
  assert.equal(creditsMeterPercent(row, row.windows[0], { inferBalance: false }), null);
});

test('wallet fields cannot borrow missing values from spending, prose or another section', () => {
  assert.deepEqual(parseOllamaUsageHtml(wallet.replace('<span>$18.25</span>', '')).windows.map((w) => w.label), ['Monthly credits used']);
  assert.deepEqual(parseOllamaUsageHtml(wallet.replace('<span>$4.50</span>', '')).windows.map((w) => w.label), ['Credit balance']);
  for (const label of ['Previous Monthly credits used', 'Monthly credits used estimate']) {
    assert.deepEqual(parseOllamaUsageHtml(wallet.replace('Monthly credits used', label)).windows.map((w) => w.label), ['Credit balance']);
  }
  const outside = '<section><h2>Usage credits<span>pro</span></h2><span>$0.00</span></section>'
    + '<section><span>Monthly credits used</span><span>$99</span><p>Refills to $100 in 2 weeks.</p></section>';
  assert.deepEqual(parseOllamaUsageHtml(outside).windows, [
    { kind: 'billing', metric: 'credits', label: 'Credit balance', remaining: 0, currency: 'USD', showMeter: false, resetDescription: '' }
  ]);
  assert.equal(parseOllamaUsageHtml(wallet.replace('3 weeks.', '3 weeks')).windows[0].resetDescription, 'Refills to $30 in 3 weeks');
});

test('monthly, legacy and wallet blocks coexist without borrowing meters or reset dates', () => {
  const legacy = '<section><span>Weekly usage</span><span>42% used</span><div data-time="2026-11-02T00:00:00Z"></div></section>';
  const parsed = parseOllamaUsageHtml(monthly + legacy + wallet);
  assert.deepEqual(parsed.windows.map((w) => [w.label || w.kind, w.usedPercent ?? null]), [
    ['weekly', 42], ['Included credits', 12.5], ['Credit balance', null], ['Monthly credits used', null]
  ]);
  const invalid = '<section><span>Monthly usage</span><span>$1,25 of $60 used</span></section>' + legacy;
  assert.deepEqual(parseOllamaUsageHtml(invalid).windows.map((w) => w.kind), ['weekly']);
  assert.equal(parseOllamaUsageHtml('<span>Monthly usage</span>' + wallet).windows.some((w) => w.label === 'Monthly'), false);
});

test('monthly currency parsing handles separators and rejects malformed amounts without a meter', () => {
  const dollars = (value) => `<span>Monthly usage</span><span>${value}</span>`;
  assert.equal(parseOllamaUsageHtml(dollars('$1,250 of $5,000 used')).windows[0].usedPercent, 25);
  for (const value of ['$1,25 of $60 used', '$7.50 of $5,00 used', '$0 of $0 used', `$${'9'.repeat(400)} of $60 used`, `$${'9'.repeat(308)} of $0.01 used`]) {
    assert.equal(parseOllamaUsageHtml(dollars(value)).windows.length, 0, value);
    const fallback = parseOllamaUsageHtml(dollars(value) + '<div style="width: 17%"></div>');
    assert.equal(fallback.windows[0].usedPercent, 17);
    assert.equal(fallback.windows[0].metric, undefined);
  }
  assert.equal(parseOllamaUsageHtml('<span>Monthly usage</span>').windows.length, 0);
  assert.equal(parseOllamaUsageHtml('<p>Free usage credits apply.</p><span>83% used</span>').windows.length, 0);
  assert.equal(parseOllamaUsageHtml('<script><span>Monthly usage</span><span>83% used</span></script>').windows.length, 0);
  const alternate = parseOllamaUsageHtml('<span>Monthly usage</span><span>unavailable</span><span>Free usage</span><span>17% used</span>');
  assert.equal(alternate.windows.length, 1);
  assert.equal(alternate.windows[0].usedPercent, 17);
});

test('discarding non-content HTML does not join fragments into a valid monthly label', () => {
  for (const ignored of ['<!-- ignored -->', '<script>ignored</script>', '<style>ignored</style>']) {
    assert.equal(parseOllamaUsageHtml(`<span>Mont${ignored}hly usage</span><span>17% used</span>`).windows.length, 0);
  }
});

test('API purchased balance coexists with monthly included credits and spending without being added to the quota', () => {
  const parsed = parseOllamaBalance({ included: { balance_usd: '52.50', allowance_usd: 60 }, purchased: { balance_usd: '18.25' } });
  assert.deepEqual(parsed.windows.map((w) => [w.label, w.remaining ?? null, w.used ?? null, w.showMeter]), [
    ['Included credits', 52.5, 7.5, true], ['Credit balance', 18.25, null, false], ['Monthly credits used', null, 7.5, false]
  ]);
  const legacy = parseOllamaBalance({ included: { session: { remaining_percent: 75 }, weekly: { remaining_percent: 40 } }, purchased: { balance_usd: 25 } });
  assert.deepEqual(legacy.windows.map((w) => [w.kind, w.usedPercent ?? null, w.remaining ?? null]), [
    ['session', 25, null], ['weekly', 60, null], ['billing', null, 25]
  ]);
  assert.equal(parseOllamaBalance({ purchased: { balance_usd: 0 } }).windows[0].remaining, 0);
  for (const value of [null, '', ' ', true, [], {}, '0x10', 'NaN', Infinity]) {
    assert.equal(parseOllamaBalance({ purchased: { balance_usd: value } }), null);
  }
  assert.deepEqual(parseOllamaBalance({ included: { allowance_usd: 0, balance_usd: 0 } }).windows.map((w) => [w.metric, w.used, w.showMeter]), [['spend', 0, false]]);
});

test('Cookie monthly and wallet pages fetch through settings once and validation cache keeps the real row', async () => {
  for (const [index, html] of [monthly, free, wallet].entries()) {
    let requests = 0;
    const cookie = `wos-session=fixture-monthly-${index}`;
    const row = await fetchOllamaLimits({ ollamaCookie: cookie }, {
      env: {}, now: () => 1000, bypassValidationCache: true,
      fetch: async (url, init) => {
        requests += 1;
        assert.equal(String(url), 'https://ollama.com/settings');
        assert.equal(init.headers.Cookie, cookie);
        assert.equal(init.headers.Authorization, undefined);
        return { ok: true, status: 200, text: async () => html };
      }
    });
    assert.equal(row.status, 'ok');
    assert.equal(row.source, 'web');
    if (index < 2) assert.equal(row.accountKey, hashKey('ollama', 'fixture@example.com'));
    rememberOllamaValidation(cookie, row, 1000);
    assert.deepEqual(await fetchOllamaLimits({ ollamaCookie: cookie }, { env: {}, now: () => 1001, fetch: async () => { throw new Error('cache must be reused'); } }), row);
    assert.equal(requests, 1);
  }
});

test('saving a new-plan Cookie confirms the real monthly or wallet row without a second settings request', async () => {
  const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
  for (const [index, html] of [monthly, free, wallet, wallet.replace('<span>$18.25</span>', '')].entries()) {
    let current = { ollamaApiKey: 'fixture-old-key' };
    let requests = 0;
    let accepted;
    const commands = createCredentialCommands({
      env: {}, getSettings: () => current,
      probeDeps: () => ({ probe: true, env: {}, fetch: async () => {
        requests += 1;
        return { ok: true, status: 200, text: async () => html };
      } }),
      applySettingsPatch: async (patch, { provider }) => {
        assert.equal(provider, 'ollama');
        current = { ...current, ...patch };
        accepted = await fetchOllamaLimits(current, { env: {}, fetch: async () => { throw new Error('validation row should satisfy the authoritative poll'); } });
        return {};
      }
    });
    const result = await commands.saveCredential('ollama', { ollamaCookie: `wos-session=fixture-command-${index}` });
    assert.equal(result.saved, true);
    assert.equal(result.verdict, 'valid');
    assert.equal(current.ollamaApiKey, '');
    assert.equal(accepted.status, 'ok');
    assert.ok(Date.parse(accepted.updatedAt) >= result.checkedSince);
    assert.equal(requests, 1);
  }
});
