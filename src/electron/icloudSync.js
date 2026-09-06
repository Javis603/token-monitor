'use strict';

// iCloud Drive is deliberately a small, file-backed adapter at the Electron
// boundary. It has no bearing on the Hub protocol or the portable usage core:
// each writer owns one file, and readers reduce the valid files locally.
const crypto = require('node:crypto');
const fsConstants = require('node:fs').constants;
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TextEncoder } = require('node:util');

const { MAX_JSON_BODY_BYTES } = require('../shared/http');
const { staleAfterMsForSyncUpload } = require('../shared/syncUploadInterval');
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

// The sync payload is already reduced below the Hub's one-megabyte request
// limit. Keeping the document cap at that limit leaves room for the device
// envelope and avoids making a valid Hub payload impossible to persist here.
const MAX_ICLOUD_DOCUMENT_BYTES = MAX_JSON_BODY_BYTES;
const MAX_REVISION_LEDGER_BYTES = 64 * 1024;
const MAX_DELETIONS_PER_WRITER = 512;
const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;
const REVISION_LEDGER_SCHEMA_VERSION = 1;

function resolveFsApi(fsApi) {
  if (fsApi && typeof fsApi.lstat === 'function' && typeof fsApi.open === 'function') return fsApi;
  if (fsApi?.promises && typeof fsApi.promises.lstat === 'function') return fsApi.promises;
  return fs;
}

function nowIso(now = () => Date.now()) {
  return new Date(now()).toISOString();
}

function cleanId(value, maxLength) {
  const id = String(value === null || value === undefined ? '' : value).trim();
  if (!id || id.length > maxLength || /[\u0000-\u001f\u007f/\\]/.test(id)) return '';
  return id;
}

function idHash(value) {
  // This is a deterministic filename digest for validated device/writer
  // identifiers, not password or credential storage.
  return crypto.createHash('sha256').update(new TextEncoder().encode(String(value))).digest('hex');
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

function defaultRevisionLedgerPath(home, writerId) {
  return path.join(
    home,
    'Library',
    'Application Support',
    'Token Monitor',
    `icloud-revisions-${idHash(writerId)}.json`
  );
}

function safePathForDisplay(root, home = os.homedir()) {
  const value = String(root || '');
  const homePrefix = `${path.resolve(home)}${path.sep}`;
  const resolved = path.resolve(value);
  if (resolved === path.resolve(home)) return '~';
  if (resolved.startsWith(homePrefix)) return `~/${resolved.slice(homePrefix.length).replaceAll(path.sep, '/')}`;
  // A caller may inject a temporary root in tests. Returning a stable redacted
  // marker keeps diagnostics useful without leaking a username or full path.
  return '[redacted]/Token Monitor/sync-v1';
}

function pathLayout({ platform = process.platform, home = os.homedir(), cloudDocsRoot } = {}) {
  const root = path.resolve(cloudDocsRoot || defaultCloudDocsRoot(home));
  const syncRoot = path.join(root, ICLOUD_SYNC_DIR, ICLOUD_SYNC_VERSION_DIR);
  const devicesRoot = path.join(syncRoot, 'devices');
  const subscriptionsRoot = path.join(syncRoot, 'subscriptions');
  const deletionsRoot = path.join(syncRoot, 'deletions');
  return {
    supported: platform === 'darwin',
    available: false,
    status: platform === 'darwin' ? 'waiting' : 'unsupported',
    reason: platform === 'darwin' ? 'icloud-drive-not-found' : 'unsupported-platform',
    cloudDocsRoot: root,
    syncRoot,
    devicesRoot,
    subscriptionsRoot,
    deletionsRoot,
    displayRoot: safePathForDisplay(syncRoot, home)
  };
}

async function pathState({ platform = process.platform, home = os.homedir(), cloudDocsRoot, fsApi = fs } = {}) {
  const api = resolveFsApi(fsApi);
  const base = pathLayout({ platform, home, cloudDocsRoot });
  if (!base.supported) return base;
  try {
    const stat = await api.lstat(base.cloudDocsRoot);
    if (!stat.isDirectory()) {
      return { ...base, status: 'error', reason: 'icloud-root-not-directory' };
    }
    let syncAvailable = false;
    try {
      syncAvailable = (await api.lstat(base.syncRoot)).isDirectory();
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { ...base, available: true, status: 'error', reason: 'icloud-sync-root-unreadable' };
      }
    }
    return {
      ...base,
      available: true,
      status: syncAvailable ? 'available' : 'initializing',
      reason: ''
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return base;
    return { ...base, status: 'error', reason: 'icloud-root-unreadable', error };
  }
}

async function ensureDirectory(fsApi, target) {
  await fsApi.mkdir(target, { recursive: true });
}

async function ensureSyncDirectories(paths, fsApi = fs) {
  if (!paths.supported || !paths.available) return paths;
  await ensureDirectory(fsApi, paths.syncRoot);
  await ensureDirectory(fsApi, paths.devicesRoot);
  await ensureDirectory(fsApi, paths.subscriptionsRoot);
  await ensureDirectory(fsApi, paths.deletionsRoot);
  return { ...paths, status: 'available', reason: '' };
}

function readOpenFlags(platform = process.platform, hostPlatform = process.platform) {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (platform === 'darwin' && hostPlatform === 'darwin' && typeof noFollow !== 'number') {
    const error = new Error('iCloud file reads require O_NOFOLLOW on macOS');
    error.code = 'symlink-not-allowed';
    throw error;
  }
  return Number(fsConstants.O_RDONLY || 0) | (typeof noFollow === 'number' ? noFollow : 0);
}

function readErrorReason(error) {
  if (error?.code === 'ENOENT') return 'missing';
  if (error?.code === 'ELOOP' || error?.code === 'EMLINK') return 'symlink-not-allowed';
  return 'read-failed';
}

async function readJsonFile(
  fsApi,
  target,
  maxBytes = MAX_ICLOUD_DOCUMENT_BYTES,
  platform = process.platform,
  hostPlatform = process.platform
) {
  let handle;
  try {
    handle = await fsApi.open(target, readOpenFlags(platform, hostPlatform));
  } catch (error) {
    return {
      ok: false,
      reason: readErrorReason(error),
      error
    };
  }
  try {
    if (typeof handle.stat !== 'function' || typeof handle.readFile !== 'function') {
      return { ok: false, reason: 'read-failed' };
    }
    let stat;
    try {
      stat = await handle.stat();
    } catch (error) {
      return { ok: false, reason: readErrorReason(error), error };
    }
    if (!stat?.isFile?.()) return { ok: false, reason: 'not-regular-file' };
    if (Number.isFinite(stat.size) && stat.size > maxBytes) {
      return { ok: false, reason: 'document-too-large', size: stat.size };
    }
    let body;
    try {
      body = await handle.readFile('utf8');
    } catch (error) {
      return { ok: false, reason: readErrorReason(error), error };
    }
    // The stat is on the same open handle as the read. This second bound still
    // protects against filesystems whose reported size is stale or incomplete.
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > maxBytes) return { ok: false, reason: 'document-too-large', size: bytes };
    return { ok: true, value: JSON.parse(body) };
  } catch (error) {
    return { ok: false, reason: 'invalid-json', error };
  } finally {
    try { await handle.close(); } catch (_) { /* best effort after the result */ }
  }
}

function unsupportedDirectorySync(error) {
  return ['EISDIR', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(String(error?.code || ''));
}

async function syncDirectory(
  fsApi,
  directory,
  _platform = process.platform,
  hostPlatform = process.platform
) {
  let handle;
  try {
    handle = await fsApi.open(directory, 'r');
    if (typeof handle.sync !== 'function') {
      const error = new Error('directory fsync is unavailable');
      error.code = 'ENOSYS';
      throw error;
    }
    await handle.sync();
    return { durable: true };
  } catch (error) {
    // The logical product platform may be injected as darwin in a test running
    // on Windows. Downgrade only when the actual filesystem host lacks the
    // primitive; a real macOS host must still report a directory fsync failure.
    if (hostPlatform !== 'darwin' && unsupportedDirectorySync(error)) return { durable: false, degraded: true };
    throw error;
  } finally {
    try { await handle?.close(); } catch (_) { /* best effort after the result */ }
  }
}

function documentTooLargeError(bytes, maxBytes) {
  const error = new Error(`iCloud document exceeds ${maxBytes} bytes`);
  error.code = 'document_too_large';
  error.bytes = bytes;
  error.maxBytes = maxBytes;
  return error;
}

async function atomicWriteJson(fsApi, target, value, options = {}) {
  const api = resolveFsApi(fsApi);
  const platform = options.platform || process.platform;
  const hostPlatform = options.hostPlatform || process.platform;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_ICLOUD_DOCUMENT_BYTES;
  const body = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > maxBytes) throw documentTooLargeError(bytes, maxBytes);

  const directory = path.dirname(target);
  await ensureDirectory(api, directory);
  const temp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let handle = null;
  let renamed = false;
  try {
    handle = await api.open(temp, 'wx', 0o600);
    await handle.writeFile(body, 'utf8');
    if (typeof handle.sync !== 'function') {
      const error = new Error('file fsync is unavailable');
      error.code = 'ENOSYS';
      throw error;
    }
    await handle.sync();
    await handle.close();
    handle = null;
    if (typeof api.chmod === 'function') await api.chmod(temp, 0o600);
    await api.rename(temp, target);
    renamed = true;
    await syncDirectory(api, directory, platform, hostPlatform);
  } catch (error) {
    try { await handle?.close(); } catch (_) { /* best effort */ }
    if (!renamed) {
      try { await api.unlink(temp); } catch (_) { /* best effort */ }
    }
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
  let record;
  try { record = normalizeDeviceRecord(stripSensitive(document.record)); } catch (_) { return null; }
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
  if (!revision || !Number.isSafeInteger(Number(revision.counter)) || revision.counter < 1 || !revision.writerId) return '';
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

function validDeletionDocument(document, expectedFilename) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  if (document.schemaVersion !== ICLOUD_SCHEMA_VERSION || document.kind !== 'device-deletions') return null;
  const writerId = cleanId(document.writerId, MAX_WRITER_ID_LENGTH);
  if (!writerId || writerFilenameForId(writerId) !== expectedFilename) return null;
  const counter = Number(document.revision?.counter);
  if (!Number.isSafeInteger(counter) || counter < 1) return null;
  if (String(document.revision?.writerId || '') !== writerId) return null;
  if (!Array.isArray(document.deletions) || document.deletions.length > MAX_DELETIONS_PER_WRITER) return null;
  const seen = new Set();
  const deletions = [];
  for (const entry of document.deletions) {
    const targetDeviceId = cleanId(entry?.targetDeviceId, MAX_DEVICE_ID_LENGTH);
    const targetDeviceRevision = Number(entry?.targetDeviceRevision);
    if (
      !targetDeviceId
      || !Number.isSafeInteger(targetDeviceRevision)
      || targetDeviceRevision < 0
      || seen.has(targetDeviceId)
    ) return null;
    seen.add(targetDeviceId);
    deletions.push({ targetDeviceId, targetDeviceRevision });
  }
  deletions.sort((left, right) => left.targetDeviceId.localeCompare(right.targetDeviceId));
  return {
    schemaVersion: ICLOUD_SCHEMA_VERSION,
    kind: 'device-deletions',
    writerId,
    revision: { counter, writerId },
    updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : '',
    deletions
  };
}

function emptyRevisionLedger() {
  return {
    schemaVersion: REVISION_LEDGER_SCHEMA_VERSION,
    kind: 'icloud-revision-ledger',
    devices: Object.create(null),
    subscriptionCounter: 0,
    deletionCounter: 0
  };
}

function validRevisionLedger(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  if (document.schemaVersion !== REVISION_LEDGER_SCHEMA_VERSION || document.kind !== 'icloud-revision-ledger') return null;
  if (!document.devices || typeof document.devices !== 'object' || Array.isArray(document.devices)) return null;
  const devices = Object.create(null);
  const entries = Object.entries(document.devices);
  if (entries.length > MAX_DELETIONS_PER_WRITER) return null;
  for (const [deviceId, revision] of entries) {
    if (!cleanId(deviceId, MAX_DEVICE_ID_LENGTH)) return null;
    const numeric = Number(revision);
    if (!Number.isSafeInteger(numeric) || numeric < 0) return null;
    devices[deviceId] = numeric;
  }
  const subscriptionCounter = Number(document.subscriptionCounter || 0);
  const deletionCounter = Number(document.deletionCounter || 0);
  if (
    !Number.isSafeInteger(subscriptionCounter) || subscriptionCounter < 0
    || !Number.isSafeInteger(deletionCounter) || deletionCounter < 0
  ) return null;
  return {
    schemaVersion: REVISION_LEDGER_SCHEMA_VERSION,
    kind: 'icloud-revision-ledger',
    devices,
    subscriptionCounter,
    deletionCounter
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function semanticDeviceFingerprint(record) {
  const semantic = record && typeof record === 'object' && !Array.isArray(record) ? { ...record } : record;
  if (semantic && typeof semantic === 'object') {
    // These are publication freshness fields only. Nested timestamps such as
    // limit resets and history data remain part of the semantic fingerprint.
    delete semantic.updatedAt;
    delete semantic.receivedAt;
  }
  return crypto.createHash('sha256').update(stableSerialize(semantic)).digest('hex');
}

function createIcloudSyncStore(options = {}) {
  const fsApi = resolveFsApi(options.fsApi);
  const platform = options.platform || process.platform;
  const hostPlatform = options.hostPlatform || process.platform;
  const home = options.home || os.homedir();
  const writerId = cleanId(options.writerId || options.deviceId || os.hostname(), MAX_WRITER_ID_LENGTH) || 'unknown-writer';
  const revisionLedgerPath = options.revisionLedgerPath || defaultRevisionLedgerPath(home, writerId);
  const staleAfterMs = Number.isFinite(options.staleAfterMs) && options.staleAfterMs > 0
    ? options.staleAfterMs
    : DEFAULT_STALE_AFTER_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const deviceCache = new Map();
  const subscriptionCache = new Map();
  const deletionCache = new Map();
  let lastPaths = pathLayout({ platform, home, cloudDocsRoot: options.cloudDocsRoot });
  let lastError = null;
  let pathStatusOverride = null;
  let pathProbePromise = null;
  let revisionLedger = emptyRevisionLedger();
  let revisionLedgerLoaded = false;
  let revisionLedgerLoadPromise = null;
  let revisionLedgerQueue = Promise.resolve();
  let deviceMutationQueue = Promise.resolve();
  let subscriptionMutationQueue = Promise.resolve();
  let acceptingMutations = true;
  let closePromise = null;
  let lastDeviceFingerprint = '';
  let lastDeviceWriteAt = null;

  function stoppedMutationError() {
    const error = new Error('iCloud sync store is closed');
    error.code = 'icloud_stopped';
    return error;
  }

  function enqueueDeviceMutation(run) {
    if (!acceptingMutations) return Promise.reject(stoppedMutationError());
    const task = deviceMutationQueue.then(run, run);
    deviceMutationQueue = task.catch(() => {});
    return task;
  }

  function enqueueSubscriptionMutation(run) {
    if (!acceptingMutations) return Promise.reject(stoppedMutationError());
    const task = subscriptionMutationQueue.then(run, run);
    subscriptionMutationQueue = task.catch(() => {});
    return task;
  }

  async function waitForIdle() {
    while (true) {
      const queues = [deviceMutationQueue, subscriptionMutationQueue, revisionLedgerQueue];
      await Promise.allSettled(queues);
      if (
        queues[0] === deviceMutationQueue
        && queues[1] === subscriptionMutationQueue
        && queues[2] === revisionLedgerQueue
      ) return;
    }
  }

  function whenIdle() {
    return closePromise || waitForIdle();
  }

  function close() {
    acceptingMutations = false;
    if (!closePromise) closePromise = waitForIdle();
    return closePromise;
  }

  async function refreshPaths() {
    if (!pathProbePromise) {
      pathProbePromise = pathState({
        platform,
        home,
        cloudDocsRoot: options.cloudDocsRoot,
        fsApi
      }).finally(() => { pathProbePromise = null; });
    }
    const current = await pathProbePromise;
    if (!current.available) pathStatusOverride = null;
    lastPaths = pathStatusOverride && pathStatusOverride.syncRoot === current.syncRoot
      ? { ...current, status: pathStatusOverride.status, reason: pathStatusOverride.reason }
      : current;
    return lastPaths;
  }

  function paths() {
    return lastPaths;
  }

  async function availablePaths() {
    const current = await refreshPaths();
    if (!current.supported || !current.available) return { paths: current, error: null };
    try {
      const ensured = await ensureSyncDirectories(current, fsApi);
      lastPaths = ensured;
      return { paths: ensured, error: null };
    } catch (error) {
      lastError = { category: 'root-create-failed', error };
      pathStatusOverride = { syncRoot: current.syncRoot, status: 'error', reason: 'root-create-failed' };
      lastPaths = { ...current, status: 'error', reason: 'root-create-failed', error };
      return { paths: lastPaths, error };
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
      deletionsRoot: current.deletionsRoot,
      revisionLedgerPath,
      lastErrorCategory: lastError?.category || ''
    };
  }

  function clearError() {
    lastError = null;
  }

  async function listFiles(directory, matcher) {
    try {
      const filenames = await fsApi.readdir(directory);
      return { ok: true, files: filenames.filter((filename) => matcher(filename)).sort() };
    } catch (error) {
      return {
        ok: false,
        reason: error?.code === 'ENOENT' ? 'directory-unavailable' : 'directory-read-failed',
        error
      };
    }
  }

  function cacheRecordsForDeletionTargets() {
    const targets = new Map();
    for (const document of deletionCache.values()) {
      for (const entry of document.deletions) {
        targets.set(entry.targetDeviceId, Math.max(targets.get(entry.targetDeviceId) || 0, entry.targetDeviceRevision));
      }
    }
    return targets;
  }

  function visibleDeviceEntries() {
    const deletionTargets = cacheRecordsForDeletionTargets();
    return [...deviceCache.values()].filter(({ document }) => {
      const targetRevision = deletionTargets.get(document.deviceId);
      return !Number.isSafeInteger(targetRevision) || document.revision > targetRevision;
    });
  }

  async function discoverDevices() {
    const available = await availablePaths();
    if (available.error || !available.paths.available) {
      const visible = visibleDeviceEntries();
      return {
        records: visible.map((entry) => entry.record),
        documents: visible.map((entry) => entry.document),
        status: status(),
        errors: available.error ? [{ category: available.paths.reason || 'root-unavailable' }] : []
      };
    }
    const errors = [];
    const [deviceListing, deletionListing] = await Promise.all([
      listFiles(available.paths.devicesRoot, isKnownDeviceFilename),
      listFiles(available.paths.deletionsRoot, isKnownWriterFilename)
    ]);
    if (!deviceListing.ok) errors.push({ category: deviceListing.reason });
    if (!deletionListing.ok) errors.push({ category: deletionListing.reason });

    for (const filename of deviceListing.files || []) {
      const result = await readJsonFile(
        fsApi,
        path.join(available.paths.devicesRoot, filename),
        MAX_ICLOUD_DOCUMENT_BYTES,
        platform,
        hostPlatform
      );
      const document = result.ok ? validDeviceDocument(result.value, filename) : null;
      if (!document) {
        errors.push({ category: result.reason || 'invalid-device-document', filename });
        continue;
      }
      const prior = deviceCache.get(filename);
      if (!prior || document.revision > prior.document.revision) {
        deviceCache.set(filename, { document, record: document.record });
      }
    }
    for (const filename of deletionListing.files || []) {
      const result = await readJsonFile(
        fsApi,
        path.join(available.paths.deletionsRoot, filename),
        MAX_ICLOUD_DOCUMENT_BYTES,
        platform,
        hostPlatform
      );
      const document = result.ok ? validDeletionDocument(result.value, filename) : null;
      if (!document) {
        errors.push({ category: result.reason || 'invalid-device-deletion-document', filename });
        continue;
      }
      const prior = deletionCache.get(filename);
      if (!prior || compareSubscriptionRevision(document.revision, prior.revision) > 0) {
        deletionCache.set(filename, document);
      }
    }

    const visible = visibleDeviceEntries();
    return {
      records: visible.map((entry) => entry.record),
      documents: visible.map((entry) => entry.document),
      status: status(),
      errors
    };
  }

  async function loadRevisionLedger() {
    if (revisionLedgerLoaded) return revisionLedger;
    if (!revisionLedgerLoadPromise) {
      revisionLedgerLoadPromise = (async () => {
        const result = await readJsonFile(fsApi, revisionLedgerPath, MAX_REVISION_LEDGER_BYTES, platform, hostPlatform);
        if (!result.ok) {
          if (result.reason === 'missing') {
            revisionLedger = emptyRevisionLedger();
            revisionLedgerLoaded = true;
            return revisionLedger;
          }
          const error = new Error(`iCloud revision ledger unavailable: ${result.reason}`);
          error.code = result.reason === 'document-too-large' ? 'revision-ledger-too-large' : 'revision-ledger-invalid';
          throw error;
        }
        const valid = validRevisionLedger(result.value);
        if (!valid) {
          const error = new Error('Invalid iCloud revision ledger');
          error.code = 'revision-ledger-invalid';
          throw error;
        }
        revisionLedger = valid;
        revisionLedgerLoaded = true;
        return revisionLedger;
      })().finally(() => { revisionLedgerLoadPromise = null; });
    }
    return revisionLedgerLoadPromise;
  }

  async function refreshRevisionLedger() {
    const current = await loadRevisionLedger();
    const result = await readJsonFile(fsApi, revisionLedgerPath, MAX_REVISION_LEDGER_BYTES, platform, hostPlatform);
    if (!result.ok) {
      if (result.reason === 'missing') return current;
      const error = new Error(`iCloud revision ledger unavailable: ${result.reason}`);
      error.code = result.reason === 'document-too-large' ? 'revision-ledger-too-large' : 'revision-ledger-invalid';
      throw error;
    }
    const disk = validRevisionLedger(result.value);
    if (!disk) {
      const error = new Error('Invalid iCloud revision ledger');
      error.code = 'revision-ledger-invalid';
      throw error;
    }
    const devices = { ...current.devices };
    for (const [deviceId, revision] of Object.entries(disk.devices)) {
      devices[deviceId] = Math.max(Number(devices[deviceId] || 0), revision);
    }
    return {
      ...current,
      devices,
      subscriptionCounter: Math.max(current.subscriptionCounter, disk.subscriptionCounter),
      deletionCounter: Math.max(current.deletionCounter, disk.deletionCounter)
    };
  }

  function allocateRevision(update) {
    const task = revisionLedgerQueue.then(async () => {
      const current = await refreshRevisionLedger();
      const next = await update(current);
      await atomicWriteJson(fsApi, revisionLedgerPath, next.ledger, {
        platform,
        hostPlatform,
        maxBytes: MAX_REVISION_LEDGER_BYTES
      });
      revisionLedger = next.ledger;
      return next.revision;
    });
    revisionLedgerQueue = task.catch(() => {});
    return task;
  }

  async function nextDeviceRevision(deviceId, observedRevision) {
    return allocateRevision(async (ledger) => {
      const previous = Number(ledger.devices[deviceId] || 0);
      const revision = Math.max(previous, observedRevision || 0) + 1;
      const nextLedger = {
        ...ledger,
        devices: { ...ledger.devices, [deviceId]: revision }
      };
      return { revision, ledger: nextLedger };
    });
  }

  async function nextCounter(field, observedCounter) {
    return allocateRevision(async (ledger) => {
      const revision = Math.max(Number(ledger[field] || 0), observedCounter || 0) + 1;
      return { revision, ledger: { ...ledger, [field]: revision } };
    });
  }

  function deviceHeartbeatMs(wire) {
    const effectiveStaleAfterMs = staleAfterMsForSyncUpload(wire?.syncUploadIntervalMs, staleAfterMs);
    return effectiveStaleAfterMs > 0 ? Math.max(1_000, Math.floor(effectiveStaleAfterMs / 2)) : 0;
  }

  async function writeDeviceNow(record) {
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
    const available = await availablePaths();
    if (available.error || !available.paths.available) {
      const error = new Error('iCloud Drive is unavailable');
      error.code = available.paths.reason || 'icloud_unavailable';
      throw error;
    }
    const target = path.join(available.paths.devicesRoot, filename);
    const prior = deviceCache.get(filename);
    const existing = await readJsonFile(fsApi, target, MAX_ICLOUD_DOCUMENT_BYTES, platform, hostPlatform);
    const existingDocument = existing.ok ? validDeviceDocument(existing.value, filename) : null;
    const observedRevision = Math.max(
      Number(prior?.document?.revision || 0),
      Number(existingDocument?.revision || 0)
    );
    const fingerprint = semanticDeviceFingerprint(wire);
    const elapsedMs = lastDeviceWriteAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now() - lastDeviceWriteAt);
    if (
      lastDeviceFingerprint === fingerprint
      && (existingDocument || prior)
      && deviceHeartbeatMs(wire) > elapsedMs
    ) {
      return { ...(existingDocument || prior).document, skipped: true };
    }

    const revision = await nextDeviceRevision(deviceId, observedRevision);
    const document = {
      schemaVersion: ICLOUD_SCHEMA_VERSION,
      kind: 'device',
      deviceId,
      revision,
      updatedAt: String(wire.updatedAt || nowIso(now)),
      record: wire
    };
    try {
      await atomicWriteJson(fsApi, target, document, {
        platform,
        hostPlatform,
        maxBytes: MAX_ICLOUD_DOCUMENT_BYTES
      });
    } catch (error) {
      lastError = { category: error.code === 'document_too_large' ? 'document-too-large' : 'device-write-failed', error };
      error.code = error.code || lastError.category;
      throw error;
    }
    const normalized = validDeviceDocument(document, filename);
    deviceCache.set(filename, { document: normalized, record: normalized.record });
    lastDeviceFingerprint = fingerprint;
    lastDeviceWriteAt = now();
    return { ...normalized, skipped: false };
  }

  function writeDevice(record) {
    return enqueueDeviceMutation(() => writeDeviceNow(record));
  }

  async function deleteDeviceNow(deviceId) {
    const id = cleanId(deviceId, MAX_DEVICE_ID_LENGTH);
    const filename = deviceFilenameForId(id);
    if (!filename) {
      const error = new Error('Invalid device id');
      error.code = 'invalid_device_id';
      throw error;
    }
    const available = await availablePaths();
    if (available.error || !available.paths.available) {
      const error = new Error('iCloud Drive is unavailable');
      error.code = available.paths.reason || 'icloud_unavailable';
      throw error;
    }
    // Refresh first so a device that is present in the last-good cache, but
    // temporarily absent from the directory, still gets a precise tombstone.
    await discoverDevices();
    const existingDevice = await readJsonFile(
      fsApi,
      path.join(available.paths.devicesRoot, filename),
      MAX_ICLOUD_DOCUMENT_BYTES,
      platform,
      hostPlatform
    );
    const existingDocument = existingDevice.ok ? validDeviceDocument(existingDevice.value, filename) : null;
    const targetDeviceRevision = Math.max(
      Number(deviceCache.get(filename)?.document?.revision || 0),
      Number(existingDocument?.revision || 0)
    );
    const deletionFilename = writerFilenameForId(writerId);
    const prior = deletionCache.get(deletionFilename);
    const deletionMap = new Map((prior?.deletions || []).map((entry) => [entry.targetDeviceId, entry.targetDeviceRevision]));
    deletionMap.set(id, Math.max(deletionMap.get(id) || 0, targetDeviceRevision));
    const deletions = [...deletionMap.entries()]
      .map(([targetDeviceId, targetDeviceRevision]) => ({ targetDeviceId, targetDeviceRevision }))
      .sort((left, right) => left.targetDeviceId.localeCompare(right.targetDeviceId));
    if (deletions.length > MAX_DELETIONS_PER_WRITER) {
      const error = new Error('Too many iCloud device deletion markers');
      error.code = 'deletion-ledger-full';
      throw error;
    }
    const observedCounter = Number(prior?.revision?.counter || 0);
    const revision = await nextCounter('deletionCounter', observedCounter);
    const document = {
      schemaVersion: ICLOUD_SCHEMA_VERSION,
      kind: 'device-deletions',
      writerId,
      revision: { counter: revision, writerId },
      updatedAt: nowIso(now),
      deletions
    };
    try {
      await atomicWriteJson(
        fsApi,
        path.join(available.paths.deletionsRoot, deletionFilename),
        document,
        { platform, hostPlatform, maxBytes: MAX_ICLOUD_DOCUMENT_BYTES }
      );
    } catch (error) {
      lastError = { category: 'device-delete-failed', error };
      error.code = error.code || lastError.category;
      throw error;
    }
    deletionCache.set(deletionFilename, validDeletionDocument(document, deletionFilename));
    return { deleted: true, deviceId: id, targetDeviceRevision };
  }

  function deleteDevice(deviceId) {
    return enqueueDeviceMutation(() => deleteDeviceNow(deviceId));
  }

  async function discoverSubscriptions() {
    const available = await availablePaths();
    if (available.error || !available.paths.available) {
      const documents = [...subscriptionCache.values()];
      const winner = documents.slice().sort((left, right) => compareSubscriptionRevision(left.revision, right.revision)).at(-1) || null;
      return {
        documents,
        winner,
        revisionToken: revisionToken(winner?.revision),
        status: status(),
        errors: available.error ? [{ category: available.paths.reason || 'root-unavailable' }] : []
      };
    }
    const listing = await listFiles(available.paths.subscriptionsRoot, isKnownWriterFilename);
    const errors = listing.ok ? [] : [{ category: listing.reason }];
    for (const filename of listing.files || []) {
      const result = await readJsonFile(
        fsApi,
        path.join(available.paths.subscriptionsRoot, filename),
        MAX_ICLOUD_DOCUMENT_BYTES,
        platform,
        hostPlatform
      );
      const document = result.ok ? validSubscriptionDocument(result.value, filename) : null;
      if (!document) {
        errors.push({ category: result.reason || 'invalid-subscription-document', filename });
        continue;
      }
      const prior = subscriptionCache.get(filename);
      if (!prior || compareSubscriptionRevision(document.revision, prior.revision) > 0) {
        subscriptionCache.set(filename, document);
      }
    }
    const documents = [...subscriptionCache.values()];
    const winner = documents.slice().sort((left, right) => compareSubscriptionRevision(left.revision, right.revision)).at(-1) || null;
    return { documents, winner, revisionToken: revisionToken(winner?.revision), status: status(), errors };
  }

  async function writeSubscriptionsNow(subscriptions, { baseRevision = '' } = {}) {
    const normalized = normalizeSubscriptions(subscriptions);
    if (!Array.isArray(subscriptions) || normalized.length !== subscriptions.length) {
      const error = new Error('Invalid iCloud subscriptions');
      error.code = 'invalid_subscriptions';
      throw error;
    }
    const available = await availablePaths();
    if (available.error || !available.paths.available) {
      const error = new Error('iCloud Drive is unavailable');
      error.code = available.paths.reason || 'icloud_unavailable';
      throw error;
    }
    const current = await discoverSubscriptions();
    // A non-empty base is proof that the caller edited a known snapshot. If
    // that snapshot is temporarily invisible, accepting the write would let a
    // stale editor reset the shared list or its counter.
    if ((current.winner && baseRevision !== current.revisionToken) || (baseRevision && !current.winner)) {
      const error = new Error('The iCloud subscription list changed on another device');
      error.code = 'stale_write';
      error.current = current;
      throw error;
    }
    const maxCounter = current.documents.reduce((max, document) => Math.max(max, document.revision.counter), 0);
    const counter = await nextCounter('subscriptionCounter', maxCounter);
    const document = {
      schemaVersion: ICLOUD_SCHEMA_VERSION,
      kind: 'subscriptions',
      writerId,
      revision: { counter, writerId },
      updatedAt: nowIso(now),
      // An empty array is an explicit, valid snapshot. Absence of files is not.
      subscriptions: normalized
    };
    const filename = writerFilenameForId(writerId);
    try {
      await atomicWriteJson(
        fsApi,
        path.join(available.paths.subscriptionsRoot, filename),
        document,
        { platform, hostPlatform, maxBytes: MAX_ICLOUD_DOCUMENT_BYTES }
      );
    } catch (error) {
      lastError = { category: error.code === 'document_too_large' ? 'document-too-large' : 'subscription-write-failed', error };
      error.code = error.code || lastError.category;
      throw error;
    }
    subscriptionCache.set(filename, validSubscriptionDocument(document, filename));
    const refreshed = await discoverSubscriptions();
    return { ...refreshed, written: document };
  }

  function writeSubscriptions(subscriptions, options = {}) {
    return enqueueSubscriptionMutation(() => writeSubscriptionsNow(subscriptions, options));
  }

  return {
    clearError,
    close,
    deleteDevice,
    discoverDevices,
    discoverSubscriptions,
    getLastGoodDevices: () => visibleDeviceEntries().map((entry) => entry.record),
    whenIdle,
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
  MAX_ICLOUD_DOCUMENT_BYTES,
  atomicWriteJson,
  createIcloudSyncStore,
  defaultCloudDocsRoot,
  defaultRevisionLedgerPath,
  deviceFilenameForId,
  isKnownDeviceFilename,
  isKnownWriterFilename,
  pathState,
  readJsonFile,
  readOpenFlags,
  revisionToken,
  safePathForDisplay,
  semanticDeviceFingerprint,
  stripSensitive,
  syncDirectory,
  validDeletionDocument,
  writerFilenameForId
};
