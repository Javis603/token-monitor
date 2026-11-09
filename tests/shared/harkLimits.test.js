'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { aggregateLimits } = require('../../src/shared/limits/core');

const {
  fetchHarkLimits,
  normalizeHarkSessionToken,
  windowsFromSummary
} = require('../../src/shared/providers/hark/limits');

const SESSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb+/=';
const ENCODED_SESSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb%2B%2F%3D';

const FREE_SUMMARY = {
  plan: { id: 'free', name: 'Hark Pro', source: 'default', unlimited: false },
  meters: {
    harkTokens: {
      dailyUsed: 136379,
      dailyLimit: 8000000,
      dailyResetsAt: '2026-11-10T09:31:57Z',
      poolUsed: 136379,
      poolLimit: 40000000,
      poolResetsAt: '2026-12-09T09:28:49Z'
    },
    perFeature: []
  },
  autoTopup: { enabled: false, state: 'off', spentThisPeriodMinor: 0, eligible: false },
  subscription: { status: 'none', billingPeriod: null, currentPeriodEnd: null }
};

function cookieFile(records) {
  const page = cookiePage(records);
  const header = Buffer.alloc(12);
  header.write('cook', 0, 'ascii');
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(page.length, 8);
  return Buffer.concat([header, page]);
}

function cookiePage(records) {
  const encoded = records.map(cookieRecord);
  const table = 8 + encoded.length * 4;
  let cursor = table;
  const offsets = encoded.map((record) => {
    const at = cursor;
    cursor += record.length;
    return at;
  });
  const page = Buffer.alloc(cursor);
  page.writeUInt32BE(0x00000100, 0);
  page.writeUInt32LE(encoded.length, 4);
  offsets.forEach((at, index) => page.writeUInt32LE(at, 8 + index * 4));
  encoded.forEach((record, index) => record.copy(page, offsets[index]));
  return page;
}

function cookieRecord({ name, value, domain, path = '/' }) {
  const header = 48;
  const urlOffset = header;
  const nameOffset = urlOffset + Buffer.byteLength(domain) + 1;
  const pathOffset = nameOffset + Buffer.byteLength(name) + 1;
  const valueOffset = pathOffset + Buffer.byteLength(path) + 1;
  const end = valueOffset + Buffer.byteLength(value) + 1;
  const record = Buffer.alloc(end);
  record.writeUInt32LE(end, 0);
  record.writeUInt32LE(urlOffset, 16);
  record.writeUInt32LE(nameOffset, 20);
  record.writeUInt32LE(pathOffset, 24);
  record.writeUInt32LE(valueOffset, 28);
  record.write(domain, urlOffset);
  record.write(name, nameOffset);
  record.write(path, pathOffset);
  record.write(value, valueOffset);
  return record;
}

test('a free summary is a daily window and a monthly pool', () => {
  const parsed = windowsFromSummary(FREE_SUMMARY);
  assert.equal(parsed.planLabel, 'Hark Pro');
  assert.deepEqual(parsed.windows.map((window) => [window.kind, window.label, window.used, window.limit]), [
    ['daily', 'Daily', 136379, 8000000],
    ['billing', 'Monthly', 136379, 40000000]
  ]);
  const uncapped = windowsFromSummary({ ...FREE_SUMMARY, meters: {
    harkTokens: { ...FREE_SUMMARY.meters.harkTokens, dailyLimit: 0, poolLimit: 0 }
  } });
  assert.deepEqual(uncapped.windows, []);
});

test('unlimited and paid summaries keep the same window rules', () => {
  const unlimited = windowsFromSummary({
    plan: { id: 'pro', name: 'hark pro²', unlimited: true },
    meters: {
      harkTokens: { dailyLimit: 1, dailyUsed: 1, poolLimit: 1, poolUsed: 1 },
      perFeature: [{ feature: 'message', period: 'month', countUsed: 1, countLimit: 10 }]
    }
  });
  assert.equal(unlimited.planLabel, 'Hark Pro 2');
  assert.deepEqual(unlimited.windows, []);

  const paid = windowsFromSummary({
    plan: { id: 'scale', name: 'hark pro³', unlimited: false },
    subscription: { status: 'active', billingPeriod: 'annual', provider: 'apple', currentPeriodEnd: '2027-01-01T00:00:00Z' },
    meters: {
      harkTokens: { dailyUsed: 1, dailyLimit: 16, dailyResetsAt: '2026-11-10T00:00:00Z', poolUsed: 2, poolLimit: 80, poolResetsAt: '2026-12-01T00:00:00Z' },
      perFeature: [{
        feature: 'message',
        period: 'month',
        countUsed: 3,
        countLimit: 10,
        harkUsed: 4,
        harkLimit: 20,
        resetsAt: '2026-12-01T00:00:00Z'
      }, { feature: 'browser_session', meter: 'instances', period: 'day', countUsed: 1, countLimit: 2 }]
    },
    autoTopup: { enabled: true, spentThisPeriodMinor: 250 }
  });
  assert.deepEqual(paid.windows.map((window) => [window.kind, window.label, window.metric || '', window.used, window.limit ?? null]), [
    ['daily', 'Daily', '', 1, 16],
    ['billing', 'Monthly', '', 2, 80],
    ['billing', 'Monthly Messages', '', 3, 10],
    ['billing', 'Monthly Messages tokens', '', 4, 20],
    ['billing', 'Top-up', 'spend', 2.5, null]
  ]);
});

test('an incomplete summary is unavailable instead of dropping its quota bars', () => {
  for (const harkTokens of [undefined, {}, { ...FREE_SUMMARY.meters.harkTokens, dailyUsed: 'oops' }]) {
    assert.throws(() => windowsFromSummary({ ...FREE_SUMMARY, meters: { harkTokens } }),
      (error) => error.status === 'unavailable');
  }
});

test('a pasted cookie is the only credential, and a bad paste does not read the desktop app', async () => {
  assert.equal(normalizeHarkSessionToken(`__Secure-hark.session_token=${ENCODED_SESSION}`), ENCODED_SESSION);
  assert.equal(normalizeHarkSessionToken(SESSION), SESSION);
  assert.equal(normalizeHarkSessionToken(`other=${SESSION}`), '');
  let reads = 0;
  const rejected = await fetchHarkLimits({ harkCookie: 'not a session' }, {
    readHarkDesktopSession() { reads += 1; return SESSION; }
  });
  assert.equal(rejected.status, 'unauthorized');
  assert.equal(reads, 0);

  const accepted = [];
  for (const token of [ENCODED_SESSION, SESSION]) {
    const result = await fetchHarkLimits({ harkCookie: token }, {
      env: {},
      readHarkDesktopSession() { reads += 1; return ''; },
      fetch: async (url, init) => {
        assert.equal(init.headers.Cookie, `__Secure-hark.session_token=${token}`);
        return { ok: true, status: 200, json: async () => FREE_SUMMARY };
      }
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'web');
    accepted.push(result);
  }
  assert.equal(accepted[0].accountKey, accepted[1].accountKey);
  assert.equal(reads, 0);
});

test('desktop discovery reads only the Hark session cookie', async () => {
  const file = cookieFile([
    { name: '_ga', value: 'ignored-analytics', domain: '.hark.com' },
    { name: '__Secure-hark.session_token', value: ENCODED_SESSION, domain: '.hark.com' }
  ]);
  const fromApp = await fetchHarkLimits({}, {
    env: {},
    harkDesktopOptions: {
      candidates: ['hark-fixture.binarycookies'],
      fs: { statSync: () => ({ isFile: () => true }), readFileSync: () => file }
    },
    fetch: async (url, init) => {
      assert.equal(url, 'https://hark.com/api/billing/summary');
      assert.equal(init.headers.Cookie, `__Secure-hark.session_token=${ENCODED_SESSION}`);
      return { ok: true, status: 200, json: async () => FREE_SUMMARY };
    }
  });
  assert.equal(fromApp.status, 'ok');
  assert.equal(fromApp.source, 'local');
});

test('missing desktop credentials differ from an unreadable store', async () => {
  const missing = await fetchHarkLimits({}, {
    env: {}, harkDesktopOptions: { candidates: [] }
  });
  assert.equal(missing.status, 'notConfigured');
  for (const [read, expected] of [
    [() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, 'unavailable'],
    [() => Buffer.from('nope'), 'unavailable'],
    [() => cookieFile([{ name: 'other', value: SESSION, domain: '.hark.com' }]), 'notConfigured']
  ]) {
    const result = await fetchHarkLimits({}, {
      env: {},
      harkDesktopOptions: {
        candidates: ['hark-fixture.binarycookies'],
        fs: { statSync: () => ({ isFile: () => true }), readFileSync: read }
      },
      fetch: async () => { assert.fail('no request without a desktop credential'); }
    });
    assert.equal(result.status, expected);
  }
});

test('HTTP failures recover and a new desktop session replaces its previous account', async (t) => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [500, 'unavailable']]) {
    const result = await fetchHarkLimits({ harkCookie: SESSION }, {
      env: {}, fetch: async () => ({ ok: false, status })
    });
    assert.equal(result.status, expected);
  }
  let status = 200;
  let token = SESSION;
  let body = FREE_SUMMARY;
  let now = Date.parse('2026-11-09T12:00:00Z');
  const runtime = createLimitsRuntime({ limitProviders: ['hark'] }, {
    autoStart: false, autoRetry: false, env: {},
    now: () => now,
    readHarkDesktopSession: () => token,
    fetch: async () => ({ ok: status === 200, status, json: async () => body })
  });
  t.after(() => runtime.stop());
  await runtime.refresh({ provider: 'hark' }, 'settings-change');
  const rows = runtime.getSnapshot().providers;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  now += 1000;
  status = 500;
  await runtime.refresh({ provider: 'hark' }, 'settings-change');
  const outage = runtime.getSnapshot().providers;
  assert.equal(outage.length, 1);
  assert.equal(outage[0].status, 'unavailable');
  assert.equal(outage[0].accountKey, rows[0].accountKey);
  assert.deepEqual(outage[0].windows, rows[0].windows);
  token = SESSION.replace(/^a/, 'c');
  now += 1000;
  status = 401;
  await runtime.refresh({ provider: 'hark' }, 'settings-change');
  const rejected = aggregateLimits([{ deviceId: 'local', limits: runtime.getSnapshot() }], 0, now);
  const kept = rejected.providers.find((row) => row.accountKey === rows[0].accountKey);
  assert.deepEqual(kept?.windows, rows[0].windows);
  status = 500;
  await runtime.refresh({ provider: 'hark' }, 'settings-change');
  const missed = runtime.getSnapshot().providers;
  assert.ok(missed.every((row) => row.accountKey));
  assert.deepEqual(missed.find((row) => row.accountKey === rows[0].accountKey)?.windows, rows[0].windows);
  status = 200;
  await runtime.refresh({ provider: 'hark' }, 'settings-change');
  const rotated = runtime.getSnapshot().providers;
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].status, 'ok');
  assert.notEqual(rotated[0].accountKey, rows[0].accountKey);
  body = { ...FREE_SUMMARY, meters: { harkTokens: {} } };
  await runtime.refresh({ provider: 'hark' }, 'settings-change');
  const failed = runtime.getSnapshot().providers;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'unavailable');
  assert.equal(failed[0].accountKey, rotated[0].accountKey);
  assert.deepEqual(failed[0].windows, rotated[0].windows);
});

test('a desktop session configures the account, and an unreadable store does not sign it out', () => {
  const account = require('../../src/shared/providers/hark/account');
  const limits = { harkCookie: () => '' };
  assert.equal(account.discover({}, { readHarkDesktopSession: () => SESSION }), true);
  assert.equal(account.discover({}, { readHarkDesktopSession: () => '' }), false);
  assert.equal(account.discover({}, {
    readHarkDesktopSession() { throw Object.assign(new Error('denied'), { status: 'unavailable' }); }
  }), true);
  assert.deepEqual(account.accountStatus({ settings: {}, env: {}, discovered: true, limits }), {
    harkCookieConfigured: true,
    harkCookieSource: 'hark-desktop'
  });
});
