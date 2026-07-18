'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { serializeMacWidgetSnapshot } = require('../shared/macWidgetSnapshot');

function resolveMacWidgetSnapshotPath(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return null;
  const appGroup = String(options.appGroup || '').trim();
  const home = String(options.home || '').trim();
  const snapshotFileName = String(options.snapshotFileName || 'snapshot.json').trim();
  if (!/^(?:group|[A-Z0-9]{10})(?:\.[A-Za-z0-9-]+)+$/.test(appGroup) || !home) return null;
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

async function writeMacWidgetSnapshot(serializedSnapshot, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return { ok: false, reason: 'unsupported-platform' };

  const snapshotPath = String(options.snapshotPath || '').trim();
  if (!snapshotPath) return { ok: false, reason: 'not-configured' };

  const fsApi = options.fs || fs;
  const logger = options.logger;
  const directory = path.dirname(snapshotPath);
  const tempPath = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    let changed = true;
    try {
      changed = await fsApi.readFile(snapshotPath, 'utf8') !== String(serializedSnapshot);
    } catch (_) {}
    if (!changed) return { ok: true, path: snapshotPath, changed: false };
    await fsApi.mkdir(directory, { recursive: true });
    handle = await fsApi.open(tempPath, 'w', 0o600);
    await handle.writeFile(String(serializedSnapshot), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsApi.rename(tempPath, snapshotPath);
    await syncDirectory(fsApi, directory);
    return { ok: true, path: snapshotPath, changed: true };
  } catch (error) {
    try { await handle?.close(); } catch (_) {}
    try { await fsApi.unlink(tempPath); } catch (_) {}
    safeLog(logger, `[mac-widget] snapshot write failed: ${error?.message || error}`);
    return { ok: false, reason: 'write-failed', error };
  }
}

async function updateMacWidgetSnapshot(stats, options = {}) {
  let serialized;
  try {
    serialized = serializeMacWidgetSnapshot(stats, options.snapshotOptions);
  } catch (error) {
    safeLog(options.logger, `[mac-widget] snapshot serialization failed: ${error?.message || error}`);
    return { ok: false, reason: 'serialization-failed', error };
  }
  return writeMacWidgetSnapshot(serialized, options);
}

module.exports = {
  resolveMacWidgetSnapshotPath,
  updateMacWidgetSnapshot,
  writeMacWidgetSnapshot
};
