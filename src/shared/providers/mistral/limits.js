'use strict';

const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus, providerStatusFromError, statusForHttp } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const ADMIN = 'https://admin.mistral.ai';
const VIBE_URL = 'https://console.mistral.ai/api-ui/trpc/billing.vibeUsage?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%7D';

function mistralCookie(env = process.env, options = {}) {
  const value = options.mistralCookie || env.TOKEN_MONITOR_MISTRAL_COOKIE || env.MISTRAL_COOKIE || '';
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return '';
  const pairs = value.trim().replace(/^cookie\s*:\s*/iu, '').split(';').map((part) => part.trim());
  if (pairs.some((part) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/u.test(part))
    || !pairs.some((part) => /^ory_session_[^=]+=.+$/u.test(part))) return '';
  return pairs.join('; ');
}

function resetTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function budgetWindow(raw, label) {
  if (!raw || typeof raw.usage_percentage !== 'number' || !Number.isFinite(raw.usage_percentage) || raw.usage_percentage < 0
    || typeof raw.initial_budget !== 'number' || !Number.isFinite(raw.initial_budget) || raw.initial_budget <= 0
    || typeof raw.currency !== 'string' || !/^[A-Z]{3}$/u.test(raw.currency.trim().toUpperCase())) return null;
  const used = raw.initial_budget * raw.usage_percentage / 100;
  if (!Number.isFinite(used)) return null;
  return { kind: 'monthly', label, usedPercent: raw.usage_percentage, used, limit: raw.initial_budget,
    remaining: Math.max(0, raw.initial_budget - used), currency: raw.currency.trim().toUpperCase(), resetsAt: resetTime(raw.reset_at) };
}

// Locate JSON containers without evaluating the page's JavaScript.
function jsonEnd(text, start) {
  const stack = [];
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') stack.push(char === '[' ? ']' : '}');
    else if (char === ']' || char === '}') {
      if (stack.pop() !== char) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

function parseMistralSubscription(html) {
  const chunks = [];
  const marker = /self\.__next_f\.push\(\s*(?=\[)/gu;
  while (marker.exec(html)) {
    const end = jsonEnd(html, marker.lastIndex);
    if (end < 0) continue;
    const chunk = JSON.parse(html.slice(marker.lastIndex, end));
    if (chunk[0] === 1 && typeof chunk[1] === 'string') chunks.push(chunk[1]);
    marker.lastIndex = end;
  }
  const stream = Buffer.from(chunks.join(''), 'utf8');
  const matches = new Map();
  const visit = (root) => {
    const pending = [root];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      if (value.budget) {
        const windows = [budgetWindow(value.budget.api_budget, 'Included API'), budgetWindow(value.budget.vibe_budget, 'Included Vibe Code')].filter(Boolean);
        if (windows.length) matches.set(JSON.stringify(windows), windows);
      }
      pending.push(...Object.values(value));
    }
  };
  for (let cursor = 0; cursor < stream.length;) {
    const newline = stream.indexOf(10, cursor);
    const end = newline < 0 ? stream.length : newline;
    const line = stream.toString('utf8', cursor, end);
    const row = /^[\da-f]+:([\s\S]*)$/iu.exec(line);
    if (row && /^[TAOoUSsLlGgMmV]/u.test(row[1])) {
      // Flight text/binary payload lengths are UTF-8 bytes, and may contain
      // apparent JSON records. Skip the entire payload rather than scanning it.
      const length = /^[\da-f]+:[TAOoUSsLlGgMmV]([\da-f]+),/iu.exec(line);
      if (!length) throw errorWithStatus('unavailable', 'Invalid Mistral Flight record');
      const size = Number.parseInt(length[1], 16);
      const next = cursor + Buffer.byteLength(length[0]) + size;
      if (!Number.isSafeInteger(size) || next > stream.length) throw errorWithStatus('unavailable', 'Truncated Mistral Flight record');
      cursor = next;
      continue;
    }
    if (row && (row[1].startsWith('[') || row[1].startsWith('{'))) visit(JSON.parse(row[1]));
    cursor = end + 1;
  }
  if (matches.size !== 1) throw errorWithStatus('unavailable', 'Missing or ambiguous Mistral budgets');
  return [...matches.values()][0];
}

function parseMistralVibe(data) {
  const usage = data?.[0]?.result?.data?.json;
  if (typeof usage?.usage_percentage !== 'number' || !Number.isFinite(usage.usage_percentage)
    || usage.usage_percentage < 0 || usage.usage_percentage > 100) throw errorWithStatus('unavailable', 'Invalid Mistral Vibe usage');
  return { kind: 'monthly', label: 'Included Vibe Code', usedPercent: usage.usage_percentage, resetsAt: resetTime(usage.reset_at) };
}

function parseMistralCredits(data) {
  const amount = (value) => typeof value === 'number' && Number.isFinite(value);
  if (!amount(data?.wallet_amount) || (data.credit_notes_amount != null && !amount(data.credit_notes_amount))
    || (data.ongoing_usage_balance != null && !amount(data.ongoing_usage_balance))
    || typeof data.currency !== 'string' || !/^[a-z]{3}$/iu.test(data.currency.trim())) throw errorWithStatus('unavailable', 'Invalid Mistral credits');
  const remaining = data.wallet_amount + (data.credit_notes_amount ?? 0) - (data.ongoing_usage_balance ?? 0);
  if (!Number.isFinite(remaining)) throw errorWithStatus('unavailable', 'Invalid Mistral credit total');
  return { kind: 'billing', metric: 'credits', label: 'Balance', remaining, currency: data.currency.trim().toUpperCase(), showMeter: false };
}

async function fetchMistralLimits(options = {}, deps = {}) {
  const base = { provider: 'mistral', source: 'web', updatedAt: new Date((deps.now || Date.now)()).toISOString(), windows: [] };
  const cookie = mistralCookie(deps.env || process.env, options);
  if (!cookie) return normalizeLimitProvider({ ...base, status: 'notConfigured' });
  try {
    const windows = await runWithProbeDeadline(async ({ signal }) => {
      const pairs = cookie.split('; ');
      const csrf = pairs.find((pair) => pair.startsWith('csrftoken='))?.slice('csrftoken='.length);
      const request = (url, consoleRequest = false) => runWithProbeDeadline(async ({ signal }) => {
        signal.throwIfAborted();
        const response = await (deps.fetch || fetch)(url, {
          signal, credentials: 'omit', redirect: 'manual',
          headers: { Accept: url.endsWith('/subscription') ? 'text/html' : 'application/json',
            'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': BROWSER_USER_AGENT,
            Cookie: consoleRequest ? pairs.filter((pair) => /^(?:csrftoken|ory_session_[^=]+)=/u.test(pair)).join('; ') : cookie,
            ...(csrf ? { 'X-CSRFTOKEN': csrf } : {}) }
        });
        signal.throwIfAborted();
        if (!response.ok) {
          const challenge = response.headers?.get?.('cf-mitigated') === 'challenge';
          const redirect = response.status >= 300 && response.status < 400;
          throw errorWithStatus(challenge ? 'unavailable' : redirect ? 'unauthorized' : statusForHttp(response.status), 'Mistral request rejected');
        }
        return url.endsWith('/subscription') ? response.text() : response.json();
      }, { signal, deadlineMs: deps.mistralRequestTimeoutMs || 4000 });
      const results = await Promise.allSettled([
        request(`${ADMIN}/subscription`).then(parseMistralSubscription),
        request(`${ADMIN}/api/billing/credits`).then((data) => [parseMistralCredits(data)])
      ]);
      const windows = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
      if (csrf && !windows.some((window) => window.label === 'Included Vibe Code')) {
        try { windows.push(parseMistralVibe(await request(VIBE_URL, true))); }
        catch (error) { results.push({ status: 'rejected', reason: error }); }
      }
      signal.throwIfAborted();
      if (!windows.length) {
        const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
        throw failures.find((error) => error?.status === 'unauthorized')
          || failures.find((error) => error?.status === 'sourceRateLimited') || failures[0];
      }
      return windows;
    }, { signal: deps.signal, deadlineMs: deps.mistralFetchTimeoutMs || 15000 });
    // These responses expose no verified cross-device account id. A session
    // cookie rotates, so it must not be promoted to a stable account identity.
    return normalizeLimitProvider({ ...base, windows, status: 'ok' });
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    return normalizeLimitProvider({ ...base, status: providerStatusFromError(error) });
  }
}

module.exports = { mistralCookie, fetchMistralLimits, parseMistralSubscription, parseMistralVibe, parseMistralCredits };
