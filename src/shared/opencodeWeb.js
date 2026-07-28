'use strict';

const { BROWSER_USER_AGENT } = require('./browserUserAgent');

const BASE_URL = 'https://opencode.ai';
const SERVER_URL = 'https://opencode.ai/_server';
// From codexbar 0.32.4 (its docs/opencode.md): opencode.ai TanStack server-function IDs (build hashes).
// These can break when opencode.ai redeploys — keep in sync with codexbar if Zen stops resolving.
const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f';
const SUBSCRIPTION_SERVER_ID = '7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4';

const PCT_KEYS = ['usagePercent', 'usedPercent', 'percentUsed', 'percent', 'usage_percent', 'used_percent', 'utilization', 'utilizationPercent', 'utilization_percent', 'usage'];
const RESET_SEC_KEYS = ['resetInSec', 'resetInSeconds', 'resetSeconds', 'reset_sec', 'reset_in_sec', 'resetsInSec', 'resetsInSeconds', 'resetIn', 'resetSec'];
const RESET_AT_KEYS = ['resetAt', 'resetsAt', 'reset_at', 'resets_at', 'nextReset', 'next_reset', 'renewAt', 'renew_at'];
const BALANCE_KEYS = ['balanceUSD', 'balanceUsd', 'currentBalance', 'zenBalance', 'currentBalanceUSD'];

function sanitizeCookieHeader(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  text = text.replace(/^cookie\s*:\s*/i, '');
  const cleaned = text.split(';').map((p) => p.trim()).filter(Boolean).join('; ');
  // A bare value pasted without a name= is almost always the `auth` session cookie.
  if (cleaned && !cleaned.includes('=')) return `auth=${cleaned}`;
  return cleaned;
}

function serverRequestUrl(serverId, args, method) {
  if (String(method).toUpperCase() !== 'GET') return SERVER_URL;
  const params = new URLSearchParams({ id: serverId });
  if (Array.isArray(args) && args.length > 0) params.set('args', JSON.stringify(args));
  return `${SERVER_URL}?${params.toString()}`;
}

function cryptoUuid() {
  return require('node:crypto').randomUUID();
}

function buildHeaders(serverId, cookieHeader, referer) {
  return {
    Cookie: cookieHeader,
    'X-Server-Id': serverId,
    'X-Server-Instance': `server-fn:${cryptoUuid()}`,
    'User-Agent': BROWSER_USER_AGENT,
    Origin: BASE_URL,
    Referer: referer || BASE_URL,
    Accept: 'text/javascript, application/json;q=0.9, */*;q=0.8'
  };
}

function asNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function round1(v) { return Math.round(v * 10) / 10; }
function clampPct(v) { return Math.max(0, Math.min(100, v)); }

function toMs(value) {
  const n = asNum(value);
  if (n != null) return n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
  if (typeof value === 'string') { const t = Date.parse(value); return Number.isNaN(t) ? null : t; }
  return null;
}

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] !== undefined) return obj[k];
  return undefined;
}

function parseWorkspaceIds(text) {
  const ids = new Set();
  const re = /id\s*[:=]\s*"(wrk_[^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  if (ids.size === 0) {
    try {
      const walk = (o) => {
        if (typeof o === 'string' && o.startsWith('wrk_')) ids.add(o);
        else if (Array.isArray(o)) o.forEach(walk);
        else if (o && typeof o === 'object') Object.values(o).forEach(walk);
      };
      walk(JSON.parse(text));
    } catch (_) { /* not JSON */ }
  }
  return Array.from(ids);
}

function parseWindowObj(obj, kind, windowMinutes, nowMs) {
  if (!obj || typeof obj !== 'object') return null;
  let pct = null;
  for (const k of PCT_KEYS) { const n = asNum(obj[k]); if (n != null) { pct = n; break; } }
  if (pct == null) {
    const used = asNum(pick(obj, ['used', 'consumed']));
    const limit = asNum(pick(obj, ['limit', 'total', 'quota', 'max', 'cap']));
    if (used != null && limit != null && limit > 0) pct = (used / limit) * 100;
  }
  if (pct == null) return null;
  if (pct <= 1 && pct >= 0) pct *= 100;
  pct = round1(clampPct(pct));
  let resetSec = null;
  for (const k of RESET_SEC_KEYS) { const n = asNum(obj[k]); if (n != null) { resetSec = n; break; } }
  if (resetSec == null) { const ms = toMs(pick(obj, RESET_AT_KEYS)); if (ms != null) resetSec = Math.max(0, Math.round((ms - nowMs) / 1000)); }
  resetSec = Math.max(0, resetSec || 0);
  return { kind, usedPercent: pct, used: null, limit: null, resetsAt: new Date(nowMs + resetSec * 1000).toISOString(), windowMinutes };
}

function findByKeyword(obj, keyword, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase().includes(keyword) && v && typeof v === 'object') return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const found = findByKeyword(v, keyword, depth + 1); if (found) return found; }
  }
  return null;
}

function findBalance(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const k of BALANCE_KEYS) { const n = asNum(obj[k]); if (n != null) return n; }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const n = findBalance(v, depth + 1); if (n != null) return n; }
  }
  return null;
}

// codexbar docs/opencode.md: _server responses are text/javascript with unquoted keys, so JSON.parse often fails — fall back to regex.
function extractWindowByRegex(text, windowKey, kind, windowMinutes, nowMs) {
  const pm = new RegExp(windowKey + '[^}]*?usagePercent\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)').exec(text);
  if (!pm) return null;
  const rm = new RegExp(windowKey + '[^}]*?resetInSec\\s*:\\s*([0-9]+)').exec(text);
  const resetSec = rm ? Math.max(0, parseInt(rm[1], 10)) : 0;
  return { kind, usedPercent: round1(clampPct(Number(pm[1]))), used: null, limit: null, resetsAt: new Date(nowMs + resetSec * 1000).toISOString(), windowMinutes };
}

function parseSubscription(text, nowMs) {
  if (String(text).trim().toLowerCase() === 'null') return { windows: [], balanceUsd: null };
  const windows = [];
  let balanceUsd = null;
  try {
    const root = JSON.parse(text);
    if (root !== null) {
      const w1 = parseWindowObj(findByKeyword(root, 'rolling'), 'session', 300, nowMs);
      const w2 = parseWindowObj(findByKeyword(root, 'weekly') || findByKeyword(root, 'week'), 'weekly', 10080, nowMs);
      if (w1) windows.push(w1);
      if (w2) windows.push(w2);
      balanceUsd = findBalance(root);
    }
  } catch (_) { /* text/javascript -> regex */ }
  if (windows.length === 0) {
    const r1 = extractWindowByRegex(text, 'rollingUsage', 'session', 300, nowMs);
    const r2 = extractWindowByRegex(text, 'weeklyUsage', 'weekly', 10080, nowMs);
    if (r1) windows.push(r1);
    if (r2) windows.push(r2);
  }
  if (balanceUsd == null) {
    const bm = /(?:balanceUSD|currentBalance|zenBalance|balanceUsd)[^0-9-]{0,20}([0-9]+(?:\.[0-9]+)?)/i.exec(text);
    if (bm) balanceUsd = Number(bm[1]);
  }
  return { windows, balanceUsd };
}

function looksSignedOut(text) {
  const l = String(text).toLowerCase();
  return l.includes('login') || l.includes('sign in') || l.includes('auth/authorize')
    || l.includes('not associated with an account') || l.includes('actor of type "public"');
}

// Accept a raw `wrk_…` id or a `https://opencode.ai/workspace/<id>/…` URL.
function normalizeWorkspaceId(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const m = text.match(/wrk_[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

async function fetchServerText(req, cookieHeader, deps) {
  const doFetch = deps.fetch || globalThis.fetch;
  const url = serverRequestUrl(req.serverId, req.args, req.method);
  const headers = buildHeaders(req.serverId, cookieHeader, req.referer);
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && Array.isArray(req.args)) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(req.args);
  }
  const res = await doFetch(url, init);
  const text = await res.text();
  return { status: res.status, text };
}

// Resolves the active workspace id from the opencode.ai session. Expects an
// already-sanitized, non-empty cookie header. Honors a deps.workspaceId / env
// override. Returns { status: 'ok' | 'unauthorized' | 'unavailable', workspaceId }.
// Network errors are left to throw — callers wrap in try/catch.
async function resolveWorkspaceId(cookie, deps = {}) {
  const override = normalizeWorkspaceId(deps.workspaceId || (deps.env || process.env).TOKEN_MONITOR_OPENCODE_WORKSPACE_ID);
  if (override) return { status: 'ok', workspaceId: override };
  let wsText = await fetchServerText({ serverId: WORKSPACES_SERVER_ID, args: null, method: 'GET', referer: BASE_URL }, cookie, deps);
  if (wsText.status === 401 || wsText.status === 403 || looksSignedOut(wsText.text)) return { status: 'unauthorized', workspaceId: '' };
  let ids = parseWorkspaceIds(wsText.text);
  if (ids.length === 0) {
    wsText = await fetchServerText({ serverId: WORKSPACES_SERVER_ID, args: [], method: 'POST', referer: BASE_URL }, cookie, deps);
    if (looksSignedOut(wsText.text)) return { status: 'unauthorized', workspaceId: '' };
    ids = parseWorkspaceIds(wsText.text);
  }
  if (ids.length === 0) return { status: 'unavailable', workspaceId: '' };
  return { status: 'ok', workspaceId: ids[0] };
}

async function fetchZen(cookieRaw, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const cookie = sanitizeCookieHeader(cookieRaw);
  if (!cookie) return { status: 'notConfigured', windows: [], balanceUsd: null };

  const fail = (status) => ({ status, windows: [], balanceUsd: null });
  try {
    const ws = await resolveWorkspaceId(cookie, deps);
    if (ws.status !== 'ok') return fail(ws.status);
    const workspaceId = ws.workspaceId;

    const referer = `${BASE_URL}/workspace/${workspaceId}/billing`;
    const badSubStatus = (r) => {
      if (r.status === 429) return 'sourceRateLimited';
      if (r.status === 401 || r.status === 403 || looksSignedOut(r.text)) return 'unauthorized';
      return null;
    };
    const isExplicitNull = (t) => String(t).trim().toLowerCase() === 'null';

    let subText = await fetchServerText({ serverId: SUBSCRIPTION_SERVER_ID, args: [workspaceId], method: 'GET', referer }, cookie, deps);
    let bad = badSubStatus(subText);
    if (bad) return fail(bad);
    let parsed = parseSubscription(subText.text, nowMs);
    // Retry with POST only when GET yielded nothing AND wasn't an explicit `null` payload
    // (an explicit null means "this workspace has no subscription data" — a POST would return the same).
    if (parsed.windows.length === 0 && parsed.balanceUsd == null && !isExplicitNull(subText.text)) {
      subText = await fetchServerText({ serverId: SUBSCRIPTION_SERVER_ID, args: [workspaceId], method: 'POST', referer }, cookie, deps);
      bad = badSubStatus(subText);
      if (bad) return fail(bad);
      parsed = parseSubscription(subText.text, nowMs);
    }
    return { status: 'ok', workspaceId, windows: parsed.windows, balanceUsd: parsed.balanceUsd };
  } catch (_) {
    return fail('unavailable');
  }
}

// --- OpenCode Go usage page (real server-side limits) -----------------------
// CodexBar reference: docs/opencode.md + OpenCodeGoUsageFetcher.swift.
// The /workspace/<id>/go page embeds rollingUsage/weeklyUsage/monthlyUsage,
// each { usagePercent, resetInSec }. Try JSON first, then regex (the page is
// often text/javascript with unquoted keys).

const GO_WINDOW_MINUTES = { session: 300, weekly: 10080, monthly: 43200 };

function extractGoWindow(text, key, kind, nowMs) {
  const pm = new RegExp(key + '[^}]*?usagePercent\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)').exec(text);
  if (!pm) return null;
  const rm = new RegExp(key + '[^}]*?resetInSec\\s*[:=]\\s*([0-9]+)').exec(text);
  const resetSec = rm ? Math.max(0, parseInt(rm[1], 10)) : 0;
  return {
    kind,
    usedPercent: round1(clampPct(Number(pm[1]))),
    used: null,
    limit: null,
    resetsAt: new Date(nowMs + resetSec * 1000).toISOString(),
    windowMinutes: GO_WINDOW_MINUTES[kind]
  };
}

function parseGoUsageJson(text, nowMs) {
  let root;
  try { root = JSON.parse(text); } catch (_) { return []; }
  if (!root || typeof root !== 'object') return [];
  const rolling = parseWindowObj(findByKeyword(root, 'rolling'), 'session', GO_WINDOW_MINUTES.session, nowMs);
  const weekly = parseWindowObj(findByKeyword(root, 'weekly') || findByKeyword(root, 'week'), 'weekly', GO_WINDOW_MINUTES.weekly, nowMs);
  const monthly = parseWindowObj(findByKeyword(root, 'monthly') || findByKeyword(root, 'month'), 'monthly', GO_WINDOW_MINUTES.monthly, nowMs);
  if (!rolling || !weekly) return [];
  const windows = [rolling, weekly];
  if (monthly) windows.push(monthly);
  return windows;
}

// Parses session/weekly(/monthly) windows from the go page. session+weekly are
// required; monthly is optional. Returns [] when the required windows are absent.
function parseGoUsage(text, nowMs) {
  const fromJson = parseGoUsageJson(text, nowMs);
  if (fromJson.length > 0) return fromJson;
  const rolling = extractGoWindow(text, 'rollingUsage', 'session', nowMs);
  const weekly = extractGoWindow(text, 'weeklyUsage', 'weekly', nowMs);
  if (!rolling || !weekly) return [];
  const monthly = extractGoWindow(text, 'monthlyUsage', 'monthly', nowMs);
  const windows = [rolling, weekly];
  if (monthly) windows.push(monthly);
  return windows;
}

async function fetchGoPageText(workspaceId, cookieHeader, deps) {
  const doFetch = deps.fetch || globalThis.fetch;
  const url = `${BASE_URL}/workspace/${workspaceId}/go`;
  const res = await doFetch(url, {
    method: 'GET',
    headers: {
      Cookie: cookieHeader,
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  const text = await res.text();
  return { status: res.status, text };
}

// Fetches the real OpenCode Go limits from the dashboard page. Returns
// { status, windows, workspaceId }. workspaceId is included even on a post-
// resolution failure so the caller can reuse it for the Zen request.
async function fetchGoWeb(cookieRaw, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const cookie = sanitizeCookieHeader(cookieRaw);
  if (!cookie) return { status: 'notConfigured', windows: [], workspaceId: '' };
  const fail = (status, workspaceId = '') => ({ status, windows: [], workspaceId });
  try {
    const ws = await resolveWorkspaceId(cookie, deps);
    if (ws.status !== 'ok') return fail(ws.status);
    const workspaceId = ws.workspaceId;
    const page = await fetchGoPageText(workspaceId, cookie, deps);
    if (page.status === 429) return fail('sourceRateLimited', workspaceId);
    if (page.status === 401 || page.status === 403 || looksSignedOut(page.text)) return fail('unauthorized', workspaceId);
    if (page.status !== 200) return fail('unavailable', workspaceId);
    const windows = parseGoUsage(page.text, nowMs);
    if (windows.length === 0) return fail('unavailable', workspaceId);
    return { status: 'ok', windows, workspaceId };
  } catch (_) {
    return fail('unavailable');
  }
}

// Summarizes what a single opencode.ai cookie unlocks, from the two probe
// results. The cookie is always "linked" (this is only called when one is set);
// `expired` means BOTH sources rejected it as unauthorized. `go`/`zen` flag
// whether real usage / Zen data was actually returned (not just reachable).
function summarizeLink(go = {}, zen = {}) {
  const goOk = go.status === 'ok';
  const zenOk = zen.status === 'ok';
  const hasBalance = typeof zen.balanceUsd === 'number' && Number.isFinite(zen.balanceUsd);
  if (goOk || zenOk) {
    return {
      linked: true,
      expired: false,
      go: goOk && (go.windows || []).length > 0,
      zen: zenOk && (hasBalance || (zen.windows || []).length > 0),
      hasBalance
    };
  }
  if (go.status === 'unauthorized' && zen.status === 'unauthorized') {
    return { linked: true, expired: true, go: false, zen: false, hasBalance: false };
  }
  return { linked: true, expired: false, go: false, zen: false, hasBalance: false, error: go.status || zen.status || 'unavailable' };
}

module.exports = {
  BASE_URL, SERVER_URL, WORKSPACES_SERVER_ID, SUBSCRIPTION_SERVER_ID,
  sanitizeCookieHeader, serverRequestUrl, buildHeaders,
  parseWorkspaceIds, parseSubscription, fetchZen, normalizeWorkspaceId,
  resolveWorkspaceId, fetchGoWeb, parseGoUsage, summarizeLink
};
