'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { billingPartition, disconnectGrokBilling, fetchBillingItems, refreshGrokBillingItems,
  billingItemsPath, openGrokDashboardWindow, startGrokBillingRefresh } = require('../../src/electron/grokDashboardBilling');

const ACCOUNT = { accountId: 'test-account', expectedEmail: 'owner@example.test' };

function item(id, product = 'cursor') {
  return {
    id, product, displayExtras: { userEmail: ACCOUNT.expectedEmail }, model: 'auto', eventTime: '2026-10-20T04:00:00Z',
    usage: { 'prompt-text-tokens': '10' }
  };
}

test('billing pagination continues across pages containing only other products', async () => {
  const pages = [
    { items: [item('grok', 'grok-chat')], nextPageToken: 'page-2' },
    { items: [item('cursor-1'), item('cursor-2')], nextPageToken: 'page-3' },
    { items: [item('cursor-2'), item('cursor-3')] }
  ];
  let calls = 0;
  const rows = await fetchBillingItems(null, {
    startTime: '2026-10-01T00:00:00Z', endTime: '2026-10-21T00:00:00Z',
    fetchImpl: async url => {
      assert.equal(url.searchParams.get('cursor'), calls ? `page-${calls + 1}` : null);
      return { ok: true, json: async () => pages[calls++] };
    }
  });
  assert.equal(calls, 3);
  assert.equal(rows.length, 3, 'different billing ids with identical token counts are distinct calls');
});

test('billing refresh uses the logged-in dashboard renderer and not session.fetch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-billing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let rendererCalls = 0;
  const count = await refreshGrokBillingItems({
    ...ACCOUNT, userDataPath: dir,
    session: { fromPartition: () => ({ fetch: () => assert.fail('net.fetch hits the Cloudflare challenge') }) },
    webContents: {
      isDestroyed: () => false,
      getURL: () => 'https://grok.com/dashboard/usage',
      executeJavaScript: async source => {
        rendererCalls++;
        assert.match(source, /query-billing-items/);
        return { ok: true, status: 200, payload: { items: [item('cursor-1')] } };
      }
    }
  });
  assert.equal(rendererCalls, 1);
  assert.equal(count, 1);
  assert.equal(JSON.parse(fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId))).rows.length, 1);
});

test('billing ledger retains old rows, updates by billing id, and survives a failed pagination', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-retention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { ...ACCOUNT, userDataPath: dir, homeDir: dir, session: { fromPartition: () => ({}) } };
  const fetchRows = items => async () => ({ ok: true, json: async () => ({ data: items }) });
  await refreshGrokBillingItems({ ...options, fetchImpl: fetchRows([item('old')]) });
  await refreshGrokBillingItems({ ...options, fetchImpl: fetchRows([item('new')]) });
  await refreshGrokBillingItems({ ...options, fetchImpl: fetchRows([item('new')]) });
  const before = fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId), 'utf8');
  assert.equal(JSON.parse(before).rows.length, 2);
  await assert.rejects(refreshGrokBillingItems({
    ...options, fetchImpl: async () => ({
      ok: true, json: async () => ({ data: [item('partial')], pagination: { hasMore: true, nextCursor: 'same' } })
    })
  }), /pagination did not finish/);
  assert.equal(fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId), 'utf8'), before);
});

test('today refresh queries local midnight and retains the historical ledger', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-today-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { ...ACCOUNT, userDataPath: dir, homeDir: dir, session: { fromPartition: () => ({}) } };
  await refreshGrokBillingItems({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [item('old')] }) }) });
  const now = new Date(2026, 9, 21, 6, 43);
  const midnight = new Date(2026, 9, 21);
  const tomorrow = new Date(2026, 9, 22);
  await refreshGrokBillingItems({ ...options, now, todayOnly: true, fetchImpl: async url => {
    assert.equal(url.searchParams.get('startTime'), midnight.toISOString());
    assert.equal(url.searchParams.get('endTime'), tomorrow.toISOString());
    return { ok: true, json: async () => ({ data: [{ ...item('new'), eventTime: now.toISOString() }] }) };
  } });
  assert.deepEqual(JSON.parse(fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId))).rows.map(row => row.id).sort(), ['new', 'old']);
});

test('billing changes include corrected existing calls but exclude identical responses', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-changed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let changes = 0;
  let row = item('same-call');
  const options = {
    ...ACCOUNT, userDataPath: dir, homeDir: dir, session: { fromPartition: () => ({}) },
    onChanged: () => { changes++; },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [row] }) })
  };
  await refreshGrokBillingItems(options);
  await refreshGrokBillingItems(options);
  assert.equal(changes, 1);
  row = { ...row, usage: { 'prompt-text-tokens': '20' } };
  await refreshGrokBillingItems(options);
  assert.equal(changes, 2);
  assert.equal(JSON.parse(fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId))).rows.length, 1);
});

test('background billing refreshes today, periodically reconciles history and skips unchanged scans', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-poll-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date(2026, 9, 21, 6, 43).getTime() });
  let enabled = true;
  let published = 0;
  const starts = [];
  const stop = startGrokBillingRefresh({
    ...ACCOUNT, userDataPath: dir, homeDir: dir, session: { fromPartition: () => ({}) },
    isEnabled: () => enabled,
    onRefresh: () => { published++; },
    fetchImpl: async url => {
      starts.push(url.searchParams.get('startTime'));
      return { ok: true, json: async () => ({ data: [item('same-call')] }) };
    }
  });
  t.after(stop);
  t.mock.timers.tick(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, [new Date(2026, 9, 21).toISOString()]);
  assert.equal(published, 1);
  t.mock.timers.tick(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 2);
  assert.equal(published, 1, 'unchanged billing must not repeatedly spawn collection');
  enabled = false;
  t.mock.timers.tick(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 2, 'no requests without a local Cursor collector');
  enabled = true;
  t.mock.timers.tick(510000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 3);
  assert.ok(new Date(starts[2]) < new Date(2026, 9, 21), 'periodically fetch older, late-arriving bills');
  stop();
  t.mock.timers.tick(600000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 3);
});

test('background billing never overlaps requests or publishes after shutdown', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setInterval'] });
  let complete;
  let requests = 0;
  let published = 0;
  const stop = startGrokBillingRefresh({
    ...ACCOUNT, userDataPath: dir, homeDir: dir, session: { fromPartition: () => ({}) },
    onRefresh: () => { published++; },
    fetchImpl: () => {
      requests++;
      return new Promise(resolve => { complete = resolve; });
    }
  });
  t.after(stop);
  t.mock.timers.tick(30000);
  t.mock.timers.tick(60000);
  assert.equal(requests, 1);
  stop();
  complete({ ok: true, json: async () => ({ data: [item('late')] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published, 0);
  assert.equal(fs.existsSync(billingItemsPath(dir, ACCOUNT.accountId)), false, 'shutdown must also fence the ledger write');
});

test('separate Cursor accounts use separate sessions and ledgers even for equal billing ids', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const partitions = [];
  const session = { fromPartition: name => { partitions.push(name); return {}; } };
  for (const accountId of ['work', 'personal']) {
    await refreshGrokBillingItems({ userDataPath: dir, accountId, expectedEmail: ACCOUNT.expectedEmail, session,
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [item('same-id')] }) }) });
  }
  assert.notEqual(partitions[0], partitions[1]);
  assert.equal(JSON.parse(fs.readFileSync(billingItemsPath(dir, 'work'))).rows.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(billingItemsPath(dir, 'personal'))).rows.length, 1);
  assert.doesNotMatch(fs.readFileSync(billingItemsPath(dir, 'work'), 'utf8'), /owner@example|"accountId"/);
});

test('wrong or missing billing owner cannot overwrite an account ledger', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { ...ACCOUNT, userDataPath: dir, session: { fromPartition: () => ({}) } };
  await refreshGrokBillingItems({ ...options,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [item('valid')] }) }) });
  const before = fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId), 'utf8');
  for (const userEmail of ['', 'other@example.test']) {
    await assert.rejects(refreshGrokBillingItems({ ...options,
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ ...item('wrong'), displayExtras: { userEmail } }] }) })
    }), { code: 'BILLING_ACCOUNT_MISMATCH' });
    assert.equal(fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId), 'utf8'), before);
  }
});

test('normalized Cursor product labels still require the verified billing owner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-normalized-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { ...ACCOUNT, userDataPath: dir, session: { fromPartition: () => ({}) } };
  const fetchRows = rows => async () => ({ ok: true, json: async () => ({ items: rows }) });
  await refreshGrokBillingItems({ ...options, fetchImpl: fetchRows([item('valid')]) });
  const before = fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId), 'utf8');
  for (const product of [{ product: ' CURSOR ' }, { product: undefined, Product: ' CURSOR ' }]) {
    for (const userEmail of ['', 'other@example.test']) {
      const row = { ...item('wrong'), ...product, displayExtras: { userEmail } };
      await assert.rejects(refreshGrokBillingItems({ ...options, fetchImpl: fetchRows([row]) }),
        { code: 'BILLING_ACCOUNT_MISMATCH' });
      assert.equal(fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId), 'utf8'), before);
    }
  }
});

test('an unfinished page without a continuation cursor preserves the existing ledger', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-incomplete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { ...ACCOUNT, userDataPath: dir, session: { fromPartition: () => ({}) } };
  await refreshGrokBillingItems({ ...options,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [item('old')] }) }) });
  const before = fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId), 'utf8');
  await assert.rejects(refreshGrokBillingItems({ ...options,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [item('partial')], pagination: { hasMore: true } }) })
  }), /pagination did not finish/);
  assert.equal(fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId), 'utf8'), before);
});

test('a corrupt account ledger is not silently replaced', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = billingItemsPath(dir, ACCOUNT.accountId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{bad-json');
  await assert.rejects(refreshGrokBillingItems({ ...ACCOUNT, userDataPath: dir,
    session: { fromPartition: () => ({}) }, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [item('new')] }) }) }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad-json');
});

test('disconnect clears only that account session and prevents an in-flight write after reconnect', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-disconnect-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cleared = [];
  const session = { fromPartition: name => ({ clearStorageData: async () => { cleared.push(name); } }) };
  let complete;
  const options = { ...ACCOUNT, userDataPath: dir, session };
  const pending = refreshGrokBillingItems({ ...options,
    fetchImpl: () => new Promise(resolve => { complete = resolve; }) });
  await disconnectGrokBilling({ session, accountId: ACCOUNT.accountId });
  await refreshGrokBillingItems({ ...options,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [item('new-login')] }) }) });
  complete({ ok: true, json: async () => ({ data: [item('stale-login')] }) });
  await assert.rejects(pending, /connection changed/);
  assert.deepEqual(cleared, [billingPartition(ACCOUNT.accountId)]);
  assert.deepEqual(JSON.parse(fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId))).rows.map(row => row.id), ['new-login']);
});

test('a failed account does not stop the serial polling of other enabled accounts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-independent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setInterval'] });
  const seen = [];
  const stop = startGrokBillingRefresh({ userDataPath: dir, session: { fromPartition: () => ({}) },
    getAccounts: () => ['bad', 'good'].map(accountId => ({ accountId, expectedEmail: ACCOUNT.expectedEmail,
      fetchImpl: async () => { seen.push(accountId); return { ok: accountId === 'good', status: 403,
        json: async () => ({ data: [item('good')] }) }; } })) });
  t.after(stop);
  t.mock.timers.tick(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['bad', 'good']);
  assert.equal(fs.existsSync(billingItemsPath(dir, 'good')), true);
});

test('dashboard script is never executed in a different page or origin', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-origin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const url of ['https://grok.com/dashboard/usage-other', 'https://example.test/dashboard/usage', 'about:blank']) {
    await assert.rejects(refreshGrokBillingItems({
      ...ACCOUNT, userDataPath: dir, homeDir: dir, session: { fromPartition: () => ({}) },
      webContents: { isDestroyed: () => false, getURL: () => url, executeJavaScript: () => assert.fail('wrong origin') }
    }), /finish signing in/);
  }
});

test('dashboard retries when authentication settles after the first page load', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-grok-ready-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  let published = 0;
  let authenticated = false;
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed === true,
        getURL: () => 'https://grok.com/dashboard/usage',
        executeJavaScript: async () => {
          requests++;
          return authenticated ? { ok: true, status: 200, payload: { data: [item('ready')] } }
            : { ok: false, status: 403, payload: null };
        }
      });
    }
    isDestroyed() { return this.destroyed === true; }
    hide() { this.hidden = true; }
    loadURL() {}
  }
  const window = openGrokDashboardWindow({
    BrowserWindow: Window, session: { fromPartition: () => ({}) }, ...ACCOUNT, userDataPath: dir,
    onRefresh: count => { published += count; }
  });
  t.after(() => { window.destroyed = true; window.emit('closed'); });
  window.webContents.emit('did-finish-load');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(fs.existsSync(billingItemsPath(dir, ACCOUNT.accountId)), false);
  authenticated = true;
  t.mock.timers.tick(3000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2, 'retry after the login document has established its authentication context');
  assert.equal(JSON.parse(fs.readFileSync(billingItemsPath(dir, ACCOUNT.accountId))).rows.length, 1);
  assert.equal(published, 1);
  assert.equal(window.hidden, true);
  t.mock.timers.tick(60000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2, 'a successful refresh cancels startup retries');
  authenticated = false;
  window.webContents.emit('did-finish-load');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 3);
  window.destroyed = true;
  window.emit('closed');
  t.mock.timers.tick(60000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 3, 'closing the dashboard cancels pending retries');
});
