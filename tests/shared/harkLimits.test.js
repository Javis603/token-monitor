'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { readBinaryCookies } = require('../../src/shared/providers/hark/desktop');
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
  const pages = [cookiePage(records)];
  const header = Buffer.alloc(8 + pages.length * 4);
  header.write('cook', 0, 'ascii');
  header.writeUInt32BE(pages.length, 4);
  let offset = header.length;
  const chunks = [header];
  for (let index = 0; index < pages.length; index += 1) {
    header.writeUInt32BE(pages[index].length, 8 + index * 4);
    chunks.push(pages[index]);
    offset += pages[index].length;
  }
  return Buffer.concat(chunks, offset);
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
  page.writeUInt32LE(0x00000100, 0);
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
});

test('unlimited and paid summaries keep the same window rules', () => {
  const unlimited = windowsFromSummary({
    plan: { id: 'pro', name: 'hark pro²', unlimited: true },
    meters: { harkTokens: { dailyLimit: 1, dailyUsed: 1, poolLimit: 1, poolUsed: 1 }, perFeature: [] }
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
      }]
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

test('a summary without meters is unavailable', () => {
  assert.throws(() => windowsFromSummary({ plan: { id: 'free' } }), (error) => error.status === 'unavailable');
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

  const accepted = await fetchHarkLimits({ harkCookie: ENCODED_SESSION }, {
    readHarkDesktopSession() { reads += 1; return ''; },
    fetch: async (url, init) => {
      assert.equal(init.headers.Cookie, `__Secure-hark.session_token=${ENCODED_SESSION}`);
      return { ok: true, status: 200, json: async () => FREE_SUMMARY };
    }
  });
  assert.equal(accepted.status, 'ok');
  assert.equal(accepted.planLabel, 'Hark Pro');
  assert.equal(accepted.source, 'web');
  assert.equal(reads, 0);
  assert.equal(accepted.windows.length, 2);
});

test('desktop discovery reads only the Hark session cookie', async () => {
  const file = cookieFile([
    { name: '_ga', value: 'GA1.1.1853625455.1794216537', domain: '.hark.com' },
    { name: '__Secure-hark.session_token', value: ENCODED_SESSION, domain: '.hark.com' }
  ]);
  const found = readBinaryCookies(file).find((cookie) => cookie.name === '__Secure-hark.session_token');
  assert.equal(found.value, ENCODED_SESSION);
  assert.throws(() => readBinaryCookies(Buffer.from('nope')), (error) => error.status === 'unavailable');

  const missing = await fetchHarkLimits({}, {
    readHarkDesktopSession() { return ''; }
  });
  assert.equal(missing.status, 'notConfigured');
  assert.equal(missing.source, 'local');

  const fromApp = await fetchHarkLimits({}, {
    readHarkDesktopSession() { return ENCODED_SESSION; },
    fetch: async (url, init) => {
      assert.equal(url, 'https://hark.com/api/billing/summary');
      assert.equal(init.headers.Cookie, `__Secure-hark.session_token=${ENCODED_SESSION}`);
      return { ok: true, status: 200, json: async () => FREE_SUMMARY };
    }
  });
  assert.equal(fromApp.status, 'ok');
  assert.equal(fromApp.source, 'local');
  assert.equal(fromApp.sourceDetail, 'app');
});

test('an HTTP 401 is unauthorized and a 500 stays unavailable', async () => {
  const unauthorized = await fetchHarkLimits({ harkCookie: SESSION }, {
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) })
  });
  assert.equal(unauthorized.status, 'unauthorized');
  const unavailable = await fetchHarkLimits({ harkCookie: SESSION }, {
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) })
  });
  assert.equal(unavailable.status, 'unavailable');
});
