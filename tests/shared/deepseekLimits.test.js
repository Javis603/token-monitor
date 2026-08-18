'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { deepseekToken, parseLimitProviders, selectFundedRow, fetchDeepSeekLimits } = require('../../src/shared/limitCollector');

function memStoreDeps(initial = {}) {
  const box = { value: JSON.parse(JSON.stringify(initial)) };
  return {
    readJson: () => JSON.parse(JSON.stringify(box.value)),
    writeJsonAtomic: (_p, v) => { box.value = JSON.parse(JSON.stringify(v)); }
  };
}

function balanceResponse(infos) {
  return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: infos }) };
}

test('deepseekToken reads DEEPSEEK_API_KEY then DEEPSEEK_KEY, stripping quotes', () => {
  assert.equal(deepseekToken({ DEEPSEEK_API_KEY: '  "sk-abc"  ' }), 'sk-abc');
  assert.equal(deepseekToken({ DEEPSEEK_KEY: 'sk-def' }), 'sk-def');
  assert.equal(deepseekToken({}), '');
});

test('parseLimitProviders includes DeepSeek in the default provider set', () => {
  assert.ok(parseLimitProviders().includes('deepseek'));
});

test('selectFundedRow prefers the largest funded row, tie -> USD', () => {
  const rows = [
    { currency: 'CNY', total_balance: '4.61', topped_up_balance: '4.61' },
    { currency: 'USD', total_balance: '0.00', topped_up_balance: '0.00' }
  ];
  const sel = selectFundedRow(rows);
  assert.equal(sel.currency, 'CNY');
  assert.equal(sel.amount, 4.61);
  assert.equal(sel.paid, 4.61);
});

test('selectFundedRow falls back to USD then first when nothing is funded', () => {
  const sel = selectFundedRow([
    { currency: 'CNY', total_balance: '0', topped_up_balance: '0' },
    { currency: 'USD', total_balance: '0', topped_up_balance: '0' }
  ]);
  assert.equal(sel.currency, 'USD');
  assert.equal(sel.amount, 0);
});

test('fetchDeepSeekLimits returns notConfigured when no key', async () => {
  const r = await fetchDeepSeekLimits({}, { env: {} });
  assert.equal(r.provider, 'deepseek');
  assert.equal(r.status, 'notConfigured');
  assert.equal(r.source, 'api');
  assert.equal(r.balance, null);
});

test('fetchDeepSeekLimits returns ok with balance + spend, never leaks the key', async () => {
  const io = memStoreDeps();
  const t0 = new Date(2026, 5, 7, 8, 0, 0).getTime();
  const t1 = new Date(2026, 5, 7, 9, 0, 0).getTime();
  const env = { DEEPSEEK_API_KEY: 'sk-secret-123' };
  const deepseekStorePath = '/tmp/ds.json';

  await fetchDeepSeekLimits({}, {
    env, deepseekStorePath, now: () => t0,
    fetch: async () => balanceResponse([{ currency: 'CNY', total_balance: '10.00', topped_up_balance: '10.00' }]),
    ...io
  });
  const r = await fetchDeepSeekLimits({}, {
    env, deepseekStorePath, now: () => t1,
    fetch: async () => balanceResponse([{ currency: 'CNY', total_balance: '7.00', topped_up_balance: '7.00' }]),
    ...io
  });

  assert.equal(r.status, 'ok');
  assert.equal(r.balance.currency, 'CNY');
  assert.equal(r.balance.amount, 7);
  assert.equal(r.balance.todaySpend, 3);
  assert.equal(r.balance.weekSpend, 3);
  assert.equal(r.balance.allTimeSpend, 3);
  assert.equal(r.balance.trackingSince, new Date(t0).toISOString());
  assert.match(r.accountKey, /^sha256:/);
  assert.ok(!JSON.stringify(r).includes('sk-secret-123'));
});

test('fetchDeepSeekLimits migrates the legacy default store into the versioned path', async () => {
  const sharedDir = path.join('shared', 'deepseek');
  const versionedPath = path.join(sharedDir, 'deepseek-balance-v2.json');
  const legacyPath = path.join(sharedDir, 'deepseek-balance.json');
  const files = { [legacyPath]: {} };
  const reads = [];
  const writes = [];
  const r = await fetchDeepSeekLimits({}, {
    env: {
      DEEPSEEK_API_KEY: 'sk-migrate',
      TOKEN_MONITOR_SHARED_DIR: sharedDir
    },
    now: () => new Date(2026, 5, 7, 8, 0, 0).getTime(),
    fetch: async () => balanceResponse([
      { currency: 'CNY', total_balance: '4.61', topped_up_balance: '4.61' }
    ]),
    readJson: (filePath, fallback) => {
      reads.push(filePath);
      return Object.hasOwn(files, filePath)
        ? JSON.parse(JSON.stringify(files[filePath]))
        : fallback;
    },
    writeJsonAtomic: (filePath, value) => {
      files[filePath] = JSON.parse(JSON.stringify(value));
      writes.push(filePath);
    }
  });

  assert.equal(r.status, 'ok');
  assert.deepEqual(reads, [versionedPath, legacyPath]);
  assert.deepEqual(writes, [versionedPath]);
  assert.deepEqual(files[legacyPath], {});
});

test('fetchDeepSeekLimits prefers the widget settings API key over env fallback', async () => {
  let authorization = '';
  const r = await fetchDeepSeekLimits(
    { deepseekApiKey: " 'sk-settings' " },
    {
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      deepseekStorePath: '/tmp/ds-settings.json',
      fetch: async (_url, init) => {
        authorization = init.headers.Authorization;
        return balanceResponse([{ currency: 'USD', total_balance: '2.50', topped_up_balance: '2.50' }]);
      },
      ...memStoreDeps()
    }
  );

  assert.equal(r.status, 'ok');
  assert.equal(authorization, 'Bearer sk-settings');
  assert.ok(!JSON.stringify(r).includes('sk-settings'));
});

test('fetchDeepSeekLimits maps HTTP 401 to unauthorized', async () => {
  const r = await fetchDeepSeekLimits({}, {
    env: { DEEPSEEK_API_KEY: 'sk-x' },
    deepseekStorePath: '/tmp/ds2.json',
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    ...memStoreDeps()
  });
  assert.equal(r.status, 'unauthorized');
});

test('fetchDeepSeekLimits keeps HTTP 403 as unavailable', async () => {
  const r = await fetchDeepSeekLimits({}, {
    env: { DEEPSEEK_API_KEY: 'sk-x' },
    deepseekStorePath: '/tmp/ds-403.json',
    fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    ...memStoreDeps()
  });
  assert.equal(r.status, 'unavailable');
});

test('fetchDeepSeekLimits maps unexpected body shape to unavailable', async () => {
  const r = await fetchDeepSeekLimits({}, {
    env: { DEEPSEEK_API_KEY: 'sk-x' },
    deepseekStorePath: '/tmp/ds3.json',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
    ...memStoreDeps()
  });
  assert.equal(r.status, 'unavailable');
});

test('fetchDeepSeekLimits exposes the balance as a credits window', async () => {
  const provider = await fetchDeepSeekLimits({}, {
    env: { DEEPSEEK_API_KEY: 'sk-secret-123' },
    deepseekStorePath: '/tmp/ds-credits-window.json',
    now: () => new Date(2026, 6, 26, 8, 0, 0).getTime(),
    fetch: async () => balanceResponse([
      { currency: 'CNY', total_balance: '4.00', topped_up_balance: '4.00' }
    ]),
    ...memStoreDeps()
  });

  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows.length, 1);
  const [window] = provider.windows;
  assert.equal(window.kind, 'billing');
  assert.equal(window.metric, 'credits');
  assert.equal(window.label, 'Balance');
  assert.equal(window.remaining, 4);
  assert.equal(window.currency, 'CNY');
  assert.equal(window.showMeter, true);
  // The derived percentage is display-only and must never reach the wire.
  assert.equal(window.usedPercent, null);
  assert.equal(window.remainingPercent, null);
  // The balance block is untouched.
  assert.equal(provider.balance.amount, 4);
  assert.equal(provider.balance.currency, 'CNY');
});

// fetchJson's abort timer has to outlive the body read. A head-then-stall response is
// otherwise bounded only by the outer probe deadline, two orders of magnitude later.
test('fetchDeepSeekLimits bounds a body that stalls after the headers', { timeout: 5000 }, async () => {
  const r = await fetchDeepSeekLimits({}, {
    env: { DEEPSEEK_API_KEY: 'sk-test' },
    now: () => Date.parse('2026-06-25T00:00:00.000Z'),
    fetchTimeoutMs: 10,
    fetch: async (_url, init) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    })
  });
  assert.equal(r.status, 'unavailable');
});
