'use strict';

// The Grok usage page is the ledger for Cursor included calls. Its session has
// to live in this Electron partition: Edge's cookies are app-bound, and the
// Grok CLI token cannot call the dashboard. After a login in this window, the
// same session fetches query-billing-items and writes normalized rows for the
// collector. Emails and account ids are not stored.

const fs = require('node:fs');
const { readRegularFileNoFollow, writePrivateJsonAtomic } = require('../shared/credentialStore');
const { BILLING_LEDGER_MAX_BYTES, billingAccountKey, billingIdentityHash, billingItemsPath, normalizeBillingRow, readBillingRows } = require('../shared/providers/cursor/billingLedger');
const {
  BILLING_ITEMS_URL,
  billingRowKey,
  nextPageToken,
  rowsFromBillingPayload
} = require('../shared/providers/cursor/billingItems');

const USAGE_PAGE = 'https://grok.com/dashboard/usage';
const PAGE_SIZE = 100;
const MAX_PAGES = 40;
const MAX_REFRESH_PAGES = MAX_PAGES * 4;
const MIN_SPLIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const STARTUP_RETRY_DELAYS_MS = [3000, 10000, 30000];
const TODAY_REFRESH_MS = 30000;
const HISTORY_REFRESH_MS = 10 * 60 * 1000;

const loginWindows = new Map();
const windowScopes = new WeakMap();
const refreshes = new Map();
const generations = new Map();
const statuses = new Map();

function billingPartition(accountId) {
  return `persist:cursor-billing-${billingAccountKey(accountId)}`;
}

function billingStatus(accountId) {
  return statuses.get(accountId) || 'notConnected';
}

function ownsBillingWindow(window) {
  return [...loginWindows.values()].includes(window);
}

function setBillingStatus(accountId, status, onStatusChanged) {
  if (billingStatus(accountId) === status) return;
  statuses.set(accountId, status);
  onStatusChanged?.(accountId, status);
}

function dashboardSession(session, accountId) {
  return session.fromPartition(billingPartition(accountId));
}

function writeRows(filePath, rows, accountId, email, maxBytes = BILLING_LEDGER_MAX_BYTES) {
  // The API query is a rolling window. Preserve older downloaded billing rows
  // in this ledger so they do not disappear from Month/Total and History.
  const previous = readBillingRows(filePath, accountId).map(normalizeBillingRow);
  const identityHash = billingIdentityHash(email);
  let identityChanged = false;
  if (fs.existsSync(filePath)) {
    const stored = JSON.parse(readRegularFileNoFollow(filePath, { maxBytes: BILLING_LEDGER_MAX_BYTES }));
    identityChanged = stored.identityHash !== identityHash;
    if (stored.version !== 2 || stored.accountKey !== billingAccountKey(accountId) || !Array.isArray(stored.rows)
      || stored.rows.some(row => !normalizeBillingRow(row))) {
      throw new Error('Cursor billing ledger is invalid; keeping the existing file');
    }
  }
  const merged = new Map(previous.map(row => [billingRowKey(row), row]));
  let changed = identityChanged;
  for (const input of rows) {
    const row = normalizeBillingRow(input);
    if (!row) throw new Error('Grok returned invalid token counts; keeping the previous ledger');
    const key = billingRowKey(row);
    if (JSON.stringify(merged.get(key)) !== JSON.stringify(row)) changed = true;
    merged.set(key, row);
  }
  writePrivateJsonAtomic(filePath, { version: 2, accountKey: billingAccountKey(accountId), identityHash,
    fetchedAt: new Date().toISOString(), rows: [...merged.values()].map(normalizeBillingRow).filter(Boolean) }, {
    compact: true,
    maxBytes: Number.isFinite(maxBytes) ? Math.max(0, Math.min(BILLING_LEDGER_MAX_BYTES, Math.floor(maxBytes))) : BILLING_LEDGER_MAX_BYTES
  });
  return changed;
}

function dashboardFetch(webContents) {
  return async url => {
    const pageUrl = webContents && !webContents.isDestroyed() ? new URL(webContents.getURL() || 'about:blank') : null;
    if (pageUrl?.origin !== 'https://grok.com' || pageUrl.pathname !== '/dashboard/usage') {
      throw new Error('Open the Grok usage page and finish signing in before syncing billing items');
    }
    const requestUrl = new URL(url);
    if (requestUrl.origin !== 'https://grok.com' || requestUrl.pathname !== new URL(BILLING_ITEMS_URL).pathname) {
      throw new Error('Unsupported Grok billing URL');
    }
    // session.fetch does not share the renderer's Cloudflare validation context.
    // Keep this same-origin request in the actual logged-in dashboard document.
    // No credentials or arbitrary caller-provided script leave that document.
    const result = await webContents.executeJavaScript(`(async () => {
      if (location.origin !== 'https://grok.com' || location.pathname !== '/dashboard/usage') {
        throw new Error('Grok usage page is not ready');
      }
      const response = await fetch(${JSON.stringify(requestUrl.toString())}, {
        credentials: 'same-origin', headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      });
      return { ok: response.ok, status: response.status,
        payload: response.ok ? await response.json() : null };
    })()`);
    return { ok: result.ok, status: result.status, json: async () => result.payload };
  };
}

function paginationError(rangeTooLarge = false) {
  const error = new Error('Grok billing pagination did not finish; keeping the previous ledger');
  error.code = 'BILLING_PAGINATION_INCOMPLETE';
  error.rangeTooLarge = rangeTooLarge;
  return error;
}

async function fetchBillingItems(ses, options = {}) {
  return fetchBillingWindow(ses, options, { remaining: MAX_REFRESH_PAGES });
}

async function fetchBillingWindow(ses, options, budget) {
  try {
    return await fetchBillingRange(ses, options, budget);
  } catch (error) {
    const start = Date.parse(options.startTime);
    const end = Date.parse(options.endTime);
    if (error.code !== 'BILLING_PAGINATION_INCOMPLETE' || !error.rangeTooLarge || !(end - start > MIN_SPLIT_WINDOW_MS)) throw error;
    const middle = Math.floor((start + end) / 2);
    // Overlap queries to cover inclusive/exclusive API boundaries, then assign
    // each observed timestamp to exactly one half. Never retain partial pages.
    const left = await fetchBillingWindow(ses, { ...options, endTime: new Date(middle + 1000).toISOString() }, budget);
    const right = await fetchBillingWindow(ses, { ...options, startTime: new Date(middle - 1000).toISOString() }, budget);
    return [...left.filter(row => row.eventTime < middle), ...right.filter(row => row.eventTime >= middle)];
  }
}

async function fetchBillingRange(ses, { startTime, endTime, fetchImpl, expectedEmail }, budget) {
  const fetch = fetchImpl || ses.fetch.bind(ses);
  const rows = [];
  const seen = new Set();
  const seenPages = new Set();
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (budget.remaining-- <= 0) throw paginationError();
    const url = new URL(BILLING_ITEMS_URL);
    url.searchParams.set('scope', 'user');
    url.searchParams.set('startTime', startTime);
    url.searchParams.set('endTime', endTime);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (pageToken) url.searchParams.set('cursor', pageToken);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      const error = new Error(`Grok billing items HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    if (expectedEmail) {
      const items = Array.isArray(payload) ? payload : payload?.items || payload?.billingItems || payload?.rows || payload?.data;
      if (!Array.isArray(items)) throw new Error('Grok returned an invalid billing response');
      for (const item of items) {
        if (String(item?.product || item?.Product || '').trim().toLowerCase() !== 'cursor') continue;
        // Verify the authenticated billing owner before discarding identity
        // metadata. Neither an email nor a raw account id enters the ledger.
        const email = String(item.displayExtras?.userEmail || '').trim().toLowerCase();
        if (!email || email !== expectedEmail.trim().toLowerCase()) {
          const error = new Error('Sign in to Grok with the same email as this Cursor account');
          error.code = 'BILLING_ACCOUNT_MISMATCH';
          throw error;
        }
      }
    }
    const batch = rowsFromBillingPayload(payload);
    const token = nextPageToken(payload);
    if (payload?.pagination?.hasMore === true && !token) {
      throw paginationError();
    }
    for (const row of batch) {
      const key = billingRowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (!token) break;
    if (seenPages.has(token)) throw paginationError();
    if (page === MAX_PAGES - 1) throw paginationError(true);
    seenPages.add(token);
    pageToken = token;
  }
  return rows;
}

function refreshGrokBillingItems(options = {}) {
  const filePath = billingItemsPath(options.userDataPath, options.accountId);
  const generation = generations.get(options.accountId) || 0;
  const isCurrent = () => (generations.get(options.accountId) || 0) === generation && options.isCurrent?.() !== false;
  const key = `${filePath}:${generation}`;
  if (!refreshes.has(key)) {
    const pending = downloadBillingItems({ ...options, isCurrent }).finally(() => refreshes.delete(key));
    refreshes.set(key, pending);
  }
  return refreshes.get(key).then(async ({ count, changed }) => {
    if (changed && isCurrent()) await options.onChanged?.();
    return count;
  }).catch(error => {
    if (isCurrent()) setBillingStatus(options.accountId,
      error.code === 'BILLING_ACCOUNT_MISMATCH' ? 'accountMismatch'
        : error.code === 'PRIVATE_JSON_TOO_LARGE' ? 'storageLimit'
          : error.code === 'BILLING_PAGINATION_INCOMPLETE' ? 'syncIncomplete' : 'signInRequired', options.onStatusChanged);
    throw error;
  });
}

async function downloadBillingItems({ session, userDataPath, accountId, expectedEmail,
  now = new Date(), todayOnly = false, logger, fetchImpl, webContents, isCurrent, onStatusChanged, maxLedgerBytes } = {}) {
  if (!expectedEmail?.trim()) throw new Error('Verify the Cursor account before connecting billing recovery');
  if (!isCurrent()) throw new Error('Cursor billing connection changed during refresh');
  const ses = dashboardSession(session, accountId);
  const end = new Date(now);
  const start = new Date(now);
  if (todayOnly) {
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
  } else {
    end.setUTCDate(end.getUTCDate() + 1);
    end.setUTCHours(0, 0, 0, 0);
    start.setTime(end.getTime());
    start.setUTCDate(start.getUTCDate() - 21);
  }
  const rows = await fetchBillingItems(ses, {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    expectedEmail,
    fetchImpl: fetchImpl || dashboardFetch(webContents || loginWindows.get(accountId)?.webContents)
  });
  if (!isCurrent()) throw new Error('Cursor billing connection changed during refresh');
  const changed = writeRows(billingItemsPath(userDataPath, accountId), rows, accountId, expectedEmail, maxLedgerBytes);
  setBillingStatus(accountId, 'connected', onStatusChanged);
  if (typeof logger === 'function') logger(`grok billing items stored ${rows.length} cursor rows`);
  return { count: rows.length, changed };
}

function startGrokBillingRefresh({ isEnabled = () => true, getAccounts, onRefresh, ...options }) {
  let lastHistoryRefresh = Date.now();
  let refreshing = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped || refreshing || !isEnabled()) return;
    refreshing = true;
    const todayOnly = Date.now() - lastHistoryRefresh < HISTORY_REFRESH_MS;
    try {
      const accounts = getAccounts ? await getAccounts() : [options];
      for (const account of accounts) {
        if (stopped || !isEnabled()) break;
        if (account.isCurrent?.() === false) continue;
        try {
          if (options.BrowserWindow && !loginWindows.has(account.accountId)) {
            openGrokDashboardWindow({ ...options, ...account, show: false,
              isCurrent: () => !stopped && isEnabled() && account.isCurrent?.() !== false,
              onRefresh });
          }
          await refreshGrokBillingItems({ ...options, ...account, todayOnly,
            isCurrent: () => !stopped && isEnabled() && account.isCurrent?.() !== false,
            onChanged: () => { if (!stopped && isEnabled()) return onRefresh?.(); } });
        } catch (error) {
          if (error?.status !== 401 && error?.status !== 403) options.logger?.(error.message);
        }
      }
      if (!todayOnly) lastHistoryRefresh = Date.now();
    } catch (error) {
      if (error?.status !== 401 && error?.status !== 403) options.logger?.(error.message);
    } finally {
      refreshing = false;
    }
  }, TODAY_REFRESH_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function openGrokDashboardWindow({ BrowserWindow, session, userDataPath, accountId, expectedEmail,
  logger, onRefresh, onStatusChanged, show = true, isCurrent = () => true }) {
  const existing = loginWindows.get(accountId);
  if (existing && !existing.isDestroyed()) {
    const scope = windowScopes.get(existing);
    if (scope?.isCurrent() !== false && scope?.email === expectedEmail) {
      if (show) { existing.show(); existing.focus(); }
      return existing;
    }
    generations.set(accountId, (generations.get(accountId) || 0) + 1);
    existing.destroy();
  }
  const generation = generations.get(accountId) || 0;
  const current = () => (generations.get(accountId) || 0) === generation && isCurrent();
  const ses = dashboardSession(session, accountId);
  const window = new BrowserWindow({
    show,
    width: 1100,
    height: 800,
    title: 'Cursor billing recovery — Grok sign-in',
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  loginWindows.set(accountId, window);
  windowScopes.set(window, { isCurrent: current, email: expectedEmail });
  setBillingStatus(accountId, 'signInRequired', onStatusChanged);
  let refreshing = false;
  let retryTimer = null;
  let retryAttempt = 0;
  const refresh = () => {
    if (refreshing || window.isDestroyed() || !current()) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    refreshing = true;
    refreshGrokBillingItems({ session, userDataPath, accountId, expectedEmail, logger,
      isCurrent: current, onStatusChanged, webContents: window.webContents }).then(async (count) => {
      if (!current() || window.isDestroyed()) return;
      if (count > 0 && !window.isDestroyed()) window.hide();
      await onRefresh?.(count);
      retryAttempt = 0;
    }).catch((error) => {
      if (!current()) return;
      if (typeof logger === 'function') logger(`grok billing items unavailable: ${error.message}`);
      // did-finish-load can precede the dashboard's authentication bootstrap.
      // Retry promptly once the document has established its login context.
      const delay = STARTUP_RETRY_DELAYS_MS[retryAttempt++];
      if (delay !== undefined && !window.isDestroyed() && current()) {
        retryTimer = setTimeout(refresh, delay);
        retryTimer.unref?.();
      }
    }).finally(() => {
      refreshing = false;
    });
  };
  const refreshPage = () => { retryAttempt = 0; refresh(); };
  window.webContents.on('did-finish-load', refreshPage);
  window.webContents.on('did-navigate-in-page', refreshPage);
  window.on('closed', () => {
    clearTimeout(retryTimer);
    if (loginWindows.get(accountId) === window) loginWindows.delete(accountId);
  });
  window.loadURL(USAGE_PAGE)?.catch?.(() => {
    if (current()) setBillingStatus(accountId, 'signInRequired', onStatusChanged);
  });
  return window;
}

async function disconnectGrokBilling({ session, accountId }) {
  generations.set(accountId, (generations.get(accountId) || 0) + 1);
  const window = loginWindows.get(accountId);
  loginWindows.delete(accountId);
  if (window && !window.isDestroyed()) window.destroy();
  statuses.delete(accountId);
  await dashboardSession(session, accountId).clearStorageData();
}

module.exports = {
  billingPartition,
  billingStatus,
  billingItemsPath,
  disconnectGrokBilling,
  fetchBillingItems,
  ownsBillingWindow,
  openGrokDashboardWindow,
  refreshGrokBillingItems,
  startGrokBillingRefresh
};
