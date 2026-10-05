'use strict';

const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { clearBackgroundImage, getBackgroundImage, getRecoverableBackgroundImage, importBackgroundImage, recoverBackgroundImage } = require('./backgroundImage');

const VIDEO_SCHEME = 'token-monitor-background';
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const MANIFEST = 'background-video.json';
const VIDEO_FILE = /^background-video-[a-f0-9-]{36}\.(mp4|webm)$/;
const VIDEO_PRIVILEGES = { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true };

function validateVideoFile(stat) {
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_VIDEO_BYTES) {
    throw new Error('Video must be a file no larger than 256 MB');
  }
}

async function copyBoundedVideo(sourcePath, destination, onCreated) {
  const source = await fs.open(sourcePath, 'r');
  try {
    validateVideoFile(await source.stat());
    let bytes = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_VIDEO_BYTES) callback(new Error('Video must be a file no larger than 256 MB'));
        else callback(null, chunk);
      }
    });
    // Pin the opened file and read at most one byte beyond the limit, even
    // if a download or sync client keeps growing it during the copy.
    const target = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    target.once('open', onCreated);
    await pipeline(
      source.createReadStream({ start: 0, end: MAX_VIDEO_BYTES }),
      limit,
      target
    );
    validateVideoFile(await fs.stat(destination));
  } finally {
    await source.close();
  }
}

function createBackgroundVideoManager(userDataPath) {
  let pending = null;
  let mutation = Promise.resolve();
  // Serialize publication and removal so each operation sees the last saved
  // record and a duplicate commit cannot clean up another writer's files.
  function mutate(operation, allowRecoveryFailure = false) {
    const result = mutation.then(async () => {
      let recoveryError;
      try { await recoverBackgroundImage(userDataPath, await currentVideoId()); } catch (error) {
        if (!allowRecoveryFailure) throw error;
        recoveryError = error;
      }
      return operation(recoveryError);
    });
    mutation = result.catch(() => {});
    return result;
  }
  const manifestPath = path.join(userDataPath, MANIFEST);
  const publicRecord = (record, preview = false) => ({
    id: record.id,
    name: record.name,
    url: `${VIDEO_SCHEME}://video/${preview ? 'preview' : 'current'}?id=${record.id}`
  });

  async function readRecord() {
    let record;
    try {
      record = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!VIDEO_FILE.test(record.fileName || '') || record.fileName !== `background-video-${record.id}${path.extname(record.fileName)}`
      || (record.cleanupFiles !== undefined && (!Array.isArray(record.cleanupFiles)
        || record.cleanupFiles.some((file) => typeof file !== 'string' || !VIDEO_FILE.test(file) || file === record.fileName)))) {
      throw new Error('Invalid saved background video');
    }
    let available = false;
    try {
      const stat = await fs.stat(path.join(userDataPath, record.fileName));
      if (!stat.isFile() || stat.size === 0) throw new Error('Saved background video is unavailable');
      available = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Missing active media is a cleanup tombstone, not an absent manifest:
    // its retired files and failed metadata deletion still need to be retried.
    return { ...record, available };
  }

  async function currentVideoId() {
    const record = await readRecord();
    return record?.available ? record.id : null;
  }

  async function removeFile(file) {
    try { await fs.unlink(path.join(userDataPath, file)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function cleanupRetired(record) {
    for (const file of record?.cleanupFiles || []) await removeFile(file);
  }

  async function getSaved() {
    const record = await readRecord();
    if (!record) return null;
    if (!record.available) return { cleanupPending: true };
    let cleanupPending = false;
    for (const file of record.cleanupFiles || []) {
      try { await fs.stat(path.join(userDataPath, file)); cleanupPending = true; } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return { ...publicRecord(record), ...(cleanupPending ? { cleanupPending: true } : {}) };
  }

  async function prepare(sourcePath) {
    const extension = path.extname(sourcePath).toLowerCase();
    if (!['.mp4', '.webm'].includes(extension)) throw new Error('Use an MP4 or WebM video');
    const stat = await fs.stat(sourcePath);
    validateVideoFile(stat);
    pending = { id: randomUUID(), name: path.basename(sourcePath), sourcePath, extension };
    return publicRecord(pending, true);
  }

  async function commit(id) {
    if (!pending || pending.id !== id) throw new Error('Select the video again');
    const selection = pending;
    return mutate(async () => {
      if (pending !== selection) throw new Error('Select the video again');
      const previous = await readRecord();
      await cleanupRetired(previous);
      const fileName = `background-video-${id}${selection.extension}`;
      const destination = path.join(userDataPath, fileName);
      const temporaryManifest = path.join(userDataPath, `.background-video-${id}.json`);
      const cleanupFiles = previous ? [previous.fileName] : [];
      const record = { id, name: selection.name, fileName, ...(cleanupFiles.length ? { cleanupFiles } : {}) };
      let ownsVideo = false;
      let ownsManifest = false;
      await fs.mkdir(userDataPath, { recursive: true });
      try {
        await copyBoundedVideo(selection.sourcePath, destination, () => { ownsVideo = true; });
        const manifest = await fs.open(temporaryManifest, 'wx', 0o600);
        ownsManifest = true;
        try {
          await manifest.writeFile(JSON.stringify(record));
        } finally {
          await manifest.close();
        }
        await fs.rename(temporaryManifest, manifestPath);
      } catch (error) {
        // An exclusive-create failure does not give us ownership of the path.
        if (ownsVideo) await fs.unlink(destination).catch(() => {});
        if (ownsManifest) await fs.unlink(temporaryManifest).catch(() => {});
        throw error;
      }
      if (pending === selection) pending = null;
      // Publish cleanup ownership with the new record before deleting the old
      // copy. A locked retired video stays discoverable across restart/retry.
      await cleanupRetired(record);
      return publicRecord(record);
    });
  }

  async function clearSaved(selection) {
    const previous = await readRecord();
    await cleanupRetired(previous);
    // Deleting the active media is the irreversible commit point. A later
    // metadata error must be reported, but must not roll back a published PNG.
    if (previous) await removeFile(previous.fileName);
    if (pending === selection) pending = null;
    await removeFile(MANIFEST);
  }

  async function clear() {
    const selection = pending;
    return mutate(() => clearSaved(selection));
  }

  async function importImage(sourcePath, nativeImage) {
    const selection = pending;
    return mutate(async () => {
      // Resolve older cleanup before publishing a PNG, including a tombstone
      // with no active video. A locked retired copy must leave the old PNG alone.
      await cleanupRetired(await readRecord());
      return importBackgroundImage(sourcePath, userDataPath, nativeImage, {
        clearVideo: () => clearSaved(selection), getVideoId: currentVideoId
      });
    });
  }

  async function resolve(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== `${VIDEO_SCHEME}:` || parsed.hostname !== 'video') return null;
    const id = parsed.searchParams.get('id');
    if (parsed.pathname === '/preview') return pending?.id === id ? pending.sourcePath : null;
    if (parsed.pathname !== '/current') return null;
    const record = await readRecord();
    return record?.available && record.id === id ? path.join(userDataPath, record.fileName) : null;
  }

  return {
    prepare, commit, clear, resolve, importImage,
    clearImage: () => mutate(() => clearBackgroundImage(userDataPath)),
    getImage: () => mutate(async (recoveryError) => recoveryError
      ? getRecoverableBackgroundImage(userDataPath, await currentVideoId()) : getBackgroundImage(userDataPath), true),
    cancel(id) { if (pending?.id === id) pending = null; },
    get: () => mutate(async (recoveryError) => {
      const record = await getSaved();
      return recoveryError ? { ...record, cleanupPending: true } : record;
    }, true)
  };
}

function installBackgroundVideo({ app, ipcMain, dialog, protocol, net, getWindow }) {
  const manager = createBackgroundVideoManager(app.getPath('userData'));
  protocol.handle(VIDEO_SCHEME, async (request) => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    try {
      const file = await manager.resolve(request.url);
      if (!file) return new Response(null, { status: 404 });
      const range = request.headers.get('range');
      return net.fetch(pathToFileURL(file).href, {
        method: request.method,
        ...(range ? { headers: { Range: range } } : {})
      });
    } catch (_) {
      return new Response(null, { status: 404 });
    }
  });
  ipcMain.handle('appearance:getBackgroundVideo', () => manager.get());
  ipcMain.handle('appearance:chooseBackgroundVideo', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: ['openFile'], filters: [{ name: 'Videos', extensions: ['mp4', 'webm'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { preview: await manager.prepare(result.filePaths[0]) };
  });
  ipcMain.handle('appearance:commitBackgroundVideo', (_event, id) => manager.commit(id));
  ipcMain.handle('appearance:cancelBackgroundVideo', (_event, id) => { manager.cancel(id); return true; });
  ipcMain.handle('appearance:clearBackgroundVideo', async () => { await manager.clear(); return true; });
  return manager;
}

module.exports = { VIDEO_SCHEME, VIDEO_PRIVILEGES, MAX_VIDEO_BYTES, createBackgroundVideoManager, installBackgroundVideo };
