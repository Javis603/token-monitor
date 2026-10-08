'use strict';

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
// `session.cookies()` — which resolves inside the browser process, so the
// app-bound cookie encryption that stops every external reader does not apply.
//
// Token Monitor is already an Electron app, so this costs no new dependency.

const LOGIN_URL = 'https://account.stepfun.com/login';
const COOKIE_DOMAIN = '.stepfun.com';
const OASIS_TOKEN = 'Oasis-Token';
const OASIS_WEBID = 'Oasis-Webid';
const WINDOW_TITLE = '正在登录 StepFun…';
// Long enough to clear an escalated WAF challenge: the window is visible, so
// the user can finish a challenge that needs a click. limits.js wraps this in
// a slightly longer deadline and reports the failure as a sign-in failure.
const DEFAULT_TIMEOUT_MS = 110_000;
// Exported so the caller can hand `session.fromPartition(PARTITION)` to this
// module. A window and the session that reads it must share one partition, and
// a typo'd literal in two files is how a sign-in silently returns no token.
const PARTITION = 'stepfun-login';

// The password tab is a Radix tab; its trigger id is stable across the locale
// because it comes from the component, not the translated label. Selecting it
// before filling keeps the automation independent of the UI language.
const PASSWORD_TAB_TRIGGER = '#radix-\xABR3nndl9b\xBB-trigger-password';

function loginUrl({ redirect } = {}) {
  const target = String(redirect || 'https://platform.stepfun.com/step-plan');
  return `${LOGIN_URL}?redirect=${encodeURIComponent(target)}&source_app=platform-cn`;
}

// `session.cookies()` answers the same shape as the cookies table, so an
// expired entry can be told from a live one without a request.
function tokenExpiryMs(cookies, nowMs) {
  const hit = cookies.find((c) => c.name === OASIS_TOKEN);
  if (!hit) return null;
  const expires = Number(hit.expires);
  // Chromium reports a session cookie as expires === 0; it has no announced
  // lifetime, so the caller must probe it rather than trust a timestamp.
  if (!Number.isFinite(expires) || expires <= 0) return null;
  return expires * 1000;
}

// Both cookies come out of the same sign-in, and both have to travel together:
// the quota endpoints pair `Oasis-Token` with the device id the session was
// registered under, and a mismatched pair is rejected. Reading them in one
// pass keeps them from ever being sampled a rotation apart.
async function readOasisSession(session, { nowMs = Date.now() } = {}) {
  const cookies = await session.cookies({ domain: COOKIE_DOMAIN });
  const hit = cookies.find((c) => c.name === OASIS_TOKEN && String(c.value || '').trim());
  if (!hit) return { token: '', webid: '' };
  const value = String(hit.value).trim();
  const expiresAt = tokenExpiryMs(cookies, nowMs);
  // An expired cookie is still returned by cookies(); treating it as a
  // credential would send the next quota probe into a guaranteed 401 and
  // report a fresh-looking credential as rejected.
  if (expiresAt !== null && expiresAt <= nowMs) return { token: '', webid: '' };
  const webid = cookies.find((c) => c.name === OASIS_WEBID);
  return { token: value, webid: String(webid?.value || '').trim() };
}

function readOasisToken(session, options) {
  return readOasisSession(session, options).then((s) => s.token);
}

/**
 * Open the StepFun sign-in page, fill the stored credentials, and return the
 * resulting Oasis-Token.
 *
 * @param {{username: string, password: string, BrowserWindow: object,
 *          session: object, timeoutMs?: number, logger?: (m: string) => void,
 *          onStatus?: (m: string) => void}} options
 * @returns {Promise<{token: string, webid: string}>} The Oasis-Token and the
 *   device id issued with it, or `{token: '', webid: ''}` when the window was
 *   closed before sign-in completed.
 */
async function signInStepFunWithBrowser(options = {}) {
  const {
    username,
    password,
    BrowserWindow,
    session,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger = () => {},
    onStatus = () => {}
  } = options;

  if (!BrowserWindow) throw new Error('BrowserWindow is required');
  if (!session) throw new Error('an Electron session is required');
  if (!String(username || '').trim() || !String(password || '')) {
    const error = new Error('StepFun username and password are required');
    error.status = 'unauthorized';
    throw error;
  }

  const win = new BrowserWindow({
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
      partition: PARTITION
    }
  });

  const deadline = Date.now() + Number(timeoutMs || DEFAULT_TIMEOUT_MS);
  const cleanup = () => { if (!win.isDestroyed()) win.destroy(); };

  try {
    logger('opening the StepFun sign-in page');
    onStatus('opening');
    await win.loadURL(loginUrl());
    // The form is client-rendered; wait for the email field before touching it.
    await waitForSelector(win, '#login-email', deadline);

    // Switch to the password tab. Its trigger carries a generated id, so fall
    // back to matching the tab by its position when the id is not the expected
    // one — a rebuilt page must not be able to strand the sign-in.
    const switched = await win.webContents.executeJavaScript(
      `(() => {
        const byId = document.querySelector(${JSON.stringify(PASSWORD_TAB_TRIGGER)});
        const tab = byId || [...document.querySelectorAll('[role="tab"]')].find((el) =>
          /密码|password|pwd|senha/i.test(el.textContent || ''));
        if (!tab) return false;
        tab.click();
        return true;
      })()`
    );
    if (!switched) throw new Error('could not find the password sign-in tab');
    onStatus('filling');
    await waitForSelector(win, '#login-password', deadline);

    logger('filling the StepFun credentials');
    await win.webContents.executeJavaScript(
      `(() => {
        const set = (selector, value) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error('missing ' + selector);
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('#login-email', ${JSON.stringify(String(username).trim())});
        set('#login-password', ${JSON.stringify(String(password))});
        return true;
      })()`
    );

    // The consent checkbox gates the submit button; click it when present.
    await win.webContents.executeJavaScript(
      `(() => {
        const box = document.querySelector('[role="checkbox"]');
        if (box && box.getAttribute('aria-checked') !== 'true') box.click();
        const button = [...document.querySelectorAll('button')]
          .find((el) => (el.textContent || '').trim() === '登录')
          || [...document.querySelectorAll('button[type="submit"]')][0];
        if (!button) throw new Error('could not find the sign-in button');
        button.click();
        return true;
      })()`
    );

    // Poll the session for the token rather than watching navigation: the
    // site finishes the exchange and stores the cookie without necessarily
    // navigating this window, and a failed sign-in also does not navigate.
    onStatus('signing-in');
    while (Date.now() < deadline) {
      const outcome = await readOasisSession(session);
      if (outcome.token) {
        logger('StepFun sign-in completed');
        onStatus('done');
        return outcome;
      }
      if (win.isDestroyed()) break;
      await delay(750);
    }
    const error = new Error('StepFun sign-in did not produce a token before the timeout');
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
    throw error;
  } finally {
    cleanup();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// did-finish-load resolves before client-side routes settle, so poll for the
// element instead of racing a single event.
async function waitForSelector(win, selector, deadline) {
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false;
    const found = await win.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`
    ).catch(() => false);
    if (found) return true;
    await delay(200);
  }
  throw new Error(`timed out waiting for ${selector}`);
}

module.exports = {
  COOKIE_DOMAIN,
  DEFAULT_TIMEOUT_MS,
  LOGIN_URL,
  OASIS_TOKEN,
  OASIS_WEBID,
  PARTITION,
  WINDOW_TITLE,
  loginUrl,
  readOasisSession,
  readOasisToken,
  signInStepFunWithBrowser,
  tokenExpiryMs
};
