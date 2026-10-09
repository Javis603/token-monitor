'use strict';

const { hashKey } = require('../../../shared/hashKey');

// StepFun sign-in driven by a real browser window.
//
// The OAuth flow cannot be reproduced over plain HTTP. Two findings from
// reading the site's own bundle (`app/(auth)/login/page-*.js`) and probing the
// live endpoints:
//
//   1. The password login is `SignInByPassword({ username, password })` — a
//      PLAINTEXT password, unlike the email-code path which sends an encrypted
//      `auth_code`. So nothing has to be reverse-engineered.
//   2. But that method hangs off `GlobalPassportService`, and the whole
//      service answers 403 with an empty body to anything that is not a
//      browser — `Ping`, a known-good endpoint, fails identically. The
//      `_wafdytokenv1` cookie in the ingress jar is a Volcengine WAF token that
//      only clears once page JavaScript has run. `PassportService` (the device
//      registration and OAuth-refresh endpoints) answers fine; only
//      `GlobalPassportService` is gated.
//
// So the login runs where the WAF challenge can actually execute: an Electron
// BrowserWindow loads the real login page, the site's own JavaScript performs
// the exchange, and the resulting `Oasis-Token` is read back with
// `session.cookies.get()` — which resolves inside the browser process, so the
// app-bound cookie encryption that stops every external reader does not apply.
//
// Token Monitor is already an Electron app, so this costs no new dependency.
//
// What the returned token is worth depends on reading it at the right moment;
// see the note above `beforeSubmit` before touching the polling loop.

const LOGIN_URL = 'https://account.stepfun.com/login';
// Two origins, one session. The quota endpoints are served from
// platform.stepfun.com, so filtering the jar by that URL answers exactly "what
// would Chromium send to the quota page". But the LOGIN page runs on
// account.stepfun.com, and there the Oasis cookies land HOST-ONLY: measured
// against the live page, `Oasis-Token@account.stepfun.com` and
// `Oasis-Webid@account.stepfun.com` exist while platform.stepfun.com still
// carries only the anonymous token its own page load issued. A platform-scoped
// read therefore sees the pre-login state and nothing else — which is what made
// `beforeSubmit` always come back empty (so its guard degraded into a
// meaningless `Boolean(token)`), and what made a successful login look like a
// token that never changed.
const COOKIE_URL = 'https://platform.stepfun.com/';
const ACCOUNT_COOKIE_URL = 'https://account.stepfun.com/';
// account first: the pair a login mints lives there. Both are still read,
// because which origin holds the live one depends on where the page ended up
// after the redirect, and `verifySession` is what decides rather than the order.
const SESSION_COOKIE_URLS = [ACCOUNT_COOKIE_URL, COOKIE_URL];
const OASIS_TOKEN = 'Oasis-Token';
const OASIS_WEBID = 'Oasis-Webid';
const WINDOW_TITLE = '正在登录 StepFun…';
// Long enough to clear an escalated WAF challenge: the window is visible, so
// the user can finish a challenge that needs a click. limits.js wraps this in
// a slightly longer deadline and reports the failure as a sign-in failure.
const DEFAULT_TIMEOUT_MS = 110_000;
// How long after the redirect the site needs before the signed-in cookie is
// readable. Measured against the live account; see the note where it is used.
const TOKEN_SETTLE_MS = 1_500;
// How long to keep waiting for a session the SITE accepts before declaring
// the sign-in failed. Deliberately far longer than the settle window: the swap
// has been seen to take a few seconds, and giving up early would surface as a
// bad credential when the real cause is a slow site. Injectable so a test can
// exercise the deadline without spending the real one in wall-clock time.
//
// This counts from the redirect, and it is the ONLY deadline the polling loop
// enforces on itself: with `verifySession` in hand, "the cookie looks new" is
// no longer evidence, so a slow-but-correct site gets waited out instead of
// being failed on a heuristic.
const TOKEN_REPLACE_DEADLINE_MS = 20_000;
// How long a single `executeJavaScript` may hang before it is treated as a
// miss. Without it a renderer that stops answering (a page navigating away
// mid-call, a renderer that crashed) parks the sign-in forever: the outer
// deadline is only checked between polls, and the poll itself never returns.
const PAGE_SCRIPT_TIMEOUT_MS = 15_000;
// Exported so the caller can hand `session.fromPartition(partition)` to this
// module. A window and the session that reads it must share one partition, and
// a typo'd literal in two files is how a sign-in silently returns no token.
const PARTITION_BASE = 'stepfun-login';

/**
 * The session partition the sign-in window and the cookie reader share.
 *
 * `persist:` is what makes the sign-in survive an app restart: without it
 * Chromium keeps the partition in memory only, so every launch started from an
 * empty jar and popped the login window again. With it the Oasis cookies land
 * in the user-data Cookies file, encrypted with the OS key store the same way
 * Chromium encrypts any persisted cookie — readable by this user on this
 * machine, and by nothing else.
 *
 * Passing `remember: false` falls back to a throwaway in-memory partition, for
 * a user who would rather re-authenticate each launch than leave a session on
 * disk.
 *
 * An `account` scopes the partition to ONE username. The jar holds a single
 * signed-in pair per origin, so a partition shared by every account means the
 * most recent password login evicts the previous account's session, and only
 * that account can ever be renewed again — the rest of the panel's StepFun
 * rows are left with a manual paste as their only lane. Keying the partition
 * on the same identity the account key uses keeps each account's session in
 * its own jar, renewable on its own, and a sign-in window for one account can
 * no longer overwrite another's cookies. Without an account the name stays the
 * unsuffixed one, which is what a token-only setup reads.
 */
function stepfunPartition({ remember = true, account } = {}) {
  // Lowercased like the account key, so the same account spelled with
  // different capitals is one partition and one row rather than two.
  const identity = String(account || '').trim().toLowerCase();
  // A digest rather than the raw username: the partition name becomes a
  // directory under the user-data folder, and an email address in a path
  // leaks the account to every backup and every bug report.
  const suffix = identity ? `-${hashKey('stepfun', `partition:${identity}`).replace(/^sha256:/, '')}` : '';
  const base = `${PARTITION_BASE}${suffix}`;
  return remember ? `persist:${base}` : base;
}

// The default, so a caller that never states a preference still persists.
const PARTITION = stepfunPartition();

function loginUrl({ redirect } = {}) {
  const target = String(redirect || 'https://platform.stepfun.com/step-plan');
  return `${LOGIN_URL}?redirect=${encodeURIComponent(target)}&source_app=platform-cn`;
}

// `session.cookies()` answers the same shape as the cookies table, so an
// expired entry can be told from a live one without a request.
//
// The current time is NOT taken here: this only reads the announced expiry,
// and the comparison against "now" belongs to the caller that owns the clock
// (readOasisSessions). Passing it in was dead weight that eslint flagged.
function tokenExpiryMs(cookies) {
  const hit = cookies.find((c) => c.name === OASIS_TOKEN);
  if (!hit) return null;
  const expires = Number(hit.expires);
  // Chromium reports a session cookie as expires === 0; it has no announced
  // lifetime, so the caller must probe it rather than trust a timestamp.
  if (!Number.isFinite(expires) || expires <= 0) return null;
  return expires * 1000;
}

// Identity of a credential the SITE will judge, used to key both the dedupe in
// readOasisSessions and the rejected set in the sign-in wait.
//
// The pair, not the token: `verifyStepfunSession` sends `Oasis-Webid` beside
// `Oasis-Token`, so the same token under a different device id is a different
// credential to the site. A token-keyed set collapses those two, and in the
// rejected set the collapse is not merely lossy but a deadlock — the site can
// rotate the webid while a token stays put (RegisterDevice issues a fresh
// device id), and once the first pair has been refused, the replacement pair is
// never even offered. Keying on both halves makes each session verifiable on
// its own, which is the only property the wait needs.
function sessionKeyFor(token, webid) {
  return JSON.stringify([String(token || ''), String(webid || '').trim()]);
}

/**
 * Every Oasis cookie pair the jar currently holds, one entry per origin that
 * has one.
 *
 * Both cookies come out of the same sign-in, and both have to travel together:
 * the quota endpoints pair `Oasis-Token` with the device id the session was
 * registered under, and a mismatched pair is rejected. Reading them in one pass
 * keeps them from ever being sampled a rotation apart.
 *
 * More than one candidate is the normal case, not an edge case. Measured on
 * the Electron this app ships: after the redirect the signed-in pair is
 * host-only on account.stepfun.com, while platform.stepfun.com has been seen
 * carrying an anonymous one of its own in other flows. Which origin answers
 * "already logged in" is therefore not something to read off the order, so both
 * are returned and the decision is left to `verifySession` — the only thing
 * that can make it.
 *
 * @returns {Promise<Array<{token: string, webid: string, source: string}>>}
 */
async function readOasisSessions(session, { nowMs = Date.now(), urls = SESSION_COOKIE_URLS } = {}) {
  const found = [];
  const seen = new Set();
  for (const url of urls) {
    // An expired cookie is still returned by cookies(); treating it as a
    // credential would send the next quota probe into a guaranteed 401 and
    // report a fresh-looking credential as rejected.
    const cookies = await session.cookies.get({ url });
    const hit = cookies.find((c) => c.name === OASIS_TOKEN && String(c.value || '').trim());
    if (!hit) continue;
    const token = String(hit.value).trim();
    // Read the device id in the SAME pass as its token — sampling them in two
    // passes is how a rotated webid ends up paired with the token it replaced.
    const webidValue = String(cookies.find((c) => c.name === OASIS_WEBID)?.value || '').trim();
    const sessionKey = sessionKeyFor(token, webidValue);
    if (seen.has(sessionKey)) continue;
    const expiresAt = tokenExpiryMs(cookies);
    if (expiresAt !== null && expiresAt <= nowMs) continue;
    seen.add(sessionKey);
    found.push({ token, webid: webidValue, source: url });
  }
  return found;
}

/**
 * The first live Oasis pair in the jar, or empty strings.
 *
 * A thin convenience over readOasisSessions for callers that only want to know
 * whether the jar holds something. Anything that has to tell a signed-in
 * session from an anonymous one must use the plural form.
 */
async function readOasisSession(session, options = {}) {
  const [first] = await readOasisSessions(session, options);
  return first ? { token: first.token, webid: first.webid } : { token: '', webid: '' };
}

/**
 * Open the StepFun sign-in page, fill the stored credentials, and return the
 * resulting Oasis-Token.
 *
 * @param {{username: string, password: string, BrowserWindow: object,
 *          session: object, partition?: string, timeoutMs?: number,
 *          tokenReplaceDeadlineMs?: number, logger?: (m: string) => void,
 *          verifySession?: (s: {token: string, webid: string}) => boolean | {ok: boolean, body?: object|null}}} options
 * @returns {Promise<{token: string, webid: string, plan: object|null}>} The Oasis-Token and the
 *   device id issued with it, plus the PLAN_URL body the site's verdict carried when the verifier
 *   answers with one (`null` when it does not, or when no verifier was supplied).
 */
async function signInStepFunWithBrowser(options = {}) {
  const {
    username,
    password,
    BrowserWindow,
    session,
    partition = PARTITION,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    tokenReplaceDeadlineMs = TOKEN_REPLACE_DEADLINE_MS,
    logger = () => {},
    // Asks the SITE whether a candidate pair is a signed-in session. Supplied by
    // main.js, which owns the transport. When it is absent the flow falls back
    // to comparing against what the jar held before submitting, which cannot
    // tell a replaced token from one that was already there.
    //
    // It answers either a bare boolean or the full `{ok, body}` verdict the
    // shared checker returns; both are accepted, and the body — the PLAN_URL
    // response that verdict just spent a request on — is carried out with an
    // accepted session rather than dropped and fetched again.
    verifySession = null
  } = options;

  if (!BrowserWindow) throw new Error('BrowserWindow is required');
  if (!session) throw new Error('an Electron session is required');
  if (!String(username || '').trim() || !String(password || '')) {
    const error = new Error('StepFun username and password are required');
    error.status = 'unauthorized';
    throw error;
  }

  // One window per partition, reused across attempts. The previous behaviour
  // built a window per call and destroyed it whenever the sign-in did not
  // succeed, which is the one thing this file must not do — see the note on
  // `retainedWindows`. Reusing also means a window left on screen after a
  // failure is the same window the next attempt drives, so the user who wants
  // to finish by hand is not left with a growing pile of them.
  const reused = retainedStepFunWindow(partition);
  const win = reused || new BrowserWindow({
    width: 520,
    height: 720,
    title: WINDOW_TITLE,
    // A visible window: the WAF may escalate a headless-looking sign-in to a
    // challenge, and a hidden window would stall with nothing on screen to
    // explain why. The title says what it is, and it closes itself.
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      // The login page is arbitrary remote content; it gets no preload, no
      // node integration, and its own throwaway session partition so it
      // cannot touch the widget's own cookies.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition
    }
  });

  const deadline = Date.now() + Number(timeoutMs || DEFAULT_TIMEOUT_MS);
  let signedIn = false;

  try {
    logger(reused
      ? 'StepFun sign-in: reusing the retained window for a new attempt'
      : 'StepFun sign-in: opening the sign-in page');
    // A window kept from an earlier attempt can be minimized or behind others;
    // a reused one has to come back on screen or the user is looking at a
    // sign-in they cannot see. Optional call: `isMinimized` is an Electron
    // API, and the guard keeps a window object that predates it from throwing.
    if (win.isMinimized?.()) win.restore?.();
    else if (!win.isVisible()) win.show?.();
    await win.loadURL(loginUrl());
    // The form is client-rendered. Wait for the tab strip, not for a field: the
    // page opens on the phone-code tab, so the password field does not exist
    // yet — waiting for it first would hang until the timeout.
    await waitForSelector(win, '[role="tab"]', deadline);

    // Radix Tabs switches its value on mousedown, so a bare click() is ignored
    // and the phone-code form stays on screen forever. Matched on the tab's
    // label, which is localized, hence several languages.
    //
    // The tab strip itself is present in the server-rendered HTML while its
    // click handler only exists once React hydrates, so switching on first
    // sight silently does nothing. Switch, verify the password field showed up,
    // and retry while the page is still settling.
    const switched = await selectPasswordTabUntilReady(win, deadline, logger);
    if (!switched) throw new Error('could not find the password sign-in tab');
    logger('StepFun sign-in: filling the stored credentials');

    const account = JSON.stringify(String(username).trim());
    const secret = JSON.stringify(String(password));
    await runPageScript(win, `(() => {
      const inputs = [...document.querySelectorAll('input')];
      const passwordEl = document.querySelector('#login-password')
        || document.querySelector('input[type="password"]');
      // The account box is id'd login-account, not login-email — the email
      // id belongs to the email-code tab. Fall back to the first input that
      // is neither the password box nor a verification-code field.
      const accountEl = document.querySelector('#login-account')
        || inputs.find((el) => el !== passwordEl
          && el.type !== 'password'
          && !/(code|otp|verify)/i.test(el.id || ''));
      if (!passwordEl) throw new Error('missing the password field');
      if (!accountEl) throw new Error('missing the account field');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      const set = (el, value) => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(accountEl, ${account});
      set(passwordEl, ${secret});
      return true;
    })()`, false);
    // Confirm the values actually landed. React re-renders controlled inputs
    // from state, and submitting before it has caught up sends empty fields.
    const filled = await waitForExpression(
      win,
      `(() => {
        const pw = document.querySelector('#login-password') || document.querySelector('input[type="password"]');
        const acc = document.querySelector('#login-account')
          || [...document.querySelectorAll('input')].find((el) => el !== pw && el.type !== 'password');
        return Boolean(pw && acc && pw.value === ${secret} && acc.value === ${account});
      })()`,
      Math.min(deadline, Date.now() + 8000)
    );
    if (!filled) throw new Error('the StepFun form did not accept the credentials');

    // Tick consent and confirm it stuck. The control is a <button
    // role="checkbox"> and, unlike the tab, it wants a plain click(): the
    // pointer sequence Radix needs for a tab cancels this one back out.
    await runPageScript(win, `(() => {
      const box = document.querySelector('[role="checkbox"]');
      if (box && box.getAttribute('aria-checked') !== 'true') box.click();
      return true;
    })()`, false);
    await waitForExpression(
      win,
      `(() => {
        const box = document.querySelector('[role="checkbox"]');
        return !box || box.getAttribute('aria-checked') === 'true';
      })()`,
      Math.min(deadline, Date.now() + 5000),
      true
    );

    // Remember what the session holds BEFORE submitting, on EVERY origin that
    // holds anything. The site issues an ANONYMOUS Oasis-Token for
    // platform.stepfun.com when the page loads, long before anyone signs in,
    // and only swaps in the signed-in one a few seconds after the redirect —
    // observed against the live account as a token that changed from 657 to 656
    // characters while the quota call was already failing with "auth failed:
    // not a logined oasis account". Reading a single origin hands back a
    // half-answer: account.stepfun.com has no token at all on a first run, so
    // the comparison below was against `''` and its guard collapsed into
    // `Boolean(token)` — a check that passes on the anonymous cookie.
    const beforeSubmit = new Set(
      (await readOasisSessions(session)).map((candidate) => candidate.token).filter(Boolean)
    );

    // Match the button by label, not by type: the submit control carries no
    // type attribute, and its label is localized per tab ("登录" here,
    // "登录 / 注册" on the phone tab).
    await runPageScript(win, `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const button = buttons.find((el) =>
        /^(登录|sign in|log in)/i.test((el.textContent || '').trim()))
        || document.querySelector('button[type="submit"]');
      if (!button) throw new Error('could not find the sign-in button');
      button.click();
      return true;
    })()`, false);

    // Poll for a session the SITE accepts, only after the page has left the
    // login screen.
    logger('StepFun sign-in: waiting for the site to issue a session');
    // Candidates the site has already rejected this round. A rejected pair is
    // not re-verified on every 400ms tick — otherwise a stale anonymous cookie
    // costs one network round trip per poll for the whole settle window.
    const rejected = new Set();
    let navigatedAt = 0;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) break;
      let navigated = false;
      try {
        const url = String(win.webContents.getURL() || '');
        navigated = Boolean(url) && !/^https:\/\/account\.stepfun\.com\/login/i.test(url);
      } catch { /* the window can go away between the check and the read */ }
      if (navigated && !navigatedAt) navigatedAt = Date.now();
      if (navigatedAt) {
        // Give the site a beat to write the signed-in cookie before reading.
        if (Date.now() - navigatedAt >= TOKEN_SETTLE_MS) {
          for (const candidate of await readOasisSessions(session)) {
            if (!candidate.token || rejected.has(sessionKeyFor(candidate.token, candidate.webid))) continue;
            // The verdict arrives either as a bare boolean or as the full
            // `{ok, body}` descriptor the shared checker answers with. The
            // body is the PLAN_URL response that verdict just cost, so an
            // accepted candidate hands it on: the login round that had to ask
            // the site for a session would otherwise throw that body away and
            // the probe would fetch the same endpoint again moments later for
            // the account label.
            let verdict = null;
            let accepted;
            if (typeof verifySession === 'function') {
              verdict = await verifySession(candidate);
              accepted = typeof verdict === 'boolean' ? verdict : Boolean(verdict?.ok);
              if (!accepted) rejected.add(sessionKeyFor(candidate.token, candidate.webid));
            } else {
              // No way to ask the site: the fallback is "this is not the
              // cookie that was already there". Weaker than a verdict — a token
              // that was present before the submit and still is now reads as
              // unchanged, and a replaced one reads as new — which is exactly
              // why main.js always supplies verifySession.
              accepted = !beforeSubmit.has(candidate.token);
            }
            if (!accepted) continue;
            logger('StepFun sign-in: the site accepted the session');
            signedIn = true;
            const plan = verdict && typeof verdict === 'object' ? verdict.body ?? null : null;
            return { token: candidate.token, webid: candidate.webid, plan };
          }
          // Every candidate the jar holds was already there before the submit
          // or has been rejected by the site. Returning one of those hands the
          // quota probe a credential that looks freshly minted and is not — the
          // exact failure this wait exists to prevent. So keep waiting, and if
          // the site never switches, fail with a message that names the cause
          // instead of a generic timeout.
          if (Date.now() - navigatedAt >= Number(tokenReplaceDeadlineMs)) {
            throw new Error('StepFun did not replace the anonymous session after sign-in');
          }
        }
      }
      await delay(400);
    }
    const error = new Error(win.isDestroyed()
      ? 'StepFun sign-in was cancelled'
      : 'StepFun sign-in did not complete before the timeout');
    error.status = 'unavailable';
    throw error;
  } catch (error) {
    if (error?.status === 'unauthorized') throw error;
    // A closed window means the user dismissed it; that is not a bad
    // credential and must not be reported as one.
    if (win.isDestroyed()) {
      const cancelled = new Error('StepFun sign-in was cancelled');
      cancelled.status = 'cancelled';
      throw cancelled;
    }
    if (!error.status) error.status = 'unavailable';
    // The window is deliberately left open below, so say so. Silently keeping a
    // visible window is worse than not keeping one: the user has no way to tell
    // it is still theirs to use.
    error.manualFallback = true;
    throw error;
  } finally {
    // NEVER destroy this window. On success it is hidden and kept so the
    // renderer — and the network stack it owns — stays alive for the quota read
    // that follows. On failure it is kept VISIBLE: the user can finish the
    // sign-in by hand, which is the only route left when the automation gives
    // up on a page it cannot drive.
    //
    // The earlier version destroyed the window on the failure path, which
    // contradicted the measurement recorded on `retainedWindows` below and is
    // the same network-stack hazard the success path avoids.
    if (win.isDestroyed()) {
      // Already gone (the user closed it) — there is nothing to keep, and a
      // `return` here would swallow the try/catch result, so just fall through.
    } else if (signedIn) {
      retainStepFunWindow(win, partition);
    } else {
      retainStepFunWindow(win, partition, { hide: false });
      logger('StepFun sign-in: the window is still open, finish the sign-in there');
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `executeJavaScript` resolves when the renderer answers and rejects when it
// throws, but a renderer that is navigating away, or has crashed, can leave the
// promise pending forever. Every page probe goes through here so one dead
// renderer costs a single miss instead of parking the sign-in.
async function runPageScript(win, script, fallback = undefined, timeoutMs = PAGE_SCRIPT_TIMEOUT_MS) {
  if (win.isDestroyed()) return fallback;
  let timer = null;
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(script),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); })
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A destroyed window takes Chromium's network stack down with it: measured on
// Electron 43.4.0, once a BrowserWindow on a persistent partition is destroyed,
// every later `net.fetch` from the default session and every later `loadURL`
// in a new window hangs indefinitely — which is exactly the shape of a quota
// probe that times out right after signing in. So the sign-in window is hidden
// and kept instead of closed. It costs one idle renderer; it buys a working
// network stack. `disposeStepFunWindow` is the only way out, and main.js calls
// it on quit — nothing else owns this window.
//
// Keyed by partition rather than held as one module-level slot: the partition
// is a caller-supplied setting (`persist:stepfun-login` vs the throwaway
// partition), so a single slot would let one sign-in silently displace
// another's window and leave the displaced partition's cookie jar readable by
// a window that is about to be torn down.
const retainedWindows = new Map();

function retainedStepFunWindow(partition = PARTITION) {
  const win = retainedWindows.get(partition);
  if (win && !win.isDestroyed()) return win;
  if (win) retainedWindows.delete(partition);
  return null;
}

function retainStepFunWindow(win, partition, { hide = true } = {}) {
  if (!win || win.isDestroyed()) return null;
  const key = partition || win.webContents?.session?.name || PARTITION;
  retainedWindows.set(key, win);
  // The user may close it at any time; forget it rather than hand out a corpse.
  win.once('closed', () => {
    if (retainedWindows.get(key) === win) retainedWindows.delete(key);
  });
  if (hide && win.isVisible()) win.hide();
  return win;
}

function disposeStepFunWindow(partition) {
  if (partition !== undefined) {
    const one = retainedWindows.get(partition);
    if (one && !one.isDestroyed()) one.destroy();
    retainedWindows.delete(partition);
    return;
  }
  for (const win of retainedWindows.values()) {
    if (win && !win.isDestroyed()) win.destroy();
  }
  retainedWindows.clear();
}

// Switch to the password tab and confirm it actually took effect. Returns
// false when the tab itself was never found, so the caller can tell "the page
// never offered a password tab" from "the page is still hydrating".
//
// The trigger is found by LABEL only. An earlier version also tried a hardcoded
// `#radix-\xABR3nndl9b\xBB-trigger-password` id first: React's useId generates
// that id per component instance, so it belongs to whichever tree the build
// happened to render, and matching on it silently stopped the moment the id
// changed — with a label match still sitting right behind it.
async function selectPasswordTabUntilReady(win, deadline, logger = () => {}) {
  const script = `(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((el) =>
      /密码|password|pwd|senha/i.test(el.textContent || ''));
    if (!tab) return false;
    for (const type of ['pointerdown', 'mousedown']) {
      tab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    }
    tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    tab.click();
    return true;
  })()`;

  let sawTab = false;
  for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt += 1) {
    const clicked = await runPageScript(win, script, false);
    if (!clicked) return sawTab;
    sawTab = true;
    // The password box is the proof the switch landed; matched by type so a
    // rebuilt id cannot strand the sign-in.
    if (await waitForSelector(win, 'input[type="password"]', Math.min(deadline, Date.now() + 6000), true)) {
      return true;
    }
    logger('StepFun sign-in: the password tab did not switch yet, retrying');
    await delay(1200);
  }
  return sawTab;
}

// did-finish-load resolves before client-side routes settle, so poll for the
// condition instead of racing a single event.
async function waitForExpression(win, script, deadline) {
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false;
    const done = await runPageScript(win, script, false);
    if (done) return true;
    await delay(200);
  }
  return false;
}

async function waitForSelector(win, selector, deadline, soft = false) {
  const found = await waitForExpression(
    win,
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    deadline
  );
  if (found) return true;
  // `soft` is for callers that retry; the rest treat a miss as fatal.
  if (soft) return false;
  throw new Error(`timed out waiting for ${selector}`);
}

module.exports = {
  ACCOUNT_COOKIE_URL,
  COOKIE_URL,
  DEFAULT_TIMEOUT_MS,
  LOGIN_URL,
  OASIS_TOKEN,
  OASIS_WEBID,
  PARTITION,
  PARTITION_BASE,
  SESSION_COOKIE_URLS,
  TOKEN_REPLACE_DEADLINE_MS,
  WINDOW_TITLE,
  disposeStepFunWindow,
  loginUrl,
  readOasisSession,
  readOasisSessions,
  retainedStepFunWindow,
  sessionKeyFor,
  signInStepFunWithBrowser,
  stepfunPartition,
  tokenExpiryMs
};