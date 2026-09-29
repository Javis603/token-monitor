'use strict';

const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

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

async function copyBoundedVideo(sourcePath, destination) {
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
    await pipeline(
      source.createReadStream({ start: 0, end: MAX_VIDEO_BYTES }),
      limit,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    );
    validateVideoFile(await fs.stat(destination));
  } finally {
    await source.close();
  }
}

function createBackgroundVideoManager(userDataPath) {
  let pending = null;
  const manifestPath = path.join(userDataPath, MANIFEST);
  const publicRecord = (record, preview = false) => ({
    id: record.id,
    name: record.name,
    url: `${VIDEO_SCHEME}://video/${preview ? 'preview' : 'current'}?id=${record.id}`
  });

  async function readRecord() {
    try {
      const record = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!VIDEO_FILE.test(record.fileName || '') || record.fileName !== `background-video-${record.id}${path.extname(record.fileName)}`) {
        throw new Error('Invalid saved background video');
      }
      const stat = await fs.stat(path.join(userDataPath, record.fileName));
      if (!stat.isFile() || stat.size === 0) throw new Error('Saved background video is unavailable');
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
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
    const previous = await readRecord();
    const fileName = `background-video-${id}${selection.extension}`;
    const destination = path.join(userDataPath, fileName);
    const temporaryManifest = path.join(userDataPath, `.background-video-${id}.json`);
    const record = { id, name: selection.name, fileName };
    await fs.mkdir(userDataPath, { recursive: true });
    try {
      await copyBoundedVideo(selection.sourcePath, destination);
      await fs.writeFile(temporaryManifest, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporaryManifest, manifestPath);
    } catch (error) {
      await fs.unlink(destination).catch(() => {});
      await fs.unlink(temporaryManifest).catch(() => {});
      throw error;
    }
    pending = null;
    if (previous) await fs.unlink(path.join(userDataPath, previous.fileName)).catch(() => {});
    return publicRecord(record);
  }

  async function clear() {
    const previous = await readRecord();
    await fs.unlink(manifestPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    pending = null;
    if (previous) await fs.unlink(path.join(userDataPath, previous.fileName)).catch(() => {});
  }

  async function resolve(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== `${VIDEO_SCHEME}:` || parsed.hostname !== 'video') return null;
    const id = parsed.searchParams.get('id');
    if (parsed.pathname === '/preview') return pending?.id === id ? pending.sourcePath : null;
    if (parsed.pathname !== '/current') return null;
    const record = await readRecord();
    return record?.id === id ? path.join(userDataPath, record.fileName) : null;
  }

  return {
    prepare, commit, clear, resolve,
    cancel(id) { if (pending?.id === id) pending = null; },
    async get() { const record = await readRecord(); return record ? publicRecord(record) : null; }
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
