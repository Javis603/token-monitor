'use strict';

// Official balance anchors for WorkBuddy. Every successful collection writes
// the provider's own remaining Credits for that local day. The quota-history
// curve uses these as exact points; the gaps between them are filled from the
// provider's per-request billing ledger (see historySeries.js), so a day on
// which Token Monitor was closed still has a real spend figure behind it.
//
// This store never holds a derived or sampled value: it is only a cache of
// answers the billing API already gave us.

const path = require('node:path');
const { sharedDataDir, readJson, writeJsonAtomic } = require('../../config');

const STORE_VERSION = 1;
const STORE_FILE = 'workbuddy-balance-v1.json';
const RETENTION_DAYS = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function localDayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Local noon keeps every day inside its own bucket in every timezone (a UTC
// midnight would fall on the previous local day west of Greenwich).
function dayKeyToAt(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getTime();
  return Number.isFinite(at) ? at : null;
}

function storePathFor(deps) {
  const env = deps.env || process.env;
  const dir = deps.workbuddyAnchorDir || sharedDataDir({ env });
  return deps.workbuddyAnchorStorePath || path.join(dir, STORE_FILE);
}

function loadStore(storePath, deps) {
  const read = deps.readJson || readJson;
  const raw = read(storePath, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || raw.version !== STORE_VERSION || !raw.accounts
    || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) {
    return { version: STORE_VERSION, accounts: {} };
  }
  return raw;
}

function pruneDays(days, now) {
  const cutoff = startOfLocalDay(now) - (RETENTION_DAYS - 1) * DAY_MS;
  const kept = {};
  for (const [day, entry] of Object.entries(days || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const at = dayKeyToAt(day);
    const remaining = Number(entry.remaining);
    if (at === null || at < cutoff || !Number.isFinite(remaining) || remaining < 0) continue;
    kept[day] = {
      at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : at,
      remaining: round2(remaining)
    };
  }
  return kept;
}

// Up to four WorkBuddy accounts are collected concurrently. Serialise writes
// to one store path so a stale read-modify-write snapshot cannot drop another
// account's anchor.
const writeQueues = new Map();
function serialWrite(storePath, task) {
  const previous = writeQueues.get(storePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  writeQueues.set(storePath, next);
  const clear = () => { if (writeQueues.get(storePath) === next) writeQueues.delete(storePath); };
  next.then(clear, clear);
  return next;
}

function readAnchors(accountKey, now, deps = {}) {
  if (!accountKey) return {};
  const store = loadStore(storePathFor(deps), deps);
  return pruneDays(store.accounts[accountKey]?.days, Number(now));
}

function recordAnchor({ accountKey, remaining, now }, deps = {}) {
  const storePath = storePathFor(deps);
  const value = Number(remaining);
  const nowMs = Number(now);
  if (!accountKey || !Number.isFinite(value) || value < 0
    || !Number.isFinite(new Date(nowMs).getTime())) return Promise.resolve(null);
  return serialWrite(storePath, () => {
    const write = deps.writeJsonAtomic || writeJsonAtomic;
    const store = loadStore(storePath, deps);
    const entry = store.accounts[accountKey] || (store.accounts[accountKey] = { days: {} });
    const days = pruneDays(entry.days, nowMs);
    days[localDayKey(nowMs)] = { at: nowMs, remaining: round2(value) };
    entry.days = days;
    write(storePath, store);
    return days;
  });
}

module.exports = {
  readAnchors,
  recordAnchor,
  localDayKey,
  startOfLocalDay,
  dayKeyToAt,
  round2,
  storePathFor
};
