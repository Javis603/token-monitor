'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COOKIE_URL,
  DEFAULT_TIMEOUT_MS,
  OASIS_TOKEN,
  OASIS_WEBID,
  PARTITION,
  WINDOW_TITLE,
  disposeStepFunWindow,
  loginUrl,
  readOasisSession,
  retainedStepFunWindow,
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

// Electron's `session.cookies` is a Cookies instance, not a function — calling
// it directly is the mistake this mock is shaped to prevent.
function fakeSession(getCookies, seen = []) {
  return {
    cookies: {
      get: async (filter) => {
        seen.push(filter);
        return typeof getCookies === 'function' ? getCookies() : getCookies;
      }
    }
  };
}

const ACCOUNT = 'me@example.com';
const PASSWORD = 'hunter2';

// A stand-in for the login page. It answers the same selector probes and DOM
// writes the automation issues, and records what was typed, so a test can
// assert the flow reached the submit step rather than only that it returned.
//
// The behaviour mirrors the real page, which is what makes these tests worth
// having: the phone-code tab is the default, the password tab only appears
// after a mousedown (a bare click() is ignored by Radix), the account box is
// #login-account rather than #login-email, and the submit button carries no
// type attribute.
function fakePage(options = {}) {
  const {
    passwordTab = true,
    destroyOnSubmit = false,
    noTabs = false,
    // Whether the site lands on the redirect target after a successful submit.
    // A failed sign-in stays put, which is how the flow tells the two apart.
    navigateOnSubmit = true
  } = options;
  const log = [];
  const state = {
    destroyed: false,
    passwordVisible: false,
    submitted: false,
    consent: false,
    navigated: false,
    values: {}
  };

  async function executeJavaScript(script) {
    log.push(script);

    const probe = /^Boolean\(document\.querySelector\((".*?")\)\)$/.exec(script.trim());
    if (probe) {
      const selector = JSON.parse(probe[1]);
      if (selector === '[role="tab"]') return !noTabs;
      if (selector === 'input[type="password"]') return state.passwordVisible;
      return false;
    }

    // Filling the form.
    if (script.includes('HTMLInputElement')) {
      if (!state.passwordVisible) throw new Error('missing the password field');
      state.values.account = JSON.parse(/set\(accountEl,\s*("(?:[^"\\]|\\.)*")\)/.exec(script)[1]);
      state.values.password = JSON.parse(/set\(passwordEl,\s*("(?:[^"\\]|\\.)*")\)/.exec(script)[1]);
      return true;
    }

    // Reading the values back: the automation only submits once the
    // controlled inputs actually hold what it wrote.
    if (script.includes('.value ===')) {
      const wantAccount = JSON.parse(/acc\.value === ("(?:[^"\\]|\\.)*")/.exec(script)[1]);
      const wantPassword = JSON.parse(/pw\.value === ("(?:[^"\\]|\\.)*")/.exec(script)[1]);
      return state.values.account === wantAccount && state.values.password === wantPassword;
    }

    // Reading consent back.
    if (script.includes("aria-checked') === 'true'")) return state.consent;

    // Ticking consent — a plain click, unlike the tab.
    if (script.includes('role="checkbox"') && !script.includes('querySelectorAll')) {
      if (!state.consent) state.consent = true;
      return true;
    }

    // Switching tabs — only a mousedown does it, exactly like Radix. Checked
    // before the submit branch because this script also uses querySelectorAll.
    if (script.includes('role="tab"')) {
      if (!passwordTab) return false;
      state.passwordVisible = script.includes('mousedown');
      return true;
    }

    // Submitting.
    if (script.includes('querySelectorAll')) {
      state.submitted = true;
      state.navigated = navigateOnSubmit;
      if (destroyOnSubmit) state.destroyed = true;
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
      this.webContents = {
        executeJavaScript: (script) => page.executeJavaScript(script),
        getURL: () => this.getURL()
      };
      this.destroyed = false;
      this.visible = options.show !== false;
      this.url = 'https://account.stepfun.com/login';
      created.push(options);
    }

    // The site issues an anonymous token for platform.stepfun.com before any
    // sign-in, so the flow only accepts a cookie once the page has actually
    // left the login screen.
    getURL() {
      if (this.page.state.destroyed) return '';
      return this.page.state.navigated ? 'https://platform.stepfun.com/step-plan' : this.url;
    }

    isDestroyed() { return this.page.state.destroyed || this.destroyed; }

    isVisible() { return this.visible; }

    show() { this.visible = true; }

    hide() { this.visible = false; }

    once(event, handler) { this.handlers = this.handlers || {}; (this.handlers[event] ||= []).push(handler); }

    off() {}

    destroy() {
      this.destroyCount_ = (this.destroyCount_ || 0) + 1;
      this.destroyed = true;
      this.page.state.destroyed = true;
      (this.handlers?.closed || []).forEach((h) => h());
    }

    destroyCount() { return this.destroyCount_ || 0; }

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
    username: ACCOUNT,
    password: PASSWORD,
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
  // apart, which the quota endpoint rejects as a mismatched pair. And the
  // filter is the URL Chromium would send to, not a bare domain.
  assert.deepEqual(seen, [{ url: COOKIE_URL }]);
});

test('readOasisSession is not fooled by a session whose cookies is not callable', async () => {
  // Regression guard: `session.cookies` is a Cookies instance. Calling it
  // throws a TypeError that the sign-in reports as "unavailable", which is
  // exactly the state a silently broken sign-in looks like from the UI.
  const notAFunction = { cookies: { get: async () => [cookie(OASIS_TOKEN, 'tok')] } };
  assert.equal(typeof notAFunction.cookies, 'object');
  assert.deepEqual(await readOasisSession(notAFunction), { token: 'tok', webid: '' });
  await assert.rejects(readOasisSession({ cookies: async () => [] }), TypeError);
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
  assert.equal(page.state.values.account, 'me@example.com');
  assert.equal(page.state.values.password, 'hunter2');
  assert.ok(page.state.submitted, 'the form is actually submitted, not just filled');
  assert.ok(page.log.some((entry) => String(entry).startsWith('load:https://account.stepfun.com/login?')));
  // One read to snapshot the pre-submit cookie, then the post-navigation polls.
  assert.ok(cookieReads.length >= 2, 'it snapshots before submitting and reads again after');

  assert.equal(created.length, 1);
  assert.equal(created[0].title, WINDOW_TITLE);
  assert.ok(created[0].show, 'the window is visible: an escalated WAF challenge needs a human');
});

test('the tab is switched with a mousedown but consent with a plain click', async () => {
  // Both verified against the live page: Radix Tabs changes value on mousedown
  // (a bare click() leaves the phone-code form on screen), while the consent
  // button toggles off again if given the same pointer sequence.
  const page = fakePage();
  await runSignIn({ page, cookies: () => (page.state.submitted ? [cookie(OASIS_TOKEN, 'tok')] : []) });

  const tabScript = page.log.find((entry) => entry.includes('role="tab"'));
  assert.ok(tabScript, 'the password tab is clicked');
  assert.match(tabScript, /mousedown/, 'Radix switches the tab on mousedown, not on click');

  const consentScript = page.log.find((entry) =>
    entry.includes('role="checkbox"') && !entry.includes('querySelectorAll'));
  assert.ok(consentScript, 'consent is ticked');
  assert.ok(!consentScript.includes('mousedown'),
    'the consent control wants a plain click — the pointer sequence cancels it back out');
});

test('a successful sign-in keeps its window, because destroying it breaks the network', async () => {
  // Measured on Electron 43.4: after a BrowserWindow on a persistent
  // partition is destroyed, every later net.fetch and loadURL hangs. The
  // quota probe that follows a sign-in would then time out and report the
  // provider unavailable, so the window is hidden and kept instead.
  disposeStepFunWindow();
  const page = fakePage();
  const { created } = await runSignIn({
    page,
    cookies: () => (page.state.submitted ? [cookie(OASIS_TOKEN, 'tok')] : [])
  });

  const win = retainedStepFunWindow();
  assert.ok(win, 'the sign-in window is retained for the quota read to reuse');
  assert.equal(win.options, created[0], 'it is the window that signed in, not a second one');
  assert.equal(win.destroyCount(), 0, 'a successful sign-in must not destroy its window');
  disposeStepFunWindow();
  assert.equal(retainedStepFunWindow(), null, 'dispose clears it');
});

test('a failed sign-in destroys its window', async () => {
  disposeStepFunWindow();
  const page = fakePage({ passwordTab: false });
  await assert.rejects(runSignIn({ page, cookies: () => [] }));
  assert.equal(retainedStepFunWindow(), null, 'a failed attempt has nothing worth keeping');
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

test('the sign-in waits for the page to leave the login screen before trusting a token', async () => {
  // platform.stepfun.com is issued an ANONYMOUS Oasis-Token when the page
  // loads. Returning that one makes the quota call fail with "not a logined
  // oasis account" — a credential that looks freshly minted and is not.
  const cookiesSeen = [];
  const session = {
    cookies: {
      get: async () => {
        cookiesSeen.push(Date.now());
        // The anonymous cookie exists from the start; the signed-in one only
        // after the page leaves the login screen.
        return [{ name: OASIS_TOKEN, value: 'anonymous-token', expires: 0 }];
      }
    }
  };
  const page = fakePage({ navigateOnSubmit: false });
  const created = [];
  // Long enough that the flow actually reaches the polling loop — a short
  // budget expires during form filling and never reads a cookie at all, which
  // would make this assertion pass for the wrong reason. The elapsed time is
  // asserted so that shortcut cannot happen silently.
  const startedAt = Date.now();
  await assert.rejects(
    signInStepFunWithBrowser({
      username: ACCOUNT, password: PASSWORD,
      BrowserWindow: fakeWindowClass(page, created),
      session, timeoutMs: 6000
    }),
    (error) => /did not complete before the timeout/.test(error.message)
  );
  assert.ok(Date.now() - startedAt >= 5000, 'the polling loop really did run to its deadline');
  // Exactly one read is allowed while the page is still on the login screen:
  // the pre-submit snapshot that lets the wait tell a replaced cookie from the
  // anonymous one it started with.
  assert.equal(cookiesSeen.length, 1,
    'no cookie is read for sign-in purposes while the page is still on the login screen');
});

test('a sign-in that never navigates fails instead of returning an anonymous token', async () => {
  const page = fakePage({ navigateOnSubmit: false });
  await assert.rejects(
    runSignIn({
      page,
      // The anonymous cookie is present from the moment the page loads.
      cookies: () => [cookie(OASIS_TOKEN, 'anonymous')],
      options: { timeoutMs: 6000 }
    }),
    (error) => /did not complete before the timeout/.test(error.message)
  );
});

test('a completed sign-in returns the token from after the navigation', async () => {
  const page = fakePage();
  const { result } = await runSignIn({
    page,
    // The anonymous cookie is present from page load; the signed-in one only
    // once the redirect target has been reached.
    cookies: () => (page.state.navigated ? [cookie(OASIS_TOKEN, 'signed-in')] : [cookie(OASIS_TOKEN, 'anonymous')])
  });
  assert.equal(result.token, 'signed-in',
    'returning the cookie that existed before submitting is the whole bug this guards');
});

test('the sign-in waits for the anonymous cookie to be replaced', async () => {
  // Observed live: right after the redirect the jar still holds the anonymous
  // token (657 chars, rejected as "not a logined oasis account"), and the
  // signed-in one (656 chars) only lands a second or two later.
  const page = fakePage();
  let reads = 0;
  const { result } = await runSignIn({
    page,
    cookies: () => {
      reads += 1;
      // Two more reads land the anonymous value, mimicking the swap delay.
      return reads <= 2 ? [cookie(OASIS_TOKEN, 'anonymous')] : [cookie(OASIS_TOKEN, 'signed-in')];
    }
  });
  assert.equal(result.token, 'signed-in');
  assert.ok(reads >= 3, 'it kept polling instead of taking the first cookie it saw');
});

test('signInStepFunWithBrowser times out instead of polling forever', async () => {
  const page = fakePage();
  await assert.rejects(
    runSignIn({ page, cookies: () => [], options: { timeoutMs: 300 } }),
    (error) => error.status === 'unavailable' && /did not complete before the timeout/.test(error.message)
  );
});

test('signInStepFunWithBrowser times out when the form never renders', async () => {
  const page = fakePage({ noTabs: true });
  await assert.rejects(
    runSignIn({ page, cookies: () => [], options: { timeoutMs: 300 } }),
    (error) => /timed out waiting for \[role="tab"\]/.test(error.message)
  );
});

test('the sign-in waits for the tab strip, not for a password field', async () => {
  // Regression guard: the page opens on the phone-code tab, where no password
  // input exists. Waiting for that field first hung until the timeout, so the
  // wait has to be for the tab strip that is actually there.
  const page = fakePage();
  const probeOrder = [];
  const realExecute = page.executeJavaScript;
  page.executeJavaScript = async (script) => {
    const probe = /^Boolean\(document\.querySelector\((".*?")\)\)$/.exec(script.trim());
    if (probe) probeOrder.push(JSON.parse(probe[1]));
    return realExecute(script);
  };
  await runSignIn({ page, cookies: () => (page.state.submitted ? [cookie(OASIS_TOKEN, 'tok')] : []) });
  assert.deepEqual(probeOrder.slice(0, 2), ['[role="tab"]', 'input[type="password"]']);
  assert.ok(!probeOrder.includes('#login-email'), 'the email-code tab id never appears in this flow');
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
