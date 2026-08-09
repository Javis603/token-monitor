'use strict';

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  buildMacWidgetSnapshot,
  macWidgetSnapshotFingerprint,
  macWidgetSnapshotFingerprintFromSerialized,
  macWidgetSnapshotNeedsWrite
} = require('../shared/macWidgetSnapshot');
const { validateAppGroupSyntax } = require('../shared/macWidgetConfig');

function resolveMacWidgetSnapshotPath(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return null;
  const appGroup = String(options.appGroup || '').trim();
  const home = String(options.home || '').trim();
  const snapshotFileName = String(options.snapshotFileName || 'snapshot.json').trim();
  if (!home) return null;
  try {
    validateAppGroupSyntax(appGroup);
  } catch (_) {
    return null;
  }
  if (!snapshotFileName || path.basename(snapshotFileName) !== snapshotFileName) return null;
  return path.join(home, 'Library', 'Group Containers', appGroup, snapshotFileName);
}

function safeLog(logger, message) {
  try { logger?.(message); } catch (_) {}
}

async function syncDirectory(fsApi, directory) {
  let handle;
  try {
    handle = await fsApi.open(directory, 'r');
    await handle.sync();
  } catch (_) {
    // Some filesystems do not support fsync on directories. The file itself is
    // already synced, and rename remains atomic within the destination folder.
  } finally {
    try { await handle?.close(); } catch (_) {}
  }
}

async function discardMacWidgetSnapshot(prepared) {
  if (!prepared?.tempPath) return;
  try { await (prepared.fs || fs).unlink(prepared.tempPath); } catch (_) {}
}

async function prepareMacWidgetSnapshot(serializedSnapshot, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return { ok: false, reason: 'unsupported-platform' };

  const snapshotPath = String(options.snapshotPath || '').trim();
  if (!snapshotPath) return { ok: false, reason: 'not-configured' };
  if (options.isCurrent && !options.isCurrent()) return { ok: false, reason: 'superseded' };

  const fsApi = options.fs || fs;
  const logger = options.logger;
  const directory = path.dirname(snapshotPath);
  const tempPath = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    const snapshotText = String(serializedSnapshot);
    const currentFingerprint = options.fingerprint || macWidgetSnapshotFingerprintFromSerialized(snapshotText);
    let currentSnapshot;
    try { currentSnapshot = JSON.parse(snapshotText); } catch (_) {}
    let changed = true;
    try {
      const previousText = await fsApi.readFile(snapshotPath, 'utf8');
      const previousFingerprint = macWidgetSnapshotFingerprintFromSerialized(previousText);
      let previousSnapshot;
      try { previousSnapshot = JSON.parse(String(previousText)); } catch (_) {}
      changed = currentFingerprint !== null && previousFingerprint !== null && currentSnapshot && previousSnapshot
        ? macWidgetSnapshotNeedsWrite(currentSnapshot, previousSnapshot, { now: options.freshnessNow })
        : previousText !== snapshotText;
    } catch (_) {}
    if (!changed) return { ok: true, path: snapshotPath, changed: false };
    await fsApi.mkdir(directory, { recursive: true });
    handle = await fsApi.open(tempPath, 'w', 0o600);
    await handle.writeFile(snapshotText, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    return {
      ok: true,
      changed: true,
      prepared: { directory, fs: fsApi, snapshotPath, tempPath }
    };
  } catch (error) {
    try { await handle?.close(); } catch (_) {}
    try { await fsApi.unlink(tempPath); } catch (_) {}
    safeLog(logger, `[mac-widget] snapshot write failed: ${error?.message || error}`);
    return { ok: false, reason: 'write-failed', error };
  }
}

function createCommitMacWidgetSnapshot(renameSync) {
  return function commitPreparedSnapshot(prepared, options = {}) {
    if (!prepared?.tempPath || !prepared?.snapshotPath) {
      return { ok: false, reason: 'not-prepared' };
    }
    try {
      if (options.isCurrent && !options.isCurrent()) return { ok: false, reason: 'superseded' };
      renameSync(prepared.tempPath, prepared.snapshotPath);
      return {
        ok: true,
        path: prepared.snapshotPath,
        changed: true,
        directory: prepared.directory
      };
    } catch (error) {
      safeLog(options.logger, `[mac-widget] snapshot write failed: ${error?.message || error}`);
      return { ok: false, reason: 'write-failed', error };
    }
  };
}

const commitMacWidgetSnapshot = createCommitMacWidgetSnapshot(fsSync.renameSync);

async function syncMacWidgetSnapshotDirectory(result, options = {}) {
  const directory = result?.directory;
  if (!directory) return;
  await syncDirectory(options.fs || result.fs || fs, directory);
}

async function writeMacWidgetSnapshot(serializedSnapshot, options = {}) {
  const result = await prepareMacWidgetSnapshot(serializedSnapshot, options);
  if (!result.ok || result.changed === false) return result;

  const prepared = result.prepared;
  const commitSnapshot = options.renameSync
    ? createCommitMacWidgetSnapshot(options.renameSync)
    : commitMacWidgetSnapshot;
  const committed = commitSnapshot(prepared, {
    isCurrent: options.isCurrent,
    logger: options.logger
  });
  if (!committed.ok) {
    await discardMacWidgetSnapshot(prepared);
    return committed;
  }
  await syncMacWidgetSnapshotDirectory({ ...committed, fs: prepared.fs });
  return { ok: true, path: committed.path, changed: true };
}

async function prepareMacWidgetSnapshotUpdate(stats, options = {}) {
  let snapshot;
  let serialized;
  const snapshotOptions = options.snapshotOptions || {};
  try {
    snapshot = buildMacWidgetSnapshot(stats, snapshotOptions);
    serialized = `${JSON.stringify(snapshot)}\n`;
  } catch (error) {
    safeLog(options.logger, `[mac-widget] snapshot serialization failed: ${error?.message || error}`);
    return { ok: false, reason: 'serialization-failed', error };
  }
  return prepareMacWidgetSnapshot(serialized, {
    ...options,
    fingerprint: macWidgetSnapshotFingerprint(snapshot),
    freshnessNow: options.freshnessNow || snapshotOptions.now || snapshot.generatedAt
  });
}

async function updateMacWidgetSnapshot(stats, options = {}) {
  const result = await prepareMacWidgetSnapshotUpdate(stats, options);
  if (!result.ok || result.changed === false) return result;
  const prepared = result.prepared;
  const commitSnapshot = options.renameSync
    ? createCommitMacWidgetSnapshot(options.renameSync)
    : commitMacWidgetSnapshot;
  const committed = commitSnapshot(prepared, {
    isCurrent: options.isCurrent,
    logger: options.logger
  });
  if (!committed.ok) {
    await discardMacWidgetSnapshot(prepared);
    return committed;
  }
  await syncMacWidgetSnapshotDirectory({ ...committed, fs: prepared.fs });
  return { ok: true, path: committed.path, changed: true };
}

module.exports = {
  commitMacWidgetSnapshot,
  createCommitMacWidgetSnapshot,
  discardMacWidgetSnapshot,
  prepareMacWidgetSnapshot,
  prepareMacWidgetSnapshotUpdate,
  resolveMacWidgetSnapshotPath,
  syncMacWidgetSnapshotDirectory,
  updateMacWidgetSnapshot,
  writeMacWidgetSnapshot
};
