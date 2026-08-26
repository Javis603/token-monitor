'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { referencedTerminationOptions } = require('../helpers/referencedTerminationTimers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CURSOR_EXPLICIT_SYNC_TIMEOUT_MS,
  canonicalCursorUserId,
  listAccounts,
  normalizeCursorSessionToken,
  readActiveAccount,
  runCursorLogin,
  runCursorLogout,
  runCursorSync
} = require('../../src/shared/cursorAuth');

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for Cursor subprocess state');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function withTempHome(payload) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorauth-'));
  const credPath = path.join(tmp, '.config', 'tokscale', 'cursor-credentials.json');
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  if (payload !== undefined) fs.writeFileSync(credPath, JSON.stringify(payload));
  return { home: tmp, credPath, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('readActiveAccount returns null when file is missing', () => {
  const { home, cleanup } = withTempHome(undefined);
  try {
    assert.equal(readActiveAccount({ home }), null);
  } finally { cleanup(); }
});

test('readActiveAccount returns active account when present', () => {
  const payload = {
    version: 1,
    activeAccountId: 'a1',
    accounts: {
      a1: { sessionToken: 'tok-a1', userId: 'u1', createdAt: '2026-05-26T00:00:00Z', label: 'work' },
      a2: { sessionToken: 'tok-a2', userId: 'u2', createdAt: '2026-05-25T00:00:00Z' }
    }
  };
  const { home, cleanup } = withTempHome(payload);
  try {
    const acct = readActiveAccount({ home });
    assert.equal(acct.id, 'a1');
    assert.equal(acct.sessionToken, 'tok-a1');
    assert.equal(acct.userId, 'u1');
    assert.equal(acct.label, 'work');
  } finally { cleanup(); }
});

test('listAccounts returns every account with the Tokscale active account first', () => {
  const payload = {
    version: 1,
    activeAccountId: 'desktop',
    accounts: {
      desktop: { sessionToken: 'tok-desktop', userId: 'desktop' },
      pinned: { sessionToken: 'tok-pinned', userId: 'pinned', label: 'work' }
    }
  };
  const { home, credPath, cleanup } = withTempHome(payload);
  try {
    assert.equal(JSON.parse(fs.readFileSync(credPath, 'utf8')).activeAccountId, 'desktop');
    assert.deepEqual(listAccounts({ home }).map((account) => account.id), ['desktop', 'pinned']);
  } finally { cleanup(); }
});

test('readActiveAccount returns null when activeAccountId is missing from accounts map', () => {
  const payload = { version: 1, activeAccountId: 'ghost', accounts: { a1: { sessionToken: 't' } } };
  const { home, cleanup } = withTempHome(payload);
  try {
    assert.equal(readActiveAccount({ home }), null);
  } finally { cleanup(); }
});

test('readActiveAccount returns null on malformed JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorauth-'));
  const credPath = path.join(tmp, '.config', 'tokscale', 'cursor-credentials.json');
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(credPath, '{not json');
  try {
    assert.equal(readActiveAccount({ home: tmp }), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('readActiveAccount returns null on empty accounts map', () => {
  const { home, cleanup } = withTempHome({ version: 1, activeAccountId: '', accounts: {} });
  try {
    assert.equal(readActiveAccount({ home }), null);
  } finally { cleanup(); }
});

test('runCursorLogin writes credentials file with extracted user id from "::" delimiter', async () => {
  const { home, cleanup } = withTempHome(undefined);
  try {
    await runCursorLogin('user_01HXYZ::tok-value-here', { home });
    const acct = readActiveAccount({ home });
    assert.equal(acct.id, 'user_01HXYZ');
    assert.equal(acct.sessionToken, 'user_01HXYZ%3A%3Atok-value-here');
    assert.equal(acct.userId, 'user_01HXYZ');
  } finally { cleanup(); }
});

test('runCursorLogin derives anon-* account id when no delimiter', async () => {
  const { home, cleanup } = withTempHome(undefined);
  try {
    await runCursorLogin('plain-token-no-delimiter', { home });
    const acct = readActiveAccount({ home });
    assert.match(acct.id, /^anon-[0-9a-f]{12}$/);
    assert.equal(acct.userId, null);
  } finally { cleanup(); }
});

test('runCursorLogin handles URL-encoded :: delimiter (%3A%3A)', async () => {
  const { home, cleanup } = withTempHome(undefined);
  try {
    await runCursorLogin('user_01ABC%3A%3Aopaque-token', { home });
    const acct = readActiveAccount({ home });
    assert.equal(acct.id, 'user_01ABC');
    assert.equal(acct.userId, 'user_01ABC');
  } finally { cleanup(); }
});

test('normalizeCursorSessionToken accepts a full cookie header and canonicalizes separators', () => {
  assert.equal(
    normalizeCursorSessionToken('Cookie: other=x; WorkosCursorSessionToken=user_01ABC::opaque; next=y'),
    'user_01ABC%3A%3Aopaque'
  );
});

test('normalizeCursorSessionToken converts a local Cursor access-token JWT', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'auth0|user_01LOCAL' })).toString('base64url');
  const jwt = `header.${payload}.signature`;
  assert.equal(normalizeCursorSessionToken(jwt), `user_01LOCAL%3A%3A${jwt}`);
});

test('canonicalCursorUserId normalizes Cursor API and stored identities', () => {
  assert.equal(canonicalCursorUserId('auth0|user_01ABC'), 'user_01ABC');
  assert.equal(canonicalCursorUserId('user_01ABC'), 'user_01ABC');
  assert.equal(canonicalCursorUserId('auth0|other'), '');
});

test('runCursorLogout delegates account and cache reconciliation to Tokscale', async () => {
  const calls = [];
  await runCursorLogout({
    accountId: 'user_a',
    timeoutMs: 1234,
    runSubcommand: async (args, options) => { calls.push({ args, timeoutMs: options.timeoutMs }); }
  });
  assert.deepEqual(calls, [{ args: ['logout', '--name', 'user_a'], timeoutMs: 1234 }]);
});

test('Cursor sync, logout, and login share one lifecycle lane', async () => {
  const { home, cleanup } = withTempHome(undefined);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.kill = () => true;
  const events = [];
  let releaseLogout;
  const logoutGate = new Promise((resolve) => { releaseLogout = resolve; });

  try {
    const sync = runCursorSync({
      spawn: () => {
        events.push('sync');
        return child;
      },
      tokscaleCommand: () => ({ bin: 'tokscale', prefixArgs: [], env: {} }),
      timeoutMs: 60_000
    });
    await waitFor(() => events.includes('sync'));

    const logout = runCursorLogout({
      accountId: 'user_b',
      runSubcommand: async () => {
        events.push('logout');
        await logoutGate;
      }
    });
    const login = runCursorLogin('user_a::token-a', { home });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['sync']);
    assert.equal(readActiveAccount({ home }), null, 'login waits behind the active sync');

    child.emit('close', 0);
    await waitFor(() => events.includes('logout'));
    assert.equal(readActiveAccount({ home }), null, 'login waits behind the active logout');

    releaseLogout();
    await Promise.all([sync, logout, login]);
    assert.deepEqual(events, ['sync', 'logout']);
    assert.equal(readActiveAccount({ home }).id, 'user_a');
  } finally {
    releaseLogout?.();
    cleanup();
  }
});

test('Cursor lifecycle lane continues after an operation fails', async () => {
  const { home, cleanup } = withTempHome(undefined);
  try {
    await assert.rejects(
      runCursorLogout({ runSubcommand: async () => { throw new Error('logout failed'); } }),
      /logout failed/
    );
    await runCursorLogin('user_after_failure::token', { home });
    assert.equal(readActiveAccount({ home }).id, 'user_after_failure');
  } finally { cleanup(); }
});

test('runCursorLogin throws on empty token', async () => {
  const { home, cleanup } = withTempHome(undefined);
  try {
    await assert.rejects(() => runCursorLogin('', { home }), /token/i);
  } finally { cleanup(); }
});

test('runCursorSync leaves headroom around Tokscale explicit sync timeout', () => {
  assert.equal(CURSOR_EXPLICIT_SYNC_TIMEOUT_MS, 150_000);
});

test('runCursorSync rejects when the tokscale stdin pipe breaks', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  let killed = false;
  child.kill = () => { killed = true; };
  const pending = runCursorSync({
    spawn: () => child,
    tokscaleCommand: () => ({ bin: 'tokscale', prefixArgs: [], env: {} }),
    timeoutMs: 60_000
  });
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

  child.stdin.emit('error', error);
  let settled = false;
  pending.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'stdin failure waits for physical process close');
  child.emit('close', 1);

  await assert.rejects(pending, (caught) => {
    assert.match(caught.message, /write EPIPE/);
    assert.equal(caught.syncFailureStage, 'process-exit');
    return true;
  });
  assert.equal(killed, true);
});

test('runCursorSync timeout requests termination and waits for child close', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  const signals = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  const pending = runCursorSync({
    spawn: () => child,
    tokscaleCommand: () => ({ bin: 'tokscale', prefixArgs: [], env: {} }),
    timeoutMs: 1
  });
  let settled = false;
  pending.catch(() => { settled = true; });

  await waitFor(() => signals.includes('SIGTERM'));
  assert.equal(settled, false, 'timeout delivery is not physical process exit');
  child.emit('close', null, 'SIGTERM');

  await assert.rejects(pending, (caught) => {
    assert.match(caught.message, /timed out after 1ms/);
    assert.equal(caught.syncFailureStage, 'timeout');
    return true;
  });
});

test('runCursorSync stops waiting when forced termination never reports close', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  const signals = [];
  const diagnostics = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  const pending = runCursorSync({
    spawn: () => child,
    tokscaleCommand: () => ({ bin: 'tokscale', prefixArgs: [], env: {} }),
    timeoutMs: 1,
    terminationOptions: referencedTerminationOptions({ graceMs: 1, closeGraceMs: 1 }),
    onTerminationUnconfirmed: (error) => diagnostics.push(error.code)
  });

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'termination-unconfirmed');
    assert.match(error.cause?.message || '', /timed out after 1ms/);
    assert.equal(error.syncFailureStage, 'timeout');
    return true;
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(diagnostics, ['termination-unconfirmed']);

  child.emit('close', null, 'SIGKILL');
});

test('runCursorSync kills the child and keeps the abort error when superseded', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  let killed = 0;
  child.kill = () => { killed += 1; };
  const controller = new AbortController();
  const reason = new Error('collector stopped');
  const pending = runCursorSync({
    signal: controller.signal,
    spawn: () => child,
    tokscaleCommand: () => ({ bin: 'tokscale', prefixArgs: [], env: {} }),
    timeoutMs: 60_000
  });
  let settled = false;
  pending.catch(() => { settled = true; });

  controller.abort(reason);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'SIGTERM delivery is not physical process exit');
  child.emit('close', 143);

  await assert.rejects(pending, (caught) => caught === reason);
  assert.equal(killed, 1);
});
