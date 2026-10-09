'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ACCOUNT_COOKIE_URL,
  COOKIE_URL,
  DEFAULT_TIMEOUT_MS,
  OASIS_TOKEN,
  OASIS_WEBID,
  PARTITION,
  WINDOW_TITLE,
  disposeStepFunWindow,
  loginUrl,
  readOasisSession,
  readOasisSessions,
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

// A session whose jar answers differently per origin, which is the real
// situation: the login page's cookies live on account.stepfun.com while
// platform.stepfun.com keeps the anonymous token its own page load issued.
function sessionByUrl(byUrl, seen = []) {
  return {
    cookies: {
      get: async (filter) => {
        seen.push(filter);
        return byUrl[filter.url] || [];
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
        // Reads `this.page`, not the `page` parameter: a reused window swaps its
        // page in loadURL, and a closure over the constructor argument would
        // keep driving the first attempt's page forever.
        executeJavaScript: (script) => this.page.executeJavaScript(script),
        getURL: () => this.getURL()
      };
      this.destroyed = false;
      this.visible = options.show !== false;
      this.minimized = false;
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

    isMinimized() { return this.minimized; }

    show() { this.visible = true; }

    restore() { this.minimized = false; }

    minimize() { this.minimized = true; }

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
      // A real loadURL replaces the document, so a REUSED window has to start
      // driving a fresh page — without this seam the second attempt would keep
      // answering out of the first attempt's fake page and could never submit.
      if (this.swapPageTo) {
        this.page = this.swapPageTo;
        this.swapPageTo = null;
      }
      this.page.log.push(`load:${url}`);
      return Promise.resolve();
    }
  };
}

// Every sign-in attempt now REUSES the window the previous one left behind —
// that is the point of the fix, but it also means a test that does not say
// otherwise inherits the last test's window, and the fake page driving it. So
// the default is a clean slate and a test that wants to exercise reuse passes
// `keepRetained` and manages the lifecycle itself.
async function runSignIn({ page, cookies, options = {}, now } = {}) {
  if (options.keepRetained) {
    // Reuse is under test here, so hand the retained window this attempt's
    // page — see the loadURL seam in fakeWindowClass.
    const existing = retainedStepFunWindow(options.partition);
    if (existing) existing.swapPageTo = page;
  } else {
    disposeStepFunWindow();
  }
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
  // Both origins are read. The login page runs on account.stepfun.com and the
  // Oasis cookies land there HOST-ONLY, while platform.stepfun.com keeps only
  // the anonymous token its own page load issued — so a platform-scoped read
  // sees the pre-login state and nothing else. Asking for one URL answers half
  // the question.
  assert.deepEqual(seen, [{ url: ACCOUNT_COOKIE_URL }, { url: COOKIE_URL }]);
});

test('readOasisSessions returns one candidate per origin, each with its own pair', async () => {
  // This is the shape that made the sign-in unreliable. After a successful
  // login the jar holds a signed-in pair on account.stepfun.com AND an
  // anonymous token on platform.stepfun.com. Neither origin alone tells you
  // which is real, so both have to be offered up and let the site decide.
  const seen = [];
  const out = await readOasisSessions(sessionByUrl({
    [ACCOUNT_COOKIE_URL]: [cookie(OASIS_TOKEN, 'tok-login'), cookie(OASIS_WEBID, 'web-login')],
    [COOKIE_URL]: [cookie(OASIS_TOKEN, 'tok-anon'), cookie(OASIS_WEBID, 'web-anon')]
  }, seen), { nowMs: 1000 });

  assert.deepEqual(out.map((entry) => entry.token), ['tok-login', 'tok-anon']);
  // The device id is read in the SAME pass as its token. Sampling them in two
  // calls can catch them a rotation apart, which the endpoint rejects as a
  // mismatched pair.
  assert.deepEqual(out.map((entry) => entry.webid), ['web-login', 'web-anon']);
  assert.deepEqual(out.map((entry) => entry.source), [ACCOUNT_COOKIE_URL, COOKIE_URL]);
  assert.deepEqual(seen, [{ url: ACCOUNT_COOKIE_URL }, { url: COOKIE_URL }]);
});

test('readOasisSessions skips an expired origin and never pairs a stale token', async () => {
  const out = await readOasisSessions(sessionByUrl({
    // account holds a dead session from an earlier run; platform holds a live one.
    [ACCOUNT_COOKIE_URL]: [cookie(OASIS_TOKEN, 'stale', { expiresIn: -10, now: 1000 }),
      cookie(OASIS_WEBID, 'web-stale')],
    [COOKIE_URL]: [cookie(OASIS_TOKEN, 'fresh', { now: 1000 }), cookie(OASIS_WEBID, 'web-fresh')]
  }), { nowMs: 1000 });

  assert.deepEqual(out, [{ token: 'fresh', webid: 'web-fresh', source: COOKIE_URL }]);
});

test('readOasisSessions reports an empty jar as an empty list', async () => {
  assert.deepEqual(await readOasisSessions(fakeSession([]), { nowMs: 1000 }), []);
});

test('the pre-submit snapshot covers BOTH origins', async () => {
  // The regression this guards: the old code snapshotted one URL. On a first run
  // account.stepfun.com has no token at all, so `beforeSubmit` came back '' and
  // its guard collapsed to `Boolean(token)` — which passes on the ANONYMOUS
  // cookie that platform.stepfun.com hands out on page load. The flow then
  // accepted an unauthenticated token as a fresh sign-in.
  //
  // Here the jar holds a token on account.stepfun.com BEFORE submitting and the
  // post-submit state keeps exactly that value. A single-origin snapshot would
  // see a change on the platform origin and wrongly call it signed in.
  const page = fakePage();
  const readsByUrl = [];
  const session = {
    cookies: {
      get: async (filter) => {
        readsByUrl.push(filter.url);
        // account: an old, still-present token. platform: an anonymous one.
        if (filter.url === ACCOUNT_COOKIE_URL) {
          return page.state.submitted
            ? [cookie(OASIS_TOKEN, 'old-account'), cookie(OASIS_WEBID, 'web')]
            : [cookie(OASIS_TOKEN, 'old-account'), cookie(OASIS_WEBID, 'web')];
        }
        return [cookie(OASIS_TOKEN, 'anonymous')];
      }
    }
  };
  await assert.rejects(
    signInStepFunWithBrowser({
      username: ACCOUNT, password: PASSWORD,
      BrowserWindow: fakeWindowClass(page, []),
      session,
      timeoutMs: 4000,
      tokenReplaceDeadlineMs: 900
    }),
    // Nothing changed on either origin, so there is no session to accept.
    (error) => /did not replace the anonymous session/.test(error.message)
  );
  assert.ok(readsByUrl.includes(ACCOUNT_COOKIE_URL),
    'the account origin is part of the snapshot, not just the platform one');
});

test('verifySession, not a cookie diff, decides whether the sign-in worked', async () => {
  // A site that re-issues the SAME token value after a successful login is
  // exactly the case a string diff gets wrong in the dangerous direction: it
  // never reports "changed", so a real sign-in is reported as a failure. The
  // site's own verdict has to be what ends the wait.
  const page = fakePage();
  const judged = [];
  const { result } = await runSignIn({
    page,
    cookies: () => [cookie(OASIS_TOKEN, 'same-value-every-time'), cookie(OASIS_WEBID, 'web')],
    options: {
      verifySession: async (candidate) => {
        judged.push(candidate.token);
        return true;
      }
    }
  });
  assert.equal(result.token, 'same-value-every-time');
  assert.ok(judged.length >= 1, 'the site was actually asked');
});

test('an anonymous cookie the site refuses is not handed back as a session', async () => {
  // The other direction: with a verifier in hand the flow must not fall back to
  // "the cookie looks new" after the site has already said no.
  const page = fakePage();
  const judged = [];
  await assert.rejects(
    runSignIn({
      page,
      cookies: () => [cookie(OASIS_TOKEN, 'anonymous')],
      options: {
        timeoutMs: 9000,
        tokenReplaceDeadlineMs: 900,
        verifySession: async (candidate) => {
          judged.push(candidate.token);
          return false;
        }
      }
    }),
    (error) => /did not replace the anonymous session/.test(error.message)
  );
  assert.ok(judged.includes('anonymous'), 'the candidate was put to the site');
});

test('the site is asked about a rejected pair once, not on every poll', async () => {
  // Re-verifying the same refused value every 400ms would cost one network
  // round trip per tick for the whole settle window, on a provider whose whole
  // complaint is that it is slow.
  const page = fakePage();
  let calls = 0;
  await assert.rejects(
    runSignIn({
      page,
      cookies: () => [cookie(OASIS_TOKEN, 'anonymous')],
      options: {
        timeoutMs: 4000,
        tokenReplaceDeadlineMs: 3000,
        verifySession: async () => { calls += 1; return false; }
      }
    }),
    (error) => /did not replace the anonymous session/.test(error.message)
  );
  assert.equal(calls, 1, 'a refused value is remembered rather than re-asked about');
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
  // Matched by label only. An earlier version also tried a hardcoded
  // `#radix-\xABR3nndl9b\xBB-trigger-password` id first: React's useId generates
  // that per component instance, so it belongs to whichever tree the build
  // happened to render and silently stops matching on the next one — with a
  // label match already sitting right behind it. The mutation harness restores
  // that id and this assertion is what turns red.
  assert.doesNotMatch(tabScript, /radix-/i,
    'the Radix useId trigger must not be matched: it is generated per build, not stable across them');

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

test('retained windows are keyed by partition, so one sign-in cannot displace another', async () => {
  // The partition is a user setting, so two windows can be live at once. A
  // single module-level slot would let the second sign-in evict the first —
  // and destroying a window is exactly what takes the network stack down.
  disposeStepFunWindow();
  const first = fakePage();
  const second = fakePage();
  await runSignIn({
    page: first,
    cookies: () => (first.state.submitted ? [cookie(OASIS_TOKEN, 'tok-a')] : []),
    options: { keepRetained: true, partition: 'persist:stepfun-login' }
  });
  await runSignIn({
    page: second,
    cookies: () => (second.state.submitted ? [cookie(OASIS_TOKEN, 'tok-b')] : []),
    options: { keepRetained: true, partition: 'throwaway' }
  });

  const winA = retainedStepFunWindow('persist:stepfun-login');
  const winB = retainedStepFunWindow('throwaway');
  assert.ok(winA && winB, 'both partitions keep their own window');
  assert.notEqual(winA, winB);
  assert.equal(winA.destroyCount(), 0);
  assert.equal(winB.destroyCount(), 0);

  disposeStepFunWindow('throwaway');
  assert.equal(retainedStepFunWindow('throwaway'), null);
  assert.equal(retainedStepFunWindow('persist:stepfun-login'), winA,
    'releasing one partition must not take the other with it');
  assert.equal(winA.destroyCount(), 0);
  disposeStepFunWindow();
  assert.equal(retainedStepFunWindow('persist:stepfun-login'), null);
});

test('a failed sign-in keeps its window VISIBLE, so the user can finish by hand', async () => {
  // The failure path used to DESTROY its window. That contradicts the
  // measurement recorded in login.js: on Electron 43.4 a destroyed BrowserWindow
  // takes the network stack down with it, so every later net.fetch and loadURL
  // hangs — which is exactly how a failed sign-in turns into a permanently
  // "unavailable" quota provider with no way back.
  //
  // Keeping it visible (not merely retained) is the other half: the automation
  // gave up on a page it could not drive, and the user standing in front of the
  // browser is the only route left.
  disposeStepFunWindow();
  const page = fakePage({ passwordTab: false });
  await assert.rejects(runSignIn({ page, cookies: () => [] }));
  const win = retainedStepFunWindow();
  assert.ok(win, 'a failed attempt keeps its window too — destroying it is the network hazard');
  assert.equal(win.destroyCount(), 0, 'no code path may destroy this window');
  assert.equal(win.isVisible(), true, 'and it is left on screen for a manual sign-in');
  disposeStepFunWindow();
});

test('a second sign-in reuses the retained window instead of opening another', async () => {
  // One window per partition. Every earlier version built a new one per call,
  // so a user whose automation kept failing accumulated a stack of orphaned
  // windows — and the attempt that finally worked left all of them alive.
  disposeStepFunWindow();
  const first = fakePage();
  await runSignIn({
    page: first,
    cookies: () => (first.state.submitted ? [cookie(OASIS_TOKEN, 'tok-a')] : []),
    options: { keepRetained: true }
  });
  const kept = retainedStepFunWindow();
  assert.ok(kept);

  const second = fakePage();
  const { created } = await runSignIn({
    page: second,
    cookies: () => (second.state.submitted ? [cookie(OASIS_TOKEN, 'tok-b')] : []),
    options: { keepRetained: true }
  });

  assert.equal(created.length, 0, 'no second BrowserWindow was constructed');
  assert.equal(retainedStepFunWindow(), kept, 'the same window is still the retained one');
  assert.equal(kept.destroyCount(), 0);
  assert.ok(second.log.some((entry) => String(entry).startsWith('load:https://account.stepfun.com/login?')),
    'the retained window is re-pointed at the sign-in page for the new attempt');
  disposeStepFunWindow();
});

test('a reused window is brought back on screen before it is driven', async () => {
  // A window kept from a failed attempt may have been minimized behind
  // something else. Driving a window the user cannot see looks exactly like a
  // hang, so it is restored first.
  disposeStepFunWindow();
  const first = fakePage({ passwordTab: false });
  await assert.rejects(runSignIn({ page: first, cookies: () => [], options: { keepRetained: true } }));
  const kept = retainedStepFunWindow();
  kept.minimize();
  assert.equal(kept.isMinimized(), true);

  const second = fakePage();
  await runSignIn({
    page: second,
    cookies: () => (second.state.submitted ? [cookie(OASIS_TOKEN, 'tok-b')] : []),
    options: { keepRetained: true }
  });
  assert.equal(kept.minimized, false, 'the window is restored, not driven while minimized');
  disposeStepFunWindow();
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
  // This one calls the sign-in directly, so the shared harness does not clear
  // the retained window for it — and a leftover window from the previous test
  // would be reused here, which is the very thing under test elsewhere.
  disposeStepFunWindow();
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
  // While the page is still on the login screen the only reads are the
  // pre-submit snapshot, and it has to ask BOTH origins — that is what lets the
  // wait tell a replaced cookie from the one that was already there. One read
  // per origin, once.
  assert.equal(cookiesSeen.length, 2,
    'no cookie is read for sign-in purposes while the page is still on the login screen');
  disposeStepFunWindow();
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

test('the sign-in never returns the anonymous token, however long the site takes', async () => {
  // The whole point of the settle wait: an unreplaced anonymous cookie must
  // fail loudly rather than be handed to the quota probe, which rejects it
  // with "not a logined oasis account" and looks like bad credentials.
  //
  // The replacement deadline is injected rather than waited out — the real one
  // is 20s, and a test that had to sit through it would only be able to fail
  // on a slow machine. `timeoutMs` stays well above it so the failure this
  // asserts is the replacement deadline and not the outer one.
  const page = fakePage();
  await assert.rejects(
    runSignIn({
      page,
      cookies: () => [cookie(OASIS_TOKEN, 'anonymous')],
      options: { timeoutMs: 9000, tokenReplaceDeadlineMs: 900 }
    }),
    (error) => /did not replace the anonymous session/.test(error.message)
  );
});

test('the anonymous-token wait outlives the settle window so a slow swap still wins', async () => {
  // A regression guard on the shape of the wait: if the replacement deadline
  // were not strictly longer than the settle window, the loop would declare
  // failure before it ever got a chance to look at a second cookie.
  assert.ok(
    require('../../src/electron/providers/stepfun/login').TOKEN_REPLACE_DEADLINE_MS > 1500,
    'TOKEN_SETTLE_MS is 1500ms; the deadline must give the site room past it'
  );
});

test('a sign-in whose page never leaves the login screen is not a credential error', async () => {
  // Staying on account.stepfun.com means the submit never succeeded — a bad
  // password, a WAF challenge, anything. It must not be reported as though
  // the stored credential were accepted.
  const page = fakePage({ navigateOnSubmit: false });
  await assert.rejects(
    runSignIn({ page, cookies: () => [cookie(OASIS_TOKEN, 'anonymous')], options: { timeoutMs: 2500 } }),
    (error) => error.status === 'unavailable'
  );
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
