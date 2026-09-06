'use strict';

// iCloud Drive is deliberately a small, file-backed adapter at the Electron
// boundary.  It has no bearing on the Hub protocol or the portable usage core:
// each writer owns one file, and readers reduce the valid files locally.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeDeviceRecord } = require('../shared/usage');
const { syncPayload } = require('../shared/syncPayload');
const {
  normalizeSubscription,
  normalizeSubscriptions
} = require('../shared/subscriptionDisplay');

const ICLOUD_SCHEMA_VERSION = 1;
const ICLOUD_SYNC_DIR = 'Token Monitor';
const ICLOUD_SYNC_VERSION_DIR = 'sync-v1';
const DEVICE_FILE_RE = /^device-([a-f0-9]{64})\.json$/;
const WRITER_FILE_RE = /^writer-([a-f0-9]{64})\.json$/;
const MAX_DEVICE_ID_LENGTH = 512;
const MAX_WRITER_ID_LENGTH = 512;

function nowIso() {
  return new Date().toISOString();
}

function cleanId(value, maxLength) {
  const id = String(value === null || value === undefined ? '' : value).trim();
  if (!id || id.length > maxLength || /[\u0000-\u001f\u007f/\\]/.test(id)) return '';
  return id;
}

function idHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deviceFilenameForId(deviceId) {
  const id = cleanId(deviceId, MAX_DEVICE_ID_LENGTH);
  if (!id) return null;
  return `device-${idHash(id)}.json`;
}

function writerFilenameForId(writerId) {
  const id = cleanId(writerId, MAX_WRITER_ID_LENGTH);
  if (!id) return null;
  return `writer-${idHash(id)}.json`;
}

function isKnownDeviceFilename(filename) {
  return DEVICE_FILE_RE.test(String(filename || ''));
}

function isKnownWriterFilename(filename) {
  return WRITER_FILE_RE.test(String(filename || ''));
}

function defaultCloudDocsRoot(home = os.homedir()) {
  return path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
}

function safePathForDisplay(root, home = os.homedir()) {
  const value = String(root || '');
  const homePrefix = `${path.resolve(home)}${path.sep}`;
  const resolved = path.resolve(value);
  if (resolved === path.resolve(home)) return '~';
  if (resolved.startsWith(homePrefix)) return `~/${resolved.slice(homePrefix.length).replaceAll(path.sep, '/')}`;
  // A caller may inject a temporary root in tests.  Returning a stable redacted
  // marker keeps diagnostics useful without leaking a username or full path.
  return '[redacted]/Token Monitor/sync-v1';
}

function isDirectory(fsApi, target) {
  try {
    return fsApi.lstatSync(target).isDirectory();
  } catch (_) {
    return false;
  }
}

function pathState({ platform = process.platform, home = os.homedir(), cloudDocsRoot, fsApi = fs } = {}) {
  const root = path.resolve(cloudDocsRoot || defaultCloudDocsRoot(home));
  const syncRoot = path.join(root, ICLOUD_SYNC_DIR, ICLOUD_SYNC_VERSION_DIR);
  const devicesRoot = path.join(syncRoot, 'devices');
  const subscriptionsRoot = path.join(syncRoot, 'subscriptions');
  const base = {
    supported: platform === 'darwin',
    available: false,
    status: platform === 'darwin' ? 'waiting' : 'unsupported',
    reason: platform === 'darwin' ? 'icloud-drive-not-found' : 'unsupported-platform',
    cloudDocsRoot: root,
    syncRoot,
    devicesRoot,
    subscriptionsRoot,
    displayRoot: safePathForDisplay(syncRoot, home)
  };
  if (!base.supported) return base;
  try {
    const stat = fsApi.lstatSync(root);
    if (!stat.isDirectory()) {
      return { ...base, status: 'error', reason: 'icloud-root-not-directory' };
    }
    return { ...base, available: true, status: isDirectory(fsApi, syncRoot) ? 'available' : 'initializing', reason: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return base;
    return { ...base, status: 'error', reason: 'icloud-root-unreadable', error };
  }
}

function ensureDirectory(fsApi, target) {
  fsApi.mkdirSync(target, { recursive: true });
}

function ensureSyncDirectories(paths, fsApi = fs) {
  if (!paths.supported || !paths.available) return paths;
  ensureDirectory(fsApi, paths.syncRoot);
  ensureDirectory(fsApi, paths.devicesRoot);
  ensureDirectory(fsApi, paths.subscriptionsRoot);
  return { ...paths, status: 'available', reason: '' };
}

function isRegularFile(fsApi, target) {
  try {
    return fsApi.lstatSync(target).isFile();
  } catch (_) {
    return false;
  }
}

function readJsonFile(fsApi, target) {
  if (!isRegularFile(fsApi, target)) return { ok: false, reason: 'not-regular-file' };
  try {
    const value = JSON.parse(fsApi.readFileSync(target, 'utf8'));
    return { ok: true, value };
  } catch (_) {
    return { ok: false, reason: 'invalid-json' };
  }
}

function atomicWriteJson(fsApi, target, value) {
  const directory = path.dirname(target);
  ensureDirectory(fsApi, directory);
  const temp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  const body = `${JSON.stringify(value)}\n`;
  let fd = null;
  try {
    fd = fsApi.openSync(temp, 'wx', 0o600);
    fsApi.writeSync(fd, body, null, 'utf8');
    if (typeof fsApi.fsyncSync === 'function') fsApi.fsyncSync(fd);
    fsApi.closeSync(fd);
    fd = null;
    if (typeof fsApi.chmodSync === 'function') fsApi.chmodSync(temp, 0o600);
    fsApi.renameSync(temp, target);
  } catch (error) {
    if (fd !== null) {
      try { fsApi.closeSync(fd); } catch (_) { /* best effort */ }
    }
    try { fsApi.unlinkSync(temp); } catch (_) { /* best effort */ }
    throw error;
  }
}

function sensitiveKey(key) {
  return /(?:cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|private[_-]?key)/i.test(String(key));
}

function stripSensitive(value) {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key)) continue;
    output[key] = stripSensitive(child);
  }
  return output;
}

function toWireRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const normalized = normalizeDeviceRecord(record);
  const summary = {
    ...normalized,
    today: normalized.periods.today,
    month: normalized.periods.month,
    allTime: normalized.periods.allTime
  };
  delete summary.periods;
  return stripSensitive(syncPayload(summary));
}

function validDeviceDocument(document, expectedFilename) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  if (document.schemaVersion !== ICLOUD_SCHEMA_VERSION || document.kind !== 'device') return null;
  const deviceId = cleanId(document.deviceId, MAX_DEVICE_ID_LENGTH);
  if (!deviceId || deviceFilenameForId(deviceId) !== expectedFilename) return null;
  const revision = Number(document.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  if (!document.record || typeof document.record !== 'object' || Array.isArray(document.record)) return null;
  // Re-apply the boundary scrub on reads as well as writes. A manually placed
  // or older file must not be able to smuggle a credential-shaped field into
  // the in-process aggregate merely because it passed JSON parsing.
  const record = normalizeDeviceRecord(stripSensitive(document.record));
  if (record.deviceId !== deviceId) return null;
  return {
    schemaVersion: ICLOUD_SCHEMA_VERSION,
    kind: 'device',
    deviceId,
    revision,
    updatedAt: String(document.updatedAt || record.updatedAt || ''),
    record
  };
}

function revisionToken(revision) {
  if (!revision || !Number.isSafeInteger(Number(revision.counter)) || !revision.writerId) return '';
  return `${Number(revision.counter)}:${revision.writerId}`;
}

function compareSubscriptionRevision(left, right) {
  const counterDiff = Number(left?.counter || 0) - Number(right?.counter || 0);
  if (counterDiff) return counterDiff;
  const leftWriter = String(left?.writerId || '');
  const rightWriter = String(right?.writerId || '');
  return leftWriter < rightWriter ? -1 : leftWriter > rightWriter ? 1 : 0;
}

function validSubscriptionDocument(document, expectedFilename) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  if (document.schemaVersion !== ICLOUD_SCHEMA_VERSION || document.kind !== 'subscriptions') return null;
  const writerId = cleanId(document.writerId, MAX_WRITER_ID_LENGTH);
  if (!writerId || writerFilenameForId(writerId) !== expectedFilename) return null;
  const counter = Number(document.revision?.counter);
  if (!Number.isSafeInteger(counter) || counter < 1) return null;
  if (String(document.revision?.writerId || '') !== writerId) return null;
  if (typeof document.updatedAt !== 'string' || !document.updatedAt.trim()) return null;
  if (!Array.isArray(document.subscriptions)) return null;
  const normalized = [];
  const seen = new Set();
  for (const entry of document.subscriptions) {
    if (!entry || typeof entry !== 'object' || !cleanId(entry.id, 512)) return null;
    const subscription = normalizeSubscription(entry);
    if (!subscription || seen.has(subscription.id)) return null;
    seen.add(subscription.id);
    normalized.push(subscription);
  }
  return {
    schemaVersion: ICLOUD_SCHEMA_VERSION,
    kind: 'subscriptions',
    writerId,
    revision: { counter, writerId },
    updatedAt: document.updatedAt,
    subscriptions: normalizeSubscriptions(normalized)
  };
}

function createIcloudSyncStore(options = {}) {
  const fsApi = options.fsApi || fs;
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const writerId = cleanId(options.writerId || options.deviceId || os.hostname(), MAX_WRITER_ID_LENGTH) || 'unknown-writer';
  const deviceCache = new Map();
  const subscriptionCache = new Map();
  let lastPaths = pathState({ platform, home, cloudDocsRoot: options.cloudDocsRoot, fsApi });
  let lastError = null;
  let pathStatusOverride = null;

  function paths() {
    const current = pathState({ platform, home, cloudDocsRoot: options.cloudDocsRoot, fsApi });
    if (!current.available) {
      pathStatusOverride = null;
    }
    lastPaths = pathStatusOverride && pathStatusOverride.syncRoot === current.syncRoot
      ? { ...current, status: pathStatusOverride.status, reason: pathStatusOverride.reason }
      : current;
    return lastPaths;
  }

  function availablePaths() {
    const current = paths();
    if (!current.supported || !current.available) return { paths: current, error: null };
    try {
      return { paths: ensureSyncDirectories(current, fsApi), error: null };
    } catch (error) {
      lastError = { category: 'root-create-failed', error };
      pathStatusOverride = { syncRoot: current.syncRoot, status: 'error', reason: 'root-create-failed' };
      return { paths: { ...current, status: 'error', reason: 'root-create-failed', error }, error };
    }
  }

  function status() {
    const current = paths();
    return {
      supported: current.supported,
      available: current.available,
      state: current.status,
      reason: current.reason,
      root: current.displayRoot,
      syncRoot: current.syncRoot,
      devicesRoot: current.devicesRoot,
      subscriptionsRoot: current.subscriptionsRoot,
      lastErrorCategory: lastError?.category || ''
    };
  }

  function listFiles(directory, matcher) {
    try {
      return fsApi.readdirSync(directory).filter((filename) => matcher(filename));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  function discoverDevices() {
    const available = availablePaths();
    if (available.error || !available.paths.available) {
      return {
        records: [...deviceCache.values()].map((entry) => entry.record),
        documents: [...deviceCache.values()].map((entry) => entry.document),
        status: status(),
        errors: available.error ? [{ category: available.paths.reason || 'root-unavailable' }] : []
      };
    }
    const currentFiles = new Set();
    const errors = [];
    try {
      for (const filename of listFiles(available.paths.devicesRoot, isKnownDeviceFilename)) {
        currentFiles.add(filename);
        const result = readJsonFile(fsApi, path.join(available.paths.devicesRoot, filename));
        const document = result.ok ? validDeviceDocument(result.value, filename) : null;
        if (!document) {
          errors.push({ category: result.reason || 'invalid-device-document', filename });
          continue;
        }
        const prior = deviceCache.get(filename);
        if (!prior || document.revision >= prior.document.revision) {
          deviceCache.set(filename, { document, record: document.record });
        }
      }
      for (const filename of [...deviceCache.keys()]) {
        if (!currentFiles.has(filename)) deviceCache.delete(filename);
      }
    } catch (error) {
      lastError = { category: 'device-reconcile-failed', error };
      errors.push({ category: lastError.category });
    }
    return {
      records: [...deviceCache.values()].map((entry) => entry.record),
      documents: [...deviceCache.values()].map((entry) => entry.document),
      status: status(),
      errors
    };
  }

  function writeDevice(record) {
    const wire = toWireRecord(record);
    if (!wire) {
      const error = new Error('Invalid iCloud device record');
      error.code = 'invalid_record';
      throw error;
    }
    const deviceId = cleanId(wire.deviceId, MAX_DEVICE_ID_LENGTH);
    const filename = deviceFilenameForId(deviceId);
    if (!deviceId || !filename) {
      const error = new Error('Invalid device id');
      error.code = 'invalid_device_id';
      throw error;
    }
    const available = availablePaths();
    if (available.error || !available.paths.available) {
      const error = new Error('iCloud Drive is unavailable');
      error.code = available.paths.reason || 'icloud_unavailable';
      throw error;
    }
    const prior = deviceCache.get(filename);
    let revision = Number(prior?.document?.revision || 0) + 1;
    if (!prior) {
      const existing = readJsonFile(fsApi, path.join(available.paths.devicesRoot, filename));
      const existingDocument = existing.ok ? validDeviceDocument(existing.value, filename) : null;
      revision = Number(existingDocument?.revision || 0) + 1;
    }
    const document = {
      schemaVersion: ICLOUD_SCHEMA_VERSION,
      kind: 'device',
      deviceId,
      revision,
      updatedAt: String(wire.updatedAt || nowIso()),
      record: wire
    };
    try {
      atomicWriteJson(fsApi, path.join(available.paths.devicesRoot, filename), document);
    } catch (error) {
      lastError = { category: 'device-write-failed', error };
      error.code = error.code || lastError.category;
      throw error;
    }
    const normalized = validDeviceDocument(document, filename);
    deviceCache.set(filename, { document: normalized, record: normalized.record });
    return normalized;
  }

  function deleteDevice(deviceId) {
    const id = cleanId(deviceId, MAX_DEVICE_ID_LENGTH);
    const filename = deviceFilenameForId(id);
    if (!filename) {
      const error = new Error('Invalid device id');
      error.code = 'invalid_device_id';
      throw error;
    }
    const available = availablePaths();
    if (available.error || !available.paths.available) {
      const error = new Error('iCloud Drive is unavailable');
      error.code = available.paths.reason || 'icloud_unavailable';
      throw error;
    }
    const target = path.join(available.paths.devicesRoot, filename);
    try {
      if (isRegularFile(fsApi, target)) fsApi.unlinkSync(target);
      deviceCache.delete(filename);
      return { deleted: true, deviceId: id };
    } catch (error) {
      lastError = { category: 'device-delete-failed', error };
      error.code = error.code || lastError.category;
      throw error;
    }
  }

  function discoverSubscriptions() {
    const available = availablePaths();
    if (available.error || !available.paths.available) {
      const documents = [...subscriptionCache.values()];
      const winner = documents.sort((left, right) => compareSubscriptionRevision(left.revision, right.revision)).at(-1) || null;
      return { documents, winner, revisionToken: revisionToken(winner?.revision), status: status(), errors: [] };
    }
    const currentFiles = new Set();
    const errors = [];
    try {
      for (const filename of listFiles(available.paths.subscriptionsRoot, isKnownWriterFilename)) {
        currentFiles.add(filename);
        const result = readJsonFile(fsApi, path.join(available.paths.subscriptionsRoot, filename));
        const document = result.ok ? validSubscriptionDocument(result.value, filename) : null;
        if (!document) {
          errors.push({ category: result.reason || 'invalid-subscription-document', filename });
          continue;
        }
        const prior = subscriptionCache.get(filename);
        if (!prior || compareSubscriptionRevision(document.revision, prior.revision) >= 0) {
          subscriptionCache.set(filename, document);
        }
      }
      for (const filename of [...subscriptionCache.keys()]) {
        if (!currentFiles.has(filename)) subscriptionCache.delete(filename);
      }
    } catch (error) {
      lastError = { category: 'subscription-reconcile-failed', error };
      errors.push({ category: lastError.category });
    }
    const documents = [...subscriptionCache.values()];
    const winner = documents.slice().sort((left, right) => compareSubscriptionRevision(left.revision, right.revision)).at(-1) || null;
    return { documents, winner, revisionToken: revisionToken(winner?.revision), status: status(), errors };
  }

  function writeSubscriptions(subscriptions, { baseRevision = '' } = {}) {
    const normalized = normalizeSubscriptions(subscriptions);
    if (!Array.isArray(subscriptions) || normalized.length !== subscriptions.length) {
      const error = new Error('Invalid iCloud subscriptions');
      error.code = 'invalid_subscriptions';
      throw error;
    }
    const available = availablePaths();
    if (available.error || !available.paths.available) {
      const error = new Error('iCloud Drive is unavailable');
      error.code = available.paths.reason || 'icloud_unavailable';
      throw error;
    }
    const current = discoverSubscriptions();
    if (current.winner && baseRevision !== current.revisionToken) {
      const error = new Error('The iCloud subscription list changed on another device');
      error.code = 'stale_write';
      error.current = current;
      throw error;
    }
    const maxCounter = current.documents.reduce((max, document) => Math.max(max, document.revision.counter), 0);
    const document = {
      schemaVersion: ICLOUD_SCHEMA_VERSION,
      kind: 'subscriptions',
      writerId,
      revision: { counter: maxCounter + 1, writerId },
      updatedAt: nowIso(),
      subscriptions: normalized
    };
    const filename = writerFilenameForId(writerId);
    try {
      atomicWriteJson(fsApi, path.join(available.paths.subscriptionsRoot, filename), document);
    } catch (error) {
      lastError = { category: 'subscription-write-failed', error };
      error.code = error.code || lastError.category;
      throw error;
    }
    subscriptionCache.set(filename, document);
    const refreshed = discoverSubscriptions();
    return { ...refreshed, written: document };
  }

  return {
    deleteDevice,
    discoverDevices,
    discoverSubscriptions,
    getLastGoodDevices: () => [...deviceCache.values()].map((entry) => entry.record),
    paths,
    status,
    writeDevice,
    writeSubscriptions
  };
}

module.exports = {
  ICLOUD_SCHEMA_VERSION,
  ICLOUD_SYNC_DIR,
  ICLOUD_SYNC_VERSION_DIR,
  atomicWriteJson,
  createIcloudSyncStore,
  defaultCloudDocsRoot,
  deviceFilenameForId,
  isKnownDeviceFilename,
  isKnownWriterFilename,
  pathState,
  revisionToken,
  safePathForDisplay,
  stripSensitive,
  writerFilenameForId
};
