'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { accountEmailHash, normalizeQuotaLink } = require('./occupancyQuota');

const STORE_VERSION = 2;
const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;
const MIN_LEASE_TTL_MS = 5 * 1000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECENT_TASKS = 200;

class OccupancyError extends Error {
  constructor(code, statusCode = 400, message = code) {
    super(message);
    this.name = 'OccupancyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requiredString(value, field, maxLength = 200) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new OccupancyError(`${field}_required`, 400);
  if (normalized.length > maxLength) throw new OccupancyError(`${field}_too_long`, 400);
  return normalized;
}

function optionalString(value, field, maxLength = 500) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  if (normalized.length > maxLength) throw new OccupancyError(`${field}_too_long`, 400);
  return normalized;
}

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new OccupancyError(`${field}_invalid`, 400);
  }
  return normalized;
}

function leaseTtl(value, fallback = DEFAULT_LEASE_TTL_MS) {
  const ttlMs = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
    throw new OccupancyError('ttlMs_invalid', 400);
  }
  return ttlMs;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function quotaLinkInput(value, { stored = false } = {}) {
  if (value === undefined || value === null) return null;
  const source = asObject(value);
  const provider = String(source.provider || '').trim().toLowerCase();
  const normalized = {
    ...source,
    accountEmailHash: source.accountEmailHash || accountEmailHash(provider, source.accountEmail)
  };
  delete normalized.accountEmail;
  try { return normalizeQuotaLink(normalized); }
  catch (error) {
    if (stored) return null;
    throw new OccupancyError(error.message || 'quotaLink_invalid', 400);
  }
}

function accountLight(activeCount, maxConcurrent) {
  if (activeCount === 0) return 'green';
  if (activeCount >= maxConcurrent) return 'red';
  return 'yellow';
}

function fenceTokenHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeFenceToken(value, { required = true } = {}) {
  const token = optionalString(value, 'fenceToken', 500);
  if (!token && required) throw new OccupancyError('fence_token_required', 400);
  if (token && token.length < 16) throw new OccupancyError('fence_token_invalid', 400);
  return token;
}

function assertFenceToken(lease, value) {
  const token = normalizeFenceToken(value);
  const actual = Buffer.from(fenceTokenHash(token), 'hex');
  const expected = Buffer.from(String(lease.fenceTokenHash || ''), 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new OccupancyError('fence_token_invalid', 409);
  }
  return token;
}

function normalizeSource(value) {
  const aliases = { cli: 'wrapper', 'manual-cli': 'manual' };
  const raw = optionalString(value, 'source', 20) || 'manual';
  const source = aliases[raw] || raw;
  if (!['manual', 'wrapper', 'detector', 'hook', 'sdk'].includes(source)) {
    throw new OccupancyError('source_invalid', 400);
  }
  return source;
}

function normalizeConfidence(value, source) {
  const confidence = value === undefined ? (source === 'detector' ? 0.5 : 1) : Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new OccupancyError('confidence_invalid', 400);
  }
  return confidence;
}

function presentAccount(account) {
  return {
    ...clone(account),
    alias: account.label,
    advisoryThreshold: account.maxConcurrent,
    capacity: account.maxConcurrent,
    maxConcurrency: account.maxConcurrent,
    advisoryOnly: true
  };
}

function presentLease(lease) {
  const { fenceTokenHash: _fenceTokenHash, ...safe } = clone(lease);
  // Only a documented request/turn lifecycle can confirm that a model task is
  // actually in flight. A wrapper confirms a process, and a manual marker or
  // DOM detector confirms only an observation, so those remain estimates.
  const exact = ['hook', 'sdk'].includes(safe.source) && safe.confidence === 1;
  return {
    ...safe,
    taskLabel: safe.taskLabel || safe.label || '',
    label: safe.taskLabel || safe.label || '',
    fresh: true,
    reliability: exact ? 'exact' : 'estimated'
  };
}

function normalizeStoredAccount(raw, fallbackId) {
  const value = asObject(raw);
  const id = String(value.id || fallbackId || '').trim();
  const provider = String(value.provider || '').trim();
  const label = String(value.label || value.name || '').trim();
  const maxConcurrent = Number(value.maxConcurrent || value.capacity);
  if (!id || !provider || !label || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) return null;
  const createdAt = String(value.createdAt || value.updatedAt || new Date(0).toISOString());
  const updatedAt = String(value.updatedAt || createdAt);
  return {
    id,
    provider,
    label,
    maxConcurrent,
    quotaLink: quotaLinkInput(value.quotaLink, { stored: true }),
    enabled: value.enabled !== false,
    maskedIdentity: String(value.maskedIdentity || '').trim(),
    createdAt,
    updatedAt
  };
}

function normalizeStoredLease(raw, fallbackId) {
  const value = asObject(raw);
  const id = String(value.id || fallbackId || '').trim();
  const accountId = String(value.accountId || '').trim();
  const deviceId = String(value.deviceId || '').trim();
  const expiresAtMs = Date.parse(value.expiresAt);
  if (!id || !accountId || !deviceId || !Number.isFinite(expiresAtMs)) return null;
  const createdAt = String(value.createdAt || value.heartbeatAt || value.expiresAt);
  const heartbeatAt = String(value.heartbeatAt || createdAt);
  const ttlMs = Number.isSafeInteger(Number(value.ttlMs)) && Number(value.ttlMs) > 0
    ? Number(value.ttlMs)
    : DEFAULT_LEASE_TTL_MS;
  return {
    id,
    accountId,
    deviceId,
    taskId: String(value.taskId || '').trim(),
    taskLabel: String(value.taskLabel || value.label || '').trim(),
    projectLabel: String(value.projectLabel || '').trim(),
    source: ['manual', 'wrapper', 'detector', 'hook', 'sdk'].includes(value.source) ? value.source : 'manual',
    confidence: Number.isFinite(Number(value.confidence)) ? Math.max(0, Math.min(1, Number(value.confidence))) : 1,
    idempotencyKey: String(value.idempotencyKey || '').trim(),
    fenceTokenHash: String(value.fenceTokenHash || '').trim(),
    createdAt,
    heartbeatAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    ttlMs
  };
}

function normalizeStoredRecentTask(raw) {
  const value = asObject(raw);
  const id = String(value.id || '').trim();
  const accountId = String(value.accountId || '').trim();
  const deviceId = String(value.deviceId || '').trim();
  const endedAt = String(value.endedAt || '').trim();
  const status = String(value.status || '').trim();
  if (!id || !accountId || !deviceId || !Number.isFinite(Date.parse(endedAt))) return null;
  if (!['completed', 'failed', 'stopped', 'expired'].includes(status)) return null;
  return {
    id,
    accountId,
    deviceId,
    deviceName: String(value.deviceName || '').trim(),
    taskId: String(value.taskId || '').trim(),
    taskLabel: String(value.taskLabel || '').trim(),
    projectLabel: String(value.projectLabel || '').trim(),
    source: String(value.source || '').trim(),
    status,
    reason: String(value.reason || '').trim(),
    createdAt: String(value.createdAt || endedAt),
    endedAt
  };
}

function readStore(dataFile, logger) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') (logger.warn || console.warn)(`Could not read occupancy store ${dataFile}: ${error.message}`);
    return { version: STORE_VERSION, accounts: {}, leases: {}, recentTasks: [] };
  }
  const accounts = {};
  for (const [id, raw] of Object.entries(asObject(parsed.accounts))) {
    const account = normalizeStoredAccount(raw, id);
    if (account) accounts[account.id] = account;
  }
  const leases = {};
  for (const [id, raw] of Object.entries(asObject(parsed.leases))) {
    const lease = normalizeStoredLease(raw, id);
    if (lease && accounts[lease.accountId]) leases[lease.id] = lease;
  }
  const recentTasks = (Array.isArray(parsed.recentTasks) ? parsed.recentTasks : [])
    .map(normalizeStoredRecentTask)
    .filter((task) => task && accounts[task.accountId]);
  return { version: STORE_VERSION, accounts, leases, recentTasks, savedAt: parsed.savedAt };
}

function writeStore(dataFile, state, now) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.tmp`;
  const serialized = {
    version: STORE_VERSION,
    savedAt: new Date(now).toISOString(),
    accounts: state.accounts,
    leases: state.leases,
    recentTasks: state.recentTasks
  };
  fs.writeFileSync(tempFile, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, dataFile);
}

function createOccupancyStore({
  dataFile,
  defaultTtlMs = DEFAULT_LEASE_TTL_MS,
  now = Date.now,
  logger = console,
  cleanupIntervalMs
} = {}) {
  if (!dataFile) throw new Error('dataFile_required');
  const configuredTtlMs = leaseTtl(defaultTtlMs);
  const state = readStore(dataFile, logger);
  const events = new EventEmitter();
  let closed = false;

  function nowMs() {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new Error('invalid_clock');
    return value;
  }

  function persist(at = nowMs()) {
    writeStore(dataFile, state, at);
  }

  function emitChange(reason, at = nowMs()) {
    events.emit('change', snapshot({ at, prune: false }), reason, new Date(at).toISOString());
  }

  function completionStatus(reason) {
    const value = String(reason || '').trim().toLowerCase();
    if (value === 'expired') return 'expired';
    if (value === 'spawn_failed' || /^exit_(?!0$)\d+$/.test(value)) return 'failed';
    if (value === 'manual_stop' || value === 'tab_closed' || value === 'navigation' || value.startsWith('signal_')) return 'stopped';
    return 'completed';
  }

  function rememberTask(lease, reason, at) {
    const status = completionStatus(reason);
    const task = {
      id: lease.id,
      accountId: lease.accountId,
      deviceId: lease.deviceId,
      deviceName: lease.deviceName || '',
      taskId: lease.taskId || '',
      taskLabel: lease.taskLabel || '',
      projectLabel: lease.projectLabel || '',
      source: lease.source || '',
      status,
      reason: String(reason || 'released').slice(0, 100),
      createdAt: lease.createdAt,
      endedAt: new Date(at).toISOString()
    };
    state.recentTasks = [task, ...(state.recentTasks || []).filter((entry) => entry.id !== task.id)]
      .filter((entry) => at - Date.parse(entry.endedAt) <= RECENT_TASK_RETENTION_MS)
      .slice(0, MAX_RECENT_TASKS);
    return task;
  }

  function pruneExpired({ emit = true, at = nowMs() } = {}) {
    let changed = false;
    for (const [leaseId, lease] of Object.entries(state.leases)) {
      if (Date.parse(lease.expiresAt) <= at) {
        rememberTask(lease, 'expired', at);
        delete state.leases[leaseId];
        changed = true;
      }
    }
    if (changed) {
      persist(at);
      if (emit) emitChange('expire', at);
    }
    return changed;
  }

  function pruneRecentTasks(at = nowMs()) {
    const previous = state.recentTasks || [];
    const recent = previous
      .filter((task) => at - Date.parse(task.endedAt) <= RECENT_TASK_RETENTION_MS)
      .slice(0, MAX_RECENT_TASKS);
    if (recent.length === previous.length) return false;
    state.recentTasks = recent;
    // Retention applies to the local store as well as the returned snapshot.
    // This maintenance write intentionally emits no user-visible change event.
    persist(at);
    return true;
  }

  function listAccounts() {
    return Object.values(state.accounts).map(presentAccount);
  }

  function createAccount(input) {
    const value = asObject(input);
    const at = nowMs();
    const id = value.id === undefined
      ? crypto.randomUUID()
      : requiredString(value.id, 'id', 200);
    if (state.accounts[id]) throw new OccupancyError('account_exists', 409);
    const account = {
      id,
      provider: requiredString(value.provider, 'provider', 100).toLowerCase(),
      label: requiredString(value.alias ?? value.label ?? value.name, 'alias'),
      maxConcurrent: positiveInteger(value.capacity ?? value.maxConcurrency ?? value.maxConcurrent ?? 1, 'capacity'),
      quotaLink: quotaLinkInput(value.quotaLink),
      enabled: value.enabled !== false,
      maskedIdentity: optionalString(value.maskedIdentity, 'maskedIdentity', 200),
      createdAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString()
    };
    state.accounts[id] = account;
    persist(at);
    emitChange('account_create', at);
    return presentAccount(account);
  }

  function updateAccount(accountId, input) {
    const id = requiredString(accountId, 'accountId', 200);
    const current = state.accounts[id];
    if (!current) throw new OccupancyError('account_not_found', 404);
    const value = asObject(input);
    const at = nowMs();
    const account = {
      ...current,
      ...(value.provider !== undefined ? { provider: requiredString(value.provider, 'provider', 100).toLowerCase() } : {}),
      ...(value.label !== undefined || value.name !== undefined
        ? { label: requiredString(value.label ?? value.name, 'alias') }
        : {}),
      ...(value.alias !== undefined ? { label: requiredString(value.alias, 'alias') } : {}),
      ...(value.maxConcurrent !== undefined || value.maxConcurrency !== undefined || value.capacity !== undefined
        ? { maxConcurrent: positiveInteger(value.capacity ?? value.maxConcurrency ?? value.maxConcurrent, 'capacity') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(value, 'quotaLink')
        ? { quotaLink: quotaLinkInput(value.quotaLink) }
        : {}),
      ...(value.enabled !== undefined ? { enabled: Boolean(value.enabled) } : {}),
      ...(value.maskedIdentity !== undefined
        ? { maskedIdentity: optionalString(value.maskedIdentity, 'maskedIdentity', 200) }
        : {}),
      updatedAt: new Date(at).toISOString()
    };
    state.accounts[id] = account;
    persist(at);
    emitChange('account_update', at);
    return presentAccount(account);
  }

  function deleteAccount(accountId) {
    const id = requiredString(accountId, 'accountId', 200);
    if (!state.accounts[id]) throw new OccupancyError('account_not_found', 404);
    const at = nowMs();
    delete state.accounts[id];
    for (const [leaseId, lease] of Object.entries(state.leases)) {
      if (lease.accountId === id) delete state.leases[leaseId];
    }
    state.recentTasks = (state.recentTasks || []).filter((task) => task.accountId !== id);
    persist(at);
    emitChange('account_delete', at);
    return true;
  }

  function acquireLease(input) {
    const value = asObject(input);
    const accountId = requiredString(value.accountId, 'accountId', 200);
    const account = state.accounts[accountId];
    if (!account) throw new OccupancyError('account_not_found', 404);
    if (account.enabled === false) throw new OccupancyError('account_disabled', 409);
    const at = nowMs();
    pruneExpired({ at });
    const deviceId = requiredString(value.deviceId, 'deviceId', 200);
    const idempotencyKey = optionalString(value.idempotencyKey, 'idempotencyKey', 200);
    if (idempotencyKey) {
      const existing = Object.values(state.leases).find((lease) => (
        lease.accountId === accountId && lease.deviceId === deviceId && lease.idempotencyKey === idempotencyKey
      ));
      if (existing) {
        const suppliedToken = normalizeFenceToken(value.fenceToken, { required: false });
        if (suppliedToken) assertFenceToken(existing, suppliedToken);
        return { ...presentLease(existing), ...(suppliedToken ? { fenceToken: suppliedToken } : {}), idempotent: true };
      }
    }
    // maxConcurrent is an advisory comfort threshold, not an enforced slot
    // limit. The occupancy feature must never interrupt work or imply that it knows a
    // provider's private concurrency policy. Continue recording leases above
    // the threshold so the operator can see the real observed task count.
    const ttlMs = leaseTtl(value.ttlMs, configuredTtlMs);
    const suppliedFenceToken = normalizeFenceToken(value.fenceToken, { required: false });
    const fenceToken = suppliedFenceToken || crypto.randomBytes(32).toString('base64url');
    const source = normalizeSource(value.source);
    const lease = {
      id: crypto.randomUUID(),
      accountId,
      deviceId,
      deviceName: optionalString(value.deviceName, 'deviceName', 200),
      taskId: optionalString(value.taskId, 'taskId', 200),
      taskLabel: optionalString(value.taskLabel ?? value.label, 'taskLabel'),
      projectLabel: optionalString(value.projectLabel, 'projectLabel'),
      source,
      confidence: normalizeConfidence(value.confidence, source),
      idempotencyKey,
      fenceTokenHash: fenceTokenHash(fenceToken),
      createdAt: new Date(at).toISOString(),
      heartbeatAt: new Date(at).toISOString(),
      expiresAt: new Date(at + ttlMs).toISOString(),
      ttlMs
    };
    state.leases[lease.id] = lease;
    persist(at);
    emitChange('lease_acquire', at);
    return { ...presentLease(lease), fenceToken };
  }

  function heartbeatLease(leaseId, input = {}) {
    const id = requiredString(leaseId, 'leaseId', 200);
    const at = nowMs();
    pruneExpired({ at });
    const current = state.leases[id];
    if (!current) throw new OccupancyError('lease_not_found', 404);
    const value = asObject(input);
    const fenceToken = assertFenceToken(current, value.fenceToken);
    const ttlMs = leaseTtl(value.ttlMs, current.ttlMs || configuredTtlMs);
    const lease = {
      ...current,
      ...(value.taskId !== undefined ? { taskId: optionalString(value.taskId, 'taskId', 200) } : {}),
      ...(value.taskLabel !== undefined || value.label !== undefined
        ? { taskLabel: optionalString(value.taskLabel ?? value.label, 'taskLabel') }
        : {}),
      ...(value.projectLabel !== undefined ? { projectLabel: optionalString(value.projectLabel, 'projectLabel') } : {}),
      heartbeatAt: new Date(at).toISOString(),
      expiresAt: new Date(at + ttlMs).toISOString(),
      ttlMs
    };
    state.leases[id] = lease;
    persist(at);
    emitChange('lease_heartbeat', at);
    return { ...presentLease(lease), fenceToken };
  }

  function releaseLease(leaseId, input = {}) {
    const id = requiredString(leaseId, 'leaseId', 200);
    if (!state.leases[id]) throw new OccupancyError('lease_not_found', 404);
    assertFenceToken(state.leases[id], asObject(input).fenceToken);
    const at = nowMs();
    const lease = presentLease(state.leases[id]);
    const recentTask = rememberTask(state.leases[id], asObject(input).reason || 'released', at);
    delete state.leases[id];
    persist(at);
    emitChange('lease_release', at);
    return { ...lease, completionStatus: recentTask.status, endedAt: recentTask.endedAt };
  }

  function snapshot({ at = nowMs(), prune = true } = {}) {
    if (prune) pruneExpired({ at });
    if (prune) pruneRecentTasks(at);
    const leases = Object.values(state.leases)
      .map(presentLease)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const byAccount = new Map();
    for (const lease of leases) {
      const current = byAccount.get(lease.accountId) || [];
      current.push(lease);
      byAccount.set(lease.accountId, current);
    }
    const recentByAccount = new Map();
    for (const task of state.recentTasks) {
      const current = recentByAccount.get(task.accountId) || [];
      current.push(clone(task));
      recentByAccount.set(task.accountId, current);
    }
    const accounts = Object.values(state.accounts).map((account) => {
      const accountLeases = byAccount.get(account.id) || [];
      const activeCount = accountLeases.length;
      return {
        ...presentAccount(account),
        activeCount,
        remaining: Math.max(0, account.maxConcurrent - activeCount),
        availableSlots: Math.max(0, account.maxConcurrent - activeCount),
        advisoryHeadroom: Math.max(0, account.maxConcurrent - activeCount),
        advisoryThresholdReached: activeCount >= account.maxConcurrent,
        light: account.enabled === false ? 'gray' : accountLight(activeCount, account.maxConcurrent),
        lightBasis: 'observed_tasks_and_user_threshold',
        performanceStatus: 'not_measured',
        reliability: accountLeases.length > 0 && accountLeases.every((lease) => lease.reliability === 'exact')
          ? 'exact'
          : 'estimated',
        tasks: accountLeases,
        leases: accountLeases,
        recentTasks: recentByAccount.get(account.id) || []
      };
    });
    return {
      version: STORE_VERSION,
      advisoryOnly: true,
      performanceTelemetry: false,
      generatedAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      accounts,
      leases,
      recentTasks: clone(state.recentTasks)
    };
  }

  function onChange(listener) {
    events.on('change', listener);
    return () => events.off('change', listener);
  }

  const intervalMs = cleanupIntervalMs === undefined
    ? Math.max(MIN_LEASE_TTL_MS, Math.min(30_000, Math.floor(configuredTtlMs / 2)))
    : Number(cleanupIntervalMs);
  const cleanupTimer = Number.isFinite(intervalMs) && intervalMs > 0
    ? setInterval(() => {
      if (!closed) {
        try { pruneExpired(); }
        catch (error) { (logger.error || console.error)(error); }
      }
    }, intervalMs)
    : null;
  cleanupTimer?.unref?.();

  function close() {
    closed = true;
    if (cleanupTimer) clearInterval(cleanupTimer);
    events.removeAllListeners();
  }

  // Expired leases from a previous process must not survive the first read.
  pruneExpired({ emit: false });

  return {
    acquireLease,
    close,
    createAccount,
    deleteAccount,
    heartbeatLease,
    listAccounts,
    onChange,
    pruneExpired,
    releaseLease,
    snapshot,
    updateAccount
  };
}

module.exports = {
  DEFAULT_LEASE_TTL_MS,
  MAX_LEASE_TTL_MS,
  MIN_LEASE_TTL_MS,
  OccupancyError,
  accountLight,
  createOccupancyStore
};
