'use strict';

const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const BASE_URL = 'https://opencode.ai';
const WINDOW_MAP = [['fiveHour', 'session', 300], ['week', 'weekly', 10080], ['month', 'monthly', 43200]];

function normalizeWorkspaceId(raw) {
  const text = String(raw || '').trim();
  if (/^(?:wrk_|org_)[A-Za-z0-9_-]+$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.origin !== BASE_URL) return null;
    const match = /^\/(?:workspace|console)\/((?:wrk_|org_)[A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
    return match?.[1] || null;
  } catch (_) { return null; }
}

function hasCookie(cookie, names) {
  return cookie.split(';').some(pair => {
    const index = pair.indexOf('=');
    return index > 0 && names.includes(pair.slice(0, index).trim()) && pair.slice(index + 1).trim();
  });
}

// A context belongs to one cookie and one refresh, never a process-wide cache.
function createProbeDeps(deps = {}) {
  return { ...deps, opencodeWebContext: {} };
}

function throwIfTerminal(error, signal) {
  signal?.throwIfAborted();
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth += 1) {
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(cause.code || ''))
      || /net::ERR_(?:CERT|SSL|TLS)_/.test(String(cause.message || ''))) throw error;
  }
}

async function request(path, cookie, workspaceId, deps) {
  deps.signal?.throwIfAborted();
  const res = await (deps.fetch || globalThis.fetch)(`${BASE_URL}/console/api/${path}`, {
    method: 'GET', signal: deps.signal, credentials: 'omit', redirect: 'manual',
    headers: { Cookie: cookie, Accept: 'application/json', 'User-Agent': BROWSER_USER_AGENT,
      ...(workspaceId ? { 'x-org-id': workspaceId } : {}) }
  });
  deps.signal?.throwIfAborted();
  if (res.status !== 200) {
    const status = res.status === 401 ? 'unauthorized' : res.status === 429 ? 'sourceRateLimited' : 'unavailable';
    throw Object.assign(new Error('OpenCode Console request failed'), { status });
  }
  const body = JSON.parse(await res.text());
  deps.signal?.throwIfAborted();
  return body;
}

async function resolveWorkspaceId(cookie, deps) {
  const context = deps.opencodeWebContext;
  const override = normalizeWorkspaceId(deps.workspaceId || (deps.env || process.env).TOKEN_MONITOR_OPENCODE_WORKSPACE_ID);
  if (override || context?.workspaceId) return override || context.workspaceId;
  const discover = async () => {
    const rows = await request('orgs', cookie, '', deps);
    const id = Array.isArray(rows) && rows.map(row => normalizeWorkspaceId(row?.id)).find(Boolean);
    if (!id) throw new Error('OpenCode Console workspace missing');
    if (context) context.workspaceId = id;
    return id;
  };
  if (!context) return discover();
  context.consoleWorkspace ||= discover();
  return context.consoleWorkspace;
}

function integer(value, signed = false) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && (signed || value >= 0) ? value : null;
  if (typeof value !== 'string' || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function parseGoStatus(body) {
  if (body === null || body?.access === null) return { status: 'notConfigured', entitled: false, windows: [] };
  const access = body?.access;
  const meters = access?.meters;
  if (!meters?.fiveHour) throw new Error('OpenCode Console meters missing');
  const windows = [];
  for (const [key, kind, windowMinutes] of WINDOW_MAP) {
    const meter = meters[key];
    if (meter == null && key !== 'fiveHour') continue;
    const used = integer(meter?.usedMicroCents);
    const limit = integer(meter?.limitMicroCents);
    if (used === null || limit === null || limit <= 0) throw new Error('OpenCode Console meter invalid');
    windows.push({ kind, windowMinutes, used: null, limit: null,
      usedPercent: Math.round(Math.max(0, Math.min(100, used / limit * 100)) * 10) / 10,
      resetsAt: timestamp(meter.resetsAt) || (key === 'month' ? timestamp(access.endsAt) : '') });
  }
  return { status: 'ok', windows };
}

function parseBillingStatus(body) {
  if (!['prepaid', 'legacy', 'seat', 'credit'].includes(body?.billingMode)
    || !['pay-as-you-go', 'invoiceable'].includes(body?.mode)) throw new Error('OpenCode Console billing invalid');
  if (body.billingMode !== 'prepaid' || body.mode !== 'pay-as-you-go') {
    return { status: 'notConfigured', windows: [], balanceUsd: null };
  }
  // This is a balance, not the available credit line or the Go monthly grant.
  const balance = typeof body.balanceMicroCents === 'string' ? integer(body.balanceMicroCents, true) : null;
  if (balance === null) throw new Error('OpenCode Console balance missing');
  return { status: 'ok', windows: [], balanceUsd: balance / 100000000 };
}

async function fetchConsole(kind, cookie, deps) {
  const workspaceId = await resolveWorkspaceId(cookie, deps);
  const body = await request(kind === 'go' ? 'go/status' : 'billing/status', cookie, workspaceId, deps);
  return { ...(kind === 'go' ? parseGoStatus(body) : parseBillingStatus(body)), workspaceId };
}

module.exports = { normalizeWorkspaceId, hasCookie, createProbeDeps, throwIfTerminal, fetchConsole };
