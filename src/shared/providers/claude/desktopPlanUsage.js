'use strict';

// Claude Desktop's own quota samples, read from disk. Zero-network limits
// source for the claude provider.
//
// While it runs, Claude Desktop samples the signed-in organization's plan
// utilisation into `<userData>/plan-usage-history.json` (every few minutes,
// roughly 30 days retained) and that file matches Settings → Usage. Observed
// shape, undocumented by Anthropic:
//
//   { "version": 2, "samples": [ { "t": <epoch ms>, "org": "<uuid>",
//                                  "u": { "fh": 42, "sd": 67, ... } } ] }
//
// `fh` is the five-hour session window and `sd` the seven-day all-models
// window, both as percentages. The seven-day window resets every Tuesday at
// 10:00 Asia/Taipei. Other `u` keys exist but their meaning is not
// established, so they are surfaced to diagnostics only and never mapped onto a
// window. Because the format is private the reader is deliberately tolerant: a
// half-written file is salvaged sample by sample, an unknown version is read
// when the samples still look right, and malformed samples are skipped.
//
// Boundaries this module keeps: only node:fs reads (no network module, no
// credential store, no child process), never the IndexedDB/Local Storage or
// any session token, never writes to the Desktop directory.
const fs = require('node:fs');
const path = require('node:path');
const { hashKey } = require('../../hashKey');
const { claudeDesktopUserDataRoots } = require('./desktopPaths');

const PLAN_USAGE_FILE = 'plan-usage-history.json';
const KNOWN_VERSIONS = new Set([2]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const SESSION_WINDOW_MINUTES = 5 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const SESSION_WINDOW_MS = SESSION_WINDOW_MINUTES * 60 * 1000;
// This account's seven-day window resets on a fixed clock, not from the
// moment a prompt was sent. Asia/Taipei is UTC+8 with no daylight-saving shift,
// so Tuesday 10:00 here is always Tuesday 02:00 UTC.
const WEEKLY_RESET_TIME_ZONE = 'Asia/Taipei';
const WEEKLY_RESET_WEEKDAY = 2;
const WEEKLY_RESET_HOUR = 10;
const WEEKLY_RESET_MINUTE = 0;
const WEEKDAY_BY_SHORT_NAME = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
// Desktop samples every ~5 minutes while running; a larger gap means it was
// closed, so a run of samples across that gap cannot date a window start.
const MAX_CONTIGUOUS_GAP_MS = 20 * 60 * 1000;
// A reset is a clear fall, not rounding jitter between two samples.
const RESET_DROP_POINTS = 5;
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[0-9a-f]{8}$/i;
const ACCOUNT_TREES = Object.freeze(['local-agent-mode-sessions', 'claude-code-sessions']);

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function sampleTimeMs(value) {
  const number = finiteNumber(value);
  if (number !== null) {
    if (number <= 0) return null;
    // Seconds are accepted defensively; every observed file uses milliseconds.
    return number < 100_000_000_000 ? Math.round(number * 1000) : Math.round(number);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function normalizeOrgId(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text && text.length <= 128 && /^[0-9a-z_-]+$/.test(text) ? text : '';
}

function normalizeSample(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = sampleTimeMs(raw.t ?? raw.time ?? raw.timestamp);
  if (t === null) return null;
  if (Number.isFinite(nowMs) && t > nowMs + FUTURE_TOLERANCE_MS) return null;
  const usageSource = raw.u ?? raw.usage;
  if (!usageSource || typeof usageSource !== 'object' || Array.isArray(usageSource)) return null;
  const usage = {};
  for (const [key, value] of Object.entries(usageSource)) {
    const number = finiteNumber(value);
    if (number !== null && number >= 0) usage[key] = number;
  }
  if (Object.keys(usage).length === 0) return null;
  return { t, org: normalizeOrgId(raw.org ?? raw.orgId ?? raw.organization), usage };
}

// Complete `{...}` values inside the `samples` array of a truncated document.
// A JSON-aware scan (strings and escapes respected) rather than a regex, so a
// brace inside a string cannot split a sample.
function salvageSampleObjects(text) {
  const keyIndex = text.indexOf('"samples"');
  if (keyIndex < 0) return [];
  const start = text.indexOf('[', keyIndex);
  if (start < 0) return [];
  const objects = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      if (depth === 0 && ch === '{') objectStart = i;
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) break; // end of the samples array
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try { objects.push(JSON.parse(text.slice(objectStart, i + 1))); } catch (_) { /* skip */ }
        objectStart = -1;
      }
    }
  }
  return objects;
}

function parsePlanUsageHistory(text, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const result = { version: null, knownVersion: false, salvaged: false, samples: [], skippedSamples: 0, warnings: [] };
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (!source.trim()) {
    result.warnings.push('empty-file');
    return result;
  }
  let rawSamples = null;
  try {
    const document = JSON.parse(source);
    if (Array.isArray(document)) {
      rawSamples = document;
      result.warnings.push('top-level-array');
    } else if (document && typeof document === 'object') {
      result.version = finiteNumber(document.version);
      rawSamples = Array.isArray(document.samples) ? document.samples : null;
      if (!rawSamples) result.warnings.push('missing-samples');
    } else {
      result.warnings.push('not-an-object');
    }
  } catch (_) {
    // Desktop rewrites the whole file; a reader can land between the truncate
    // and the final write. Keep every sample that is already complete.
    result.salvaged = true;
    result.warnings.push('salvaged-partial-file');
    const version = /"version"\s*:\s*(\d+)/.exec(source);
    result.version = version ? Number(version[1]) : null;
    rawSamples = salvageSampleObjects(source);
  }
  result.knownVersion = result.version !== null && KNOWN_VERSIONS.has(result.version);
  if (result.version !== null && !result.knownVersion) result.warnings.push(`unknown-version:${result.version}`);
  if (result.version === null && rawSamples) result.warnings.push('missing-version');
  const seen = new Set();
  for (const raw of rawSamples || []) {
    const sample = normalizeSample(raw, nowMs);
    if (!sample) { result.skippedSamples += 1; continue; }
    const key = `${sample.org}\u0000${sample.t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.samples.push(sample);
  }
  result.samples.sort((a, b) => a.t - b.t);
  if (result.skippedSamples > 0) result.warnings.push(`skipped-samples:${result.skippedSamples}`);
  return result;
}

function readTextFile(file, fsApi) {
  let fd;
  try {
    fd = fsApi.openSync(file, 'r');
    const stat = fsApi.fstatSync(fd);
    if (!stat.isFile()) return { error: 'not-a-file' };
    if (stat.size > MAX_FILE_BYTES) return { error: 'file-too-large', size: stat.size };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const bytes = fsApi.readSync(fd, buffer, offset, stat.size - offset, offset);
      if (bytes <= 0) break;
      offset += bytes;
    }
    return { text: buffer.toString('utf8', 0, offset), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    return { error: error?.code === 'ENOENT' ? 'missing' : (error?.code || 'read-failed') };
  } finally {
    if (fd !== undefined) {
      try { fsApi.closeSync(fd); } catch (_) { /* already closed */ }
    }
  }
}

function listDirNames(dir, fsApi) {
  try {
    return fsApi.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (_) {
    return [];
  }
}

// Desktop keeps per-session state under `<tree>/<account>/<org>/`, by full
// UUID or by the first eight hex digits. A full pair gives the same stable
// identity the OAuth and Web lanes use, so a local row and a remote row for one
// organization share an account key across devices.
function desktopOrgAccounts(root, fsApi = fs) {
  const accounts = new Map();
  for (const tree of ACCOUNT_TREES) {
    const base = path.join(root, tree);
    for (const account of listDirNames(base, fsApi)) {
      if (!UUID_RE.test(account) && !SHORT_ID_RE.test(account)) continue;
      for (const org of listDirNames(path.join(base, account), fsApi)) {
        if (!UUID_RE.test(org) && !SHORT_ID_RE.test(org)) continue;
        const key = org.toLowerCase();
        const value = account.toLowerCase();
        const previous = accounts.get(key);
        if (!previous || (!UUID_RE.test(previous) && UUID_RE.test(value))) accounts.set(key, value);
      }
    }
  }
  return accounts;
}

function readPlanUsageRoot(rootEntry, options = {}) {
  const fsApi = options.fs || fs;
  const file = path.join(rootEntry.dir, PLAN_USAGE_FILE);
  const read = readTextFile(file, fsApi);
  const entry = { root: rootEntry.dir, variant: rootEntry.variant, file, exists: !read.error || read.error !== 'missing' };
  if (read.error) return { ...entry, error: read.error, samples: [], warnings: [] };
  return { ...entry, mtimeMs: read.mtimeMs, size: read.size, ...parsePlanUsageHistory(read.text, options) };
}

function orgMatches(sampleOrg, filter) {
  if (!filter) return true;
  if (!sampleOrg) return false;
  if (sampleOrg === filter) return true;
  // Desktop's short directory names are UUID prefixes; accept either form.
  return (SHORT_ID_RE.test(filter) && sampleOrg.startsWith(filter))
    || (SHORT_ID_RE.test(sampleOrg) && filter.startsWith(sampleOrg));
}

function zonedParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(ms));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  let hour = Number(value('hour'));
  if (hour === 24) hour = 0;
  const weekday = WEEKDAY_BY_SHORT_NAME[value('weekday')];
  if (weekday === undefined) return null;
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    hour,
    minute: Number(value('minute')),
    second: Number(value('second')),
    weekday
  };
}

function addCalendarDays(parts, days) {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function zonedTimeToUtcMs(year, month, day, hour, minute, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    const parts = zonedParts(utc, timeZone);
    if (!parts) return null;
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const delta = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - asUtc;
    if (delta === 0) return utc;
    utc += delta;
  }
  return null;
}

// Next Tuesday 10:00 Asia/Taipei strictly after `afterMs`. Desktop often writes
// the first post-reset sample long after the boundary; dating the cycle from
// that sample pushes the next reset out by the gap.
function nextWeeklyResetMs(afterMs, timeZone = WEEKLY_RESET_TIME_ZONE) {
  if (!Number.isFinite(afterMs)) return null;
  const parts = zonedParts(afterMs, timeZone);
  if (!parts) return null;
  const deltaDays = (WEEKLY_RESET_WEEKDAY - parts.weekday + 7) % 7;
  let day = addCalendarDays(parts, deltaDays);
  let resetsAt = zonedTimeToUtcMs(day.year, day.month, day.day, WEEKLY_RESET_HOUR, WEEKLY_RESET_MINUTE, timeZone);
  if (resetsAt === null) return null;
  if (resetsAt <= afterMs) {
    day = addCalendarDays(day, 7);
    resetsAt = zonedTimeToUtcMs(day.year, day.month, day.day, WEEKLY_RESET_HOUR, WEEKLY_RESET_MINUTE, timeZone);
  }
  return resetsAt;
}

function estimateWeeklyReset(_samples, latest, timeZone = WEEKLY_RESET_TIME_ZONE) {
  if (!latest || !Number.isFinite(latest.t)) return null;
  return nextWeeklyResetMs(latest.t, timeZone);
}

// The five-hour window opens with the first request after a reset. Only a run
// of contiguous samples that starts right after an observed zero or fall can
// date that opening; anything else (app closed, history too short) is unknown.
function estimateSessionReset(samples, latest) {
  const current = latest.usage.fh;
  if (current === undefined || current <= 0) return null;
  let first = samples.length - 1;
  while (first > 0) {
    const previous = samples[first - 1];
    const sample = samples[first];
    if (previous.usage.fh === undefined || sample.t - previous.t > MAX_CONTIGUOUS_GAP_MS) return null;
    if (previous.usage.fh <= 0 || previous.usage.fh - sample.usage.fh >= RESET_DROP_POINTS) break;
    first -= 1;
  }
  if (first === 0) return null;
  const resetsAt = samples[first].t + SESSION_WINDOW_MS;
  return resetsAt > latest.t ? resetsAt : null;
}

function selectPlanUsage(roots, options = {}) {
  const filter = normalizeOrgId(options.orgId);
  const warnings = [];
  const tagged = [];
  for (const root of roots) {
    for (const sample of root.samples || []) tagged.push({ ...sample, root: root.root, variant: root.variant });
  }
  const firstParty = tagged.filter((sample) => sample.variant !== '3p');
  const pool = firstParty.length > 0 ? firstParty : tagged;
  if (firstParty.length === 0 && tagged.length > 0) warnings.push('third-party-build-only');
  const candidates = pool.filter((sample) => orgMatches(sample.org, filter));
  const orgs = [...new Set(pool.map((sample) => sample.org).filter(Boolean))];
  if (candidates.length === 0) {
    if (filter && pool.length > 0) warnings.push('org-filter-matched-nothing');
    return { selected: null, orgs, warnings };
  }
  candidates.sort((a, b) => a.t - b.t);
  const latest = candidates[candidates.length - 1];
  const org = latest.org;
  if (!filter && orgs.length > 1) warnings.push('multiple-orgs');
  const series = candidates.filter((sample) => sample.org === org && sample.root === latest.root);
  return {
    selected: {
      org,
      root: latest.root,
      variant: latest.variant,
      latest,
      sampleCount: series.length,
      firstSampleAt: series[0]?.t ?? latest.t,
      sessionResetsAt: estimateSessionReset(series, latest),
      weeklyResetsAt: estimateWeeklyReset(series, latest),
      series
    },
    orgs,
    warnings
  };
}

function collectClaudeDesktopPlanUsage(options = {}, deps = {}) {
  const fsApi = deps.fs || fs;
  const nowMs = (deps.now || Date.now)();
  const env = deps.env || process.env;
  const roots = (deps.claudeDesktopRoots || claudeDesktopUserDataRoots({
    homeDir: deps.homeDir, platform: deps.platform, env, fs: fsApi
  })).map((root) => readPlanUsageRoot(root, { fs: fsApi, nowMs }));
  const orgId = options.claudeDesktopOrgId || env.TOKEN_MONITOR_CLAUDE_DESKTOP_ORG_ID || '';
  const choice = selectPlanUsage(roots, { orgId });
  let accountId = '';
  if (choice.selected) {
    const accounts = desktopOrgAccounts(choice.selected.root, fsApi);
    const org = choice.selected.org;
    accountId = accounts.get(org) || [...accounts].find(([key]) => orgMatches(key, org))?.[1] || '';
  }
  return { nowMs, roots, orgFilter: normalizeOrgId(orgId), ...choice, accountId };
}

function accountKeyFor(accountId, orgId) {
  const account = UUID_RE.test(accountId) ? accountId : '';
  const org = UUID_RE.test(orgId) ? orgId : '';
  // Same stable-identity spelling as the OAuth/Web lanes in ./limits.js, so one
  // organization collapses to one row whichever device or lane reported it.
  if (account && org) return hashKey('claude-account', `account:${account}:organization:${org}`);
  if (org) return hashKey('claude-account', `organization:${org}`);
  if (orgId) return hashKey('claude-desktop', `organization:${orgId}`);
  return 'claude-desktop-local';
}

// Provider input for normalizeLimitProvider(). `status: notConfigured` when
// no Desktop history exists on this machine; never an error that would make
// a caller fall back to a network lane.
function claudeDesktopPlanProviderInput(collected) {
  const selected = collected.selected;
  const base = { provider: 'claude', source: 'local', sourceDetail: 'app' };
  if (!selected) {
    const anyFile = collected.roots.some((root) => !root.error);
    return {
      ...base,
      accountKey: 'claude-desktop-local',
      status: anyFile ? 'unavailable' : 'notConfigured',
      updatedAt: new Date(collected.nowMs).toISOString(),
      windows: []
    };
  }
  const usage = selected.latest.usage;
  const windows = [];
  if (usage.fh !== undefined) {
    windows.push({
      kind: 'session',
      usedPercent: usage.fh,
      windowMinutes: SESSION_WINDOW_MINUTES,
      ...(selected.sessionResetsAt ? { resetsAt: selected.sessionResetsAt } : {})
    });
  }
  if (usage.sd !== undefined) {
    windows.push({
      kind: 'weekly',
      usedPercent: usage.sd,
      windowMinutes: WEEKLY_WINDOW_MINUTES,
      ...(selected.weeklyResetsAt ? { resetsAt: selected.weeklyResetsAt } : {})
    });
  }
  return {
    ...base,
    accountKey: accountKeyFor(collected.accountId, selected.org),
    status: windows.length > 0 ? 'ok' : 'unavailable',
    // The sample's own time, not the read time: a closed Desktop app leaves the
    // last reading on disk, and the row has to say how old it is.
    updatedAt: new Date(selected.latest.t).toISOString(),
    windows
  };
}

module.exports = {
  KNOWN_VERSIONS,
  PLAN_USAGE_FILE,
  accountKeyFor,
  claudeDesktopPlanProviderInput,
  collectClaudeDesktopPlanUsage,
  desktopOrgAccounts,
  estimateSessionReset,
  estimateWeeklyReset,
  parsePlanUsageHistory,
  readPlanUsageRoot,
  salvageSampleObjects,
  selectPlanUsage
};
