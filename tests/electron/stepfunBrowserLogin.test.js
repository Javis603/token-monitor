'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COOKIE_DOMAIN,
  DEFAULT_TIMEOUT_MS,
  OASIS_TOKEN,
  OASIS_WEBID,
  PARTITION,
  WINDOW_TITLE,
  loginUrl,
  readOasisSession,
  signInStepFunWithBrowser,
  tokenExpiryMs
} = require('../../src/electron/providers/stepfun/login');

// The password login cannot be reproduced over HTTP — the endpoint sits behind
// a WAF that only clears inside page JavaScript — so the sign-in runs in a
// real BrowserWindow and the Oasis cookies are read back out of its session.
// These tests drive that with a fake window: they pin the contract the shared
// probe depends on (a token and its device id, read together), and the
// isolation the window has to keep.

const HOUR = 3600;

// Expiry is compared against a real clock inside readOasisSession, so cookies
// are minted from `Date.now()` unless a test pins an explicit `now`.
function cookie(name, value, { expiresIn = HOUR, now = Date.now() } = {}) {
  return { name, value, expires: (now + expiresIn) / 1000 };
}

function fakeSession(getCookies, seen = []) {
  return {
    cookies: async (options) => {
      seen.push(options);
      return typeof getCookies === 'function' ? getCookies() : getCookies;
    }
  };
}

// A stand-in for the login page. It answers the same selector probes and DOM
// writes the automation issues, and records what was typed, so a test can
// assert the flow reached the submit step rather than only that it returned.
function fakePage(options = {}) {
  const { passwordTab = true, destroyOnSubmit = false, noEmailField = false } = options;
  const log = [];
  const state = { destroyed: false, passwordVisible: false, submitted: false, values: {} };

  async function executeJavaScript(script) {
    log.push(script);

    const probe = /^Boolean\(document\.querySelector\((".*?")\)\)$/.exec(script.trim());
    if (probe) {
      const selector = JSON.parse(probe[1]);
      if (selector === '#login-email') return !noEmailField;
      if (selector === '#login-password') return state.passwordVisible;
      return false;
    }

    if (script.includes('HTMLInputElement')) {
      for (const id of ['login-email', 'login-password']) {
        const match = new RegExp(`set\\('#${id}',\\s*("(?:[^"\\\\]|\\\\.)*")\\)`).exec(script);
        if (match) state.values[id] = JSON.parse(match[1]);
      }
      return true;
    }

    if (script.includes('role="checkbox"')) {
      state.submitted = true;
      if (destroyOnSubmit) state.destroyed = true;
      return true;
    }

    if (script.includes('role="tab"')) {
      if (!passwordTab) return false;
      state.passwordVisible = true;
      return true;
    }

    return false;
  }

  return { log, state, executeJavaScript };
}

function fakeWindowClass(page, created = []) {
  return class {
    constructor(options) {
      this.options = options;
      this.page = page;
      this.webContents = { executeJavaScript: (script) => page.executeJavaScript(script) };
      created.push(options);
    }

    isDestroyed() { return this.page.state.destroyed; }

    destroy() { this.page.state.destroyed = true; }

    loadURL(url) {
      this.page.log.push(`load:${url}`);
      return Promise.resolve();
    }
  };
}

async function runSignIn({ page, cookies, options = {}, now } = {}) {
  const created = [];
  const cookieReads = [];
  const result = await signInStepFunWithBrowser({
    username: 'me@example.com',
    password: 'hunter2',
    BrowserWindow: fakeWindowClass(page, created),
    session: fakeSession(cookies, cookieReads),
    timeoutMs: 4000,
    ...options
  });
  return { result, created, cookieReads };
}

test('loginUrl carries the quota page as the post-login redirect', () => {
  const url = new URL(loginUrl());
  assert.equal(url.origin + url.pathname, 'https://account.stepfun.com/login');
  assert.equal(url.searchParams.get('redirect'), 'https://platform.stepfun.com/step-plan');
  assert.equal(url.searchParams.get('source_app'), 'platform-cn');
  assert.equal(
    new URL(loginUrl({ redirect: 'https://platform.stepfun.com/step-plan' })).searchParams.get('redirect'),
    'https://platform.stepfun.com/step-plan'
  );
});

test('tokenExpiryMs distinguishes a session cookie from a live one', () => {
  assert.equal(tokenExpiryMs([{ name: OASIS_TOKEN, expires: 0 }], 1000), null,
    'Chromium reports a session cookie as expires 0, which announces no lifetime');
  assert.equal(tokenExpiryMs([{ name: OASIS_TOKEN, expires: -1 }], 1000), null);
  assert.equal(tokenExpiryMs([{ name: OASIS_TOKEN }], 1000), null, 'an absent expiry is not a lifetime');
  assert.equal(tokenExpiryMs([{ name: 'other', expires: 90 }], 1000), null);
  assert.equal(tokenExpiryMs([{ name: OASIS_TOKEN, expires: 90.5 }], 1000), 90_500);
});

test('readOasisSession reads the token and its device id together', async () => {
  const seen = [];
  const out = await readOasisSession(fakeSession([
    cookie('INGRESSCOOKIE', 'ing', { now: 1000 }),
    cookie(OASIS_TOKEN, 'tok-1', { now: 1000 }),
    cookie(OASIS_WEBID, 'web-1', { now: 1000 })
  ], seen), { nowMs: 1000 });

  assert.deepEqual(out, { token: 'tok-1', webid: 'web-1' });
  // One pass for both: sampling them separately can catch them a rotation
  // apart, which the quota endpoint rejects as a mismatched pair.
  assert.deepEqual(seen, [{ domain: COOKIE_DOMAIN }]);
});

test('readOasisSession reports a missing token as empty rather than throwing', async () => {
  assert.deepEqual(await readOasisSession(fakeSession([]), { nowMs: 1000 }), { token: '', webid: '' });
  assert.deepEqual(
    await readOasisSession(fakeSession([cookie(OASIS_TOKEN, '   ', { now: 1000 })]), { nowMs: 1000 }),
    { token: '', webid: '' }
  );
  // An expired cookie is still listed by cookies(); treating it as a credential
  // would send the next quota probe into a guaranteed 401 while reporting the
  // credential as freshly minted.
  assert.deepEqual(
    await readOasisSession(
      fakeSession([cookie(OASIS_TOKEN, 'stale', { expiresIn: -10, now: 1000 })]),
      { nowMs: 1000 }
    ),
    { token: '', webid: '' }
  );
  // A session cookie (expires 0) has no announced lifetime, so it is kept and
  // let through to a probe that can judge it.
  assert.deepEqual(
    await readOasisSession(fakeSession([{ name: OASIS_TOKEN, value: 'live', expires: 0 }]), { nowMs: 1000 }),
    { token: 'live', webid: '' }
  );
});

test('signInStepFunWithBrowser fills the password form and returns the session cookies', async () => {
  const page = fakePage();
  const { result, created, cookieReads } = await runSignIn({
    page,
    cookies: () => (page.state.submitted
      ? [cookie(OASIS_TOKEN, 'tok-live'), cookie(OASIS_WEBID, 'web-live')]
      : [])
  });

  assert.deepEqual(result, { token: 'tok-live', webid: 'web-live' });
  assert.equal(page.state.values['login-email'], 'me@example.com');
  assert.equal(page.state.values['login-password'], 'hunter2');
  assert.ok(page.state.submitted, 'the form is actually submitted, not just filled');
  assert.ok(page.log.some((entry) => String(entry).startsWith('load:https://account.stepfun.com/login?')));
  assert.equal(cookieReads.length, 1, 'it polls the session and stops as soon as the token lands');

  assert.equal(created.length, 1);
  assert.equal(created[0].title, WINDOW_TITLE);
  assert.ok(created[0].show, 'the window is visible: an escalated WAF challenge needs a human');
});

test('the sign-in window is isolated from the widget session', async () => {
  const page = fakePage();
  const { created } = await runSignIn({
    page,
    cookies: () => (page.state.submitted ? [cookie(OASIS_TOKEN, 'tok')] : [])
  });

  const prefs = created[0].webPreferences;
  // Remote third-party page: no preload, no Node, its own throwaway session so
  // it cannot read or overwrite the widget's own cookies.
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.partition, PARTITION);
});

test('signInStepFunWithBrowser fails when the password tab is absent', async () => {
  const page = fakePage({ passwordTab: false });
  await assert.rejects(
    runSignIn({ page, cookies: () => [] }),
    (error) => /password sign-in tab/i.test(error.message) && error.status === 'unavailable'
  );
  assert.equal(page.state.submitted, false);
});

test('signInStepFunWithBrowser reports a closed window as cancelled, not as bad credentials', async () => {
  const page = fakePage({ destroyOnSubmit: true });
  await assert.rejects(
    runSignIn({ page, cookies: () => [] }),
    (error) => error.status === 'cancelled',
    'the user dismissing the window must not read as a wrong password'
  );
});

test('signInStepFunWithBrowser times out instead of polling forever', async () => {
  const page = fakePage();
  await assert.rejects(
    runSignIn({ page, cookies: () => [], options: { timeoutMs: 300 } }),
    (error) => error.status === 'unavailable' && /did not produce a token/.test(error.message)
  );
});

test('signInStepFunWithBrowser times out when the form never renders', async () => {
  const page = fakePage({ noEmailField: true });
  await assert.rejects(
    runSignIn({ page, cookies: () => [], options: { timeoutMs: 300 } }),
    (error) => /timed out waiting for #login-email/.test(error.message)
  );
});

test('signInStepFunWithBrowser refuses incomplete credentials before opening a window', async () => {
  const created = [];
  for (const options of [{ username: 'me' }, { password: 'pw' }, { username: '  ', password: 'pw' }]) {
    await assert.rejects(
      signInStepFunWithBrowser({
        ...options,
        BrowserWindow: fakeWindowClass(fakePage(), created),
        session: fakeSession([])
      }),
      (error) => error.status === 'unauthorized'
    );
  }
  assert.equal(created.length, 0, 'no window is opened for a credential pair that cannot sign in');
});

test('signInStepFunWithBrowser requires a browser and a session', async () => {
  await assert.rejects(
    signInStepFunWithBrowser({ username: 'u', password: 'p' }),
    /BrowserWindow is required/
  );
  await assert.rejects(
    signInStepFunWithBrowser({ username: 'u', password: 'p', BrowserWindow: fakeWindowClass(fakePage()) }),
    /Electron session is required/
  );
});

test('the default budget outlives a wrapped probe deadline', () => {
  // limits.js wraps this call in its own deadline; if the window's budget
  // outlived it, a stuck sign-in would be reported as an opaque probe timeout
  // instead of the sign-in failure it is.
  assert.ok(DEFAULT_TIMEOUT_MS >= 60_000);
});