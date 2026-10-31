'use strict';

// Subscription action discovery adapted from CodexBar (MIT); see LICENSE here.

const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus, statusForHttp } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');

const ORIGIN = 'https://muse.ai';
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

function normalizeMuseaiCookieHeader(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return '';
  const raw = value.trim().replace(/^cookie\s*:\s*/iu, '');
  const pairs = raw.split(';').map((part) => part.trim());
  if (!pairs.length || pairs.some((part) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/u.test(part))) return '';
  return pairs.join('; ');
}

function museaiCookie(env = process.env, options = {}) {
  return normalizeMuseaiCookieHeader(options.museaiCookie || env.TOKEN_MONITOR_MUSEAI_COOKIE || env.MUSEAI_COOKIE || '');
}

function invalidResponse() {
  return errorWithStatus('unavailable', 'Muse subscription response changed');
}

function parseMuseaiSubscription(text) {
  let sub;
  for (const line of text.split('\n')) {
    const match = /^[0-9a-f]+:(\{.*\})\s*$/u.exec(line);
    if (!match) continue;
    try {
      const row = JSON.parse(match[1]);
      if (row.success === true) sub = row.subscription;
    } catch { /* Other Flight rows are not subscription data. */ }
  }
  const percent = sub?.usage?.percentUsed;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) throw invalidResponse();
  const resetsAt = sub.usage.resetsAt;
  if (typeof resetsAt !== 'number' || resetsAt <= 0 || !Number.isFinite(new Date(resetsAt * 1000).getTime())) throw invalidResponse();
  const tokensLeft = (label) => typeof label === 'string' ? /\(([^()]+ tokens left)\)/u.exec(label)?.[1] || '' : '';
  const windows = [{
    kind: 'weekly', label: 'Weekly', usedPercent: percent,
    windowMinutes: 10080, resetsAt: new Date(resetsAt * 1000).toISOString(),
    resetDescription: tokensLeft(sub.usageRowValueLabel)
  }];
  // Top-ups are micro-dollars, not raw token counts or part of the weekly quota.
  if (Number.isFinite(sub.topupBalance) && sub.topupBalance >= 0 && Number.isFinite(sub.topupTotal) && sub.topupTotal > 0) {
    windows.push({
      kind: 'billing', metric: 'credits', label: 'Additional balance',
      remaining: sub.topupBalance / 1e6, currency: 'USD', showMeter: false,
      resetDescription: tokensLeft(sub.topupRowValueLabel)
    });
  }
  return { planLabel: typeof sub.tier?.name === 'string' ? sub.tier.name : '', windows };
}

const chunkPaths = (text) => [...new Set((text.match(/static\/chunks\/[\w~.-]+\.js/gu) || []).map((path) => `/_next/${path}`))];

async function fetchMuseaiLimits(options = {}, deps = {}) {
  const base = { provider: 'museai', source: 'web', updatedAt: new Date((deps.now || Date.now)()).toISOString(), windows: [] };
  const cookie = museaiCookie(deps.env || process.env, options);
  if (!cookie) return normalizeLimitProvider({ ...base, status: 'notConfigured' });
  // No portable account identity is present in this response. The limits core
  // keeps observations on different devices separate rather than hashing cookies.
  const state = deps.providerRuntimeState;
  const cacheKey = 'museai:actionID';
  try {
    const parsed = await runWithProbeDeadline(async ({ signal }) => {
      const request = async (path, init = {}) => {
        signal.throwIfAborted();
        const response = await (deps.museaiFetch || deps.fetch || fetch)(`${ORIGIN}${path}`, {
          ...init, headers: { 'User-Agent': BROWSER_USER_AGENT, ...init.headers },
          credentials: 'omit', redirect: 'manual', signal
        });
        signal.throwIfAborted();
        const location = response.headers?.get?.('location') || '';
        if (init.headers?.Cookie && (response.status === 401 || response.status === 403 || location.startsWith('https://auth.muse.ai/'))) {
          const challenge = response.headers?.get?.('cf-mitigated') === 'challenge';
          throw errorWithStatus(challenge ? 'unavailable' : 'unauthorized', 'Muse session rejected');
        }
        return { status: response.status, text: await response.text() };
      };
      const chunks = async (paths) => Promise.all(paths.map(async (path) => {
        const response = await request(path, { headers: { Accept: '*/*' } });
        if (response.status !== 200) throw invalidResponse();
        return response.text;
      }));
      const discover = async () => {
        const page = await request('/', { headers: { Cookie: cookie, Accept: 'text/html' } });
        if (page.status !== 200) throw errorWithStatus(statusForHttp(page.status), 'Muse page unavailable');
        const paths = chunkPaths(page.text).slice(0, 96);
        let text = '';
        for (let i = 0; i < paths.length; i += 8) {
          text += '\n' + (await chunks(paths.slice(i, i + 8))).join('\n');
          if (text.length > 8 * 1024 * 1024) throw invalidResponse();
          const moduleId = /\.A\((\d+)\)\.then\(\(\{[^}]*Settings/u.exec(text)?.[1];
          const loader = moduleId && new RegExp(`[,{\\[]${moduleId},\\w+=>\\{\\w+\\.v\\(\\w+=>Promise\\.all\\(\\[([^\\]]*)`).exec(text);
          if (!loader) continue;
          const settingsPaths = chunkPaths(loader[1]).slice(0, 32);
          for (let j = 0; j < settingsPaths.length; j += 8) {
            for (const body of await chunks(settingsPaths.slice(j, j + 8))) {
              const id = /"([0-9a-f]{40,})",[^"]{0,200}"fetchSubscriptionAction"/u.exec(body)?.[1];
              if (id) return id;
            }
          }
          break;
        }
        throw invalidResponse();
      };
      const post = (id) => request('/', {
        method: 'POST', body: JSON.stringify([{ includeAgreement: true }]),
        headers: {
          Cookie: cookie, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8',
          'Next-Action': id, Origin: ORIGIN,
          'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'
        }
      });
      let actionID = state?.get(cacheKey);
      let response = actionID ? await post(actionID) : null;
      if (!response || (response.status === 404 && /server action not found/iu.test(response.text))) {
        state?.delete(cacheKey);
        actionID = await discover();
        response = await post(actionID);
      }
      if (response.status !== 200) throw errorWithStatus(statusForHttp(response.status), 'Muse subscription unavailable');
      const result = parseMuseaiSubscription(response.text);
      signal.throwIfAborted();
      state?.set(cacheKey, actionID);
      return result;
    }, { signal: deps.signal, deadlineMs: deps.museaiFetchTimeoutMs || 20000 });
    return normalizeLimitProvider({ ...base, ...parsed, status: 'ok' });
  } catch (error) {
    return normalizeLimitProvider({ ...base, status: ['unauthorized', 'sourceRateLimited'].includes(error?.status) ? error.status : 'unavailable' });
  }
}

module.exports = { normalizeMuseaiCookieHeader, museaiCookie, parseMuseaiSubscription, fetchMuseaiLimits };
