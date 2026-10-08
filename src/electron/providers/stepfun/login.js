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
// The cookie read is filtered by the URL the quota page is served from, so the
// jar answers exactly "what would Chromium send to platform.stepfun.com?".
const COOKIE_URL = 'https://platform.stepfun.com/';
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

// `session.cookies` is a Cookies instance, not a function: the read is
// `cookies.get(filter)`. Filtering by URL rather than by domain asks Chromium
// exactly which cookies it would send to the quota page, which is what the
// request has to reproduce — a domain filter would also return entries for
// hosts the API never talks to.
// Both cookies come out of the same sign-in, and both have to travel together:
// the quota endpoints pair `Oasis-Token` with the device id the session was
// registered under, and a mismatched pair is rejected. Reading them in one
// pass keeps them from ever being sampled a rotation apart.
async function readOasisSession(session, { nowMs = Date.now() } = {}) {
  const cookies = await session.cookies.get({ url: COOKIE_URL });
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
    // The form is client-rendered. Wait for the tab strip, not for a field: the
    // page opens on the phone-code tab, so the password field does not exist
    // yet — waiting for it first would hang until the timeout.
    await waitForSelector(win, '[role="tab"]', deadline);

    // Radix Tabs switches its value on mousedown, so a bare click() is ignored
    // and the phone-code form stays on screen forever. The trigger id is
    // generated, so fall back to the tab's label — which is localized, hence
    // matched against several languages.
    //
    // The tab strip itself is present in the server-rendered HTML while its
    // click handler only exists once React hydrates, so switching on first
    // sight silently does nothing. Switch, verify the password field showed up,
    // and retry while the page is still settling.
    const switched = await selectPasswordTabUntilReady(win, deadline, logger);
    if (!switched) throw new Error('could not find the password sign-in tab');
    onStatus('filling');

    logger('filling the StepFun credentials');
    const account = JSON.stringify(String(username).trim());
    const secret = JSON.stringify(String(password));
    await win.webContents.executeJavaScript(
      `(() => {
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
      })()`
    );
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
    await win.webContents.executeJavaScript(
      `(() => {
        const box = document.querySelector('[role="checkbox"]');
        if (box && box.getAttribute('aria-checked') !== 'true') box.click();
        return true;
      })()`
    );
    await waitForExpression(
      win,
      `(() => {
        const box = document.querySelector('[role="checkbox"]');
        return !box || box.getAttribute('aria-checked') === 'true';
      })()`,
      Math.min(deadline, Date.now() + 5000),
      true
    );

    // Match the button by label, not by type: the submit control carries no
    // type attribute, and its label is localized per tab ("登录" here,
    // "登录 / 注册" on the phone tab).
    await win.webContents.executeJavaScript(
      `(() => {
        const buttons = [...document.querySelectorAll('button')];
        const button = buttons.find((el) =>
          /^(登录|sign in|log in)/i.test((el.textContent || '').trim()))
          || document.querySelector('button[type="submit"]');
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

// Switch to the password tab and confirm it actually took effect. Returns
// false when the tab itself was never found, so the caller can tell "the page
// never offered a password tab" from "the page is still hydrating".
async function selectPasswordTabUntilReady(win, deadline, logger = () => {}) {
  const script = `(() => {
    const byId = document.querySelector(${JSON.stringify(PASSWORD_TAB_TRIGGER)});
    const tab = byId || [...document.querySelectorAll('[role="tab"]')].find((el) =>
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
    const clicked = await win.webContents.executeJavaScript(script).catch(() => false);
    if (!clicked) return sawTab;
    sawTab = true;
    // The password box is the proof the switch landed; matched by type so a
    // rebuilt id cannot strand the sign-in.
    if (await waitForSelector(win, 'input[type="password"]', Math.min(deadline, Date.now() + 6000), true)) {
      return true;
    }
    logger('the password tab did not switch yet, retrying');
    await delay(1200);
  }
  return sawTab;
}

// did-finish-load resolves before client-side routes settle, so poll for the
// condition instead of racing a single event.
async function waitForExpression(win, script, deadline) {
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false;
    const done = await win.webContents.executeJavaScript(script).catch(() => false);
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
  COOKIE_URL,
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
