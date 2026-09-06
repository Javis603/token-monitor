'use strict';

// Helpers shared by more than one limits provider implementation: process and
// JSON transport, plan-label formatting, and the small path/env/hash utilities
// the provider modules all reach for. Provider-specific behaviour does not
// belong here — it belongs in src/shared/providers/<id>/.
//
// This lives beside src/shared/limits.js while the limits infrastructure is
// being folderized. Node resolves require('./limits') to the file, not this
// directory, so the two do not collide.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { appVersion } = require('../appVersion');
const { abortError } = require('../probeDeadline');

const TOKEN_MONITOR_USER_AGENT = `token-monitor/${appVersion()} (+https://github.com/Javis603/token-monitor)`;

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function hashKey(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(String(part || '')).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
}

function envValue(env = {}, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function pathApiForPlatform(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function displayPlanWord(word) {
  const raw = String(word || '');
  const lower = raw.toLowerCase();
  if (['ai', 'api', 'cbp', 'gpt', 'k12'].includes(lower)) return lower.toUpperCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function cleanPlanText(text, prefixes = ['claude', 'chatgpt', 'openai']) {
  const raw = String(text || '').trim();
  if (!raw || raw.includes('@')) return '';
  const prefixPattern = prefixes.length > 0 ? new RegExp(`^(?:${prefixes.join('|')})[\\s_-]+`, 'i') : null;
  let clean = raw;
  while (prefixPattern && prefixPattern.test(clean)) clean = clean.replace(prefixPattern, '');
  return clean
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function displayPlanText(raw, maxWords = 3) {
  const words = String(raw || '').split(/\s+/).filter(Boolean);
  const visible = Number.isFinite(maxWords) ? words.slice(0, maxWords) : words;
  return visible.map(displayPlanWord).join(' ');
}

const PLAN_LABEL_ALIASES = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  teams: 'Team',
  enterprise: 'Enterprise',
  ultra: 'Ultra'
};

function planLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '')).find(Boolean) || '';
  const raw = cleanPlanText(text);
  if (!raw || raw.includes('@')) return '';
  if (PLAN_LABEL_ALIASES[raw]) return PLAN_LABEL_ALIASES[raw];
  return displayPlanText(raw);
}

function runProcessText(command, args = [], options = {}) {
  const spawnFn = options.spawn || spawn;
  const timeoutMs = Number(options.timeoutMs || 30000);
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: Boolean(options.shell),
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const stopChild = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
    };
    const onAbort = () => {
      stopChild();
      finish(reject, abortError(signal));
    };
    const timer = setTimeout(() => {
      stopChild();
      finish(reject, errorWithStatus('unavailable', `${command} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) finish(resolve, stdout);
      else finish(reject, errorWithStatus('unavailable', stderr.trim() || `${command} exited ${code}`));
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function fetchJson(url, headers, deps = {}, options = {}) {
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(url, { headers, ...(controller ? { signal: controller.signal } : {}) });
    if (typeof options.onResponse === 'function') await options.onResponse(response);
    if (!response.ok) {
      const sourceChallenge = response.status === 403
        && String(response.headers?.get?.('cf-mitigated') || '').toLowerCase() === 'challenge';
      const status = response.status === 401
        || (options.forbiddenIsUnauthorized && response.status === 403 && !sourceChallenge)
        ? 'unauthorized'
        : response.status === 429
          ? 'sourceRateLimited'
          : 'unavailable';
      const error = errorWithStatus(status, `${url} returned ${response.status}`);
      // The normalized status collapses 404 and 5xx into `unavailable`, which
      // loses the only thing a caller needs to tell a permanent refusal from an
      // outage. Absent on timeouts and network errors, which are never either.
      error.httpStatus = response.status;
      if (sourceChallenge) error.code = 'CLAUDE_WEB_SOURCE_CHALLENGE';
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', `${url} timed out`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pathDelimiterForPlatform(platform = process.platform) {
  return platform === 'win32' ? ';' : ':';
}

function providerStatusFromError(error) {
  if (['disabled', 'notConfigured', 'unauthorized', 'rateLimited', 'sourceRateLimited', 'unavailable', 'error'].includes(error?.status)) return error.status;
  if (error?.code === 'ENOENT') return 'notConfigured';
  return 'unavailable';
}

module.exports = {
  PLAN_LABEL_ALIASES,
  TOKEN_MONITOR_USER_AGENT,
  cleanPlanText,
  displayPlanText,
  envValue,
  errorWithStatus,
  fetchJson,
  hashKey,
  nowIso,
  parseBoolean,
  pathApiForPlatform,
  pathDelimiterForPlatform,
  planLabelFromParts,
  providerStatusFromError,
  runProcessText,
  uniqueStrings
};
