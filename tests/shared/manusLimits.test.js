'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  MANUS_SESSION_COOKIE_HOST,
  MANUS_SESSION_COOKIE_NAME,
  manusDesktopCookieCandidates,
  manusSessionClaims,
  readManusDesktopSession
} = require('../../src/shared/providers/manus/desktop');
const {
  fetchManusLimits,
  manusCreditsUrl,
  parseManusCredits
} = require('../../src/shared/providers/manus/limits');
const { hashKey } = require('../../src/shared/hashKey');

const creditsFixture = require('../fixtures/manusAvailableCredits.json');

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// An unsigned fixture JWT; the signature segment is never checked locally.
const FIXTURE_TOKEN = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ user_id: 'fixture-user', email: 'fixture@example.com' })}.c2lnbmF0dXJl`;

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function fakeFs(files = {}) {
  return {
    statSync(file) {
      if (Object.prototype.hasOwnProperty.call(files, file)) {
        const entry = files[file];
        if (entry instanceof Error) throw entry;
        return { isFile: () => entry !== 'dir' };
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
  };
}

function fakeSqlite(row, calls = []) {
  return {
    DatabaseSync: class {
      constructor(file, options) { calls.push({ file, options }); }
      prepare(sql) {
        calls.push({ sql });
        return { get: (...params) => { calls.push({ params }); return row; } };
      }
      close() { calls.push({ closed: true }); }
    }
  };
}

const DB = '/fixture/Cookies';

function sessionStatus(options) {
  try {
    readManusDesktopSession(options);
    return 'ok';
  } catch (error) {
    return error.status;
  }
}

test('Manus cookie store is located only where the macOS app keeps it', () => {
  assert.deepEqual(manusDesktopCookieCandidates({ platform: 'darwin', home: '/Users/fixture' }), [
    path.join('/Users/fixture', 'Library', 'Application Support', 'Manus', 'Cookies')
  ]);
  assert.deepEqual(manusDesktopCookieCandidates({ platform: 'win32', home: 'C:\\Users\\fixture' }), []);
  assert.deepEqual(manusDesktopCookieCandidates({ platform: 'linux', home: '/home/fixture' }), []);
});

test('Manus desktop session reads one host-scoped cookie, read-only, and decodes its identity', () => {
  const calls = [];
  const session = readManusDesktopSession({
    candidates: [DB],
    fs: fakeFs({ [DB]: 'file' }),
    sqlite: fakeSqlite({ value: ` ${FIXTURE_TOKEN} `, encrypted_value: Buffer.alloc(0) }, calls)
  });
  assert.deepEqual(session, { token: FIXTURE_TOKEN, userId: 'fixture-user', email: 'fixture@example.com' });
  assert.deepEqual(calls[0], { file: DB, options: { readOnly: true } });
  assert.match(calls[1].sql, /WHERE host_key = \? AND name = \?/);
  assert.deepEqual(calls[2].params, [MANUS_SESSION_COOKIE_HOST, MANUS_SESSION_COOKIE_NAME]);
  assert.deepEqual(calls.at(-1), { closed: true });
});

test('Manus desktop session failures map to the status the panel should show', () => {
  const base = { candidates: [DB], fs: fakeFs({ [DB]: 'file' }) };
  assert.equal(sessionStatus({ ...base, candidates: [] }), 'notConfigured');
  assert.equal(sessionStatus({ ...base, fs: fakeFs({}) , sqlite: fakeSqlite(null) }), 'notConfigured');
  assert.equal(sessionStatus({ ...base, fs: fakeFs({ [DB]: Object.assign(new Error('denied'), { code: 'EACCES' }) }), sqlite: fakeSqlite(null) }), 'unavailable');
  assert.equal(sessionStatus({ ...base, sqlite: null }), 'unavailable');
  assert.equal(sessionStatus({ ...base, sqlite: { DatabaseSync: class { constructor() { throw new Error('locked'); } } } }), 'unavailable');
  assert.equal(sessionStatus({ ...base, sqlite: fakeSqlite(undefined) }), 'notConfigured');
  assert.equal(sessionStatus({ ...base, sqlite: fakeSqlite({ value: '', encrypted_value: Buffer.alloc(0) }) }), 'notConfigured');
  assert.equal(sessionStatus({ ...base, sqlite: fakeSqlite({ value: '', encrypted_value: Buffer.from('v10cipher') }) }), 'unavailable');
  assert.equal(sessionStatus({ ...base, sqlite: fakeSqlite({ value: 'not-a-jwt', encrypted_value: Buffer.alloc(0) }) }), 'unauthorized');
  assert.equal(sessionStatus({ ...base, sqlite: fakeSqlite({ value: 'a.b.c\r\nX-Injected: 1', encrypted_value: Buffer.alloc(0) }) }), 'unauthorized');
});

test('Manus session claims tolerate malformed payloads', () => {
  assert.deepEqual(manusSessionClaims(''), {});
  assert.deepEqual(manusSessionClaims('a.%%%.c'), {});
  assert.deepEqual(manusSessionClaims(`a.${b64url([1, 2])}.c`), {});
  assert.equal(manusSessionClaims(FIXTURE_TOKEN).user_id, 'fixture-user');
});

test('Manus credits parse into a daily refresh meter and a credits balance', () => {
  const { total, windows } = parseManusCredits(creditsFixture);
  assert.equal(total, 1180);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], {
    kind: 'daily',
    label: 'Daily credits',
    used: 120,
    limit: 300,
    remaining: 180,
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: '2026-05-02T16:00:00.000Z',
    windowMinutes: 1440
  });
  assert.deepEqual(windows[1], {
    kind: 'billing',
    label: 'Credits',
    metric: 'credits',
    currency: 'CREDITS',
    remaining: 1180,
    resetsAt: null,
    showMeter: false
  });
});

test('Manus credits treat omitted Connect fields as zero but reject unknown shapes', () => {
  // Connect drops zero-valued fields: an exhausted free account sends only the ceiling.
  const exhausted = parseManusCredits({ maxRefreshCredits: 300, refreshInterval: 'daily' });
  assert.equal(exhausted.total, 0);
  assert.equal(exhausted.windows[0].usedPercent, 100);
  assert.equal(exhausted.windows[0].resetsAt, null);
  assert.equal(exhausted.windows[1].remaining, 0);

  const noAllowance = parseManusCredits({ totalCredits: 50 });
  assert.deepEqual(noAllowance.windows.map((window) => window.metric || window.kind), ['credits']);

  const monthly = parseManusCredits({ ...creditsFixture, refreshInterval: 'monthly' });
  assert.equal(monthly.windows[0].kind, 'billing');
  assert.equal(monthly.windows[0].label, 'Refresh credits');
  assert.equal(monthly.windows[0].windowMinutes, undefined);

  const over = parseManusCredits({ ...creditsFixture, refreshCredits: 500 });
  assert.equal(over.windows[0].remaining, 300);
  assert.equal(over.windows[0].used, 0);

  for (const body of [null, [], 'x', {}, { qualityTrial: 1 }]) {
    assert.throws(() => parseManusCredits(body), /Manus credits/);
  }
  assert.throws(() => parseManusCredits({ totalCredits: 'lots' }), /not a number/);
});

test('Manus fetch posts the Connect RPC with the desktop bearer and returns credits', async () => {
  const calls = [];
  const provider = await fetchManusLimits({}, {
    now: () => Date.parse('2026-05-02T08:00:00Z'),
    readManusDesktopSession: () => ({ token: FIXTURE_TOKEN, userId: 'fixture-user', email: 'fixture@example.com' }),
    fetch: async (url, init) => { calls.push({ url, init }); return response(creditsFixture); }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, manusCreditsUrl());
  assert.equal(calls[0].url, 'https://api.manus.im/user.v1.UserService/GetAvailableCredits');
  const { init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.body, '{}');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.Authorization, `Bearer ${FIXTURE_TOKEN}`);
  assert.equal(init.headers['Connect-Protocol-Version'], '1');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(Object.keys(init.headers).some((key) => key.toLowerCase() === 'host' || key.toLowerCase() === 'cookie'), false);

  assert.equal(provider.provider, 'manus');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'api');
  assert.equal(provider.accountKey, hashKey('manus', 'fixture-user'));
  assert.equal(provider.accountEmail, 'fixture@example.com');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['daily', 'billing']);
  assert.equal(provider.balance.amount, 1180);
  assert.equal(JSON.stringify(provider).includes(FIXTURE_TOKEN), false, 'the session token never reaches the reading');
  assert.equal(JSON.stringify(provider).includes('c2lnbmF0dXJl'), false);
});

test('Manus fetch maps session and HTTP failures without leaking the token', async () => {
  const session = () => ({ token: FIXTURE_TOKEN, userId: '', email: '' });
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'sourceRateLimited'], [500, 'unavailable'], [404, 'unavailable']]) {
    const provider = await fetchManusLimits({}, { readManusDesktopSession: session, fetch: async () => response(null, status) });
    assert.equal(provider.status, expected, String(status));
    assert.equal(provider.accountKey, hashKey('manus', FIXTURE_TOKEN), 'falls back to a hash of the session');
    assert.equal(JSON.stringify(provider).includes(FIXTURE_TOKEN), false);
  }
  const malformed = await fetchManusLimits({}, { readManusDesktopSession: session, fetch: async () => response({ unexpected: true }) });
  assert.equal(malformed.status, 'unavailable');
  const thrown = await fetchManusLimits({}, { readManusDesktopSession: session, fetch: async () => { throw new Error('offline'); } });
  assert.equal(thrown.status, 'unavailable');

  let fetched = false;
  for (const status of ['notConfigured', 'unauthorized', 'unavailable']) {
    const provider = await fetchManusLimits({}, {
      readManusDesktopSession: () => { throw Object.assign(new Error('x'), { status }); },
      fetch: async () => { fetched = true; return response(creditsFixture); }
    });
    assert.equal(provider.status, status);
  }
  assert.equal(fetched, false, 'no request goes out without a session');
});
