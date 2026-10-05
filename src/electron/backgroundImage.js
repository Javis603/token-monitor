'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'background-image.png';
const RECOVERY_NAME = '.background-image-recovery.json';
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_SAVED_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 2000;

function backgroundImagePath(userDataPath) {
  return path.join(userDataPath, FILE_NAME);
}

async function readRegularImage(filePath, limit) {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error('Image file is too large or invalid');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function getBackgroundImage(userDataPath) {
  try {
    return await readRegularImage(backgroundImagePath(userDataPath), MAX_SAVED_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function digest(bytes) {
  return bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex');
}

async function writePrivate(file, bytes) {
  const handle = await fs.promises.open(file, 'wx', 0o600);
  let failure;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) { failure = error; }
  try { await handle.close(); } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Writing and closing background file failed', { cause: failure }) : error;
  }
  if (failure) throw failure;
}

async function removeIfPresent(file) {
  try { await fs.promises.unlink(file); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

// An exclusively created private directory is durable ownership of unfinished
// staging. Retry can clean partial writes/failed closes without mistaking an
// incomplete journal for the only rollback backup. Never recurse into unknown
// entries or follow directory symlinks from disk.
async function cleanupStage(directory) {
  for (const file of ['candidate.png', 'recovery.json', 'restore.png']) {
    await removeIfPresent(path.join(directory, file));
  }
  try { await fs.promises.rmdir(directory); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function cleanupStages(userDataPath) {
  let entries;
  try { entries = await fs.promises.readdir(userDataPath, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && /^\.background-image-stage-[A-Za-z0-9]{6}$/.test(entry.name)) {
      await cleanupStage(path.join(userDataPath, entry.name));
    }
  }
}

async function withStage(userDataPath, operation) {
  const directory = await fs.promises.mkdtemp(path.join(userDataPath, '.background-image-stage-'));
  let failure;
  let result;
  try { result = await operation(directory); } catch (error) { failure = error; }
  try { await cleanupStage(directory); } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Background operation and staging cleanup failed', { cause: failure }) : error;
  }
  if (failure) throw failure;
  return result;
}

// The private journal is also the durable old-PNG backup. It survives a failed
// restore, and records enough state to distinguish rollback from a committed
// image whose video/backup metadata cleanup failed. Call in the media mutation
// lane before any newer image or video can replace that evidence.
async function readRecovery(userDataPath) {
  const recovery = path.join(userDataPath, RECOVERY_NAME);
  let saved;
  try {
    saved = JSON.parse(await readRegularImage(recovery, 12 * 1024 * 1024));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (saved.version !== 1 || !/^[a-f0-9]{64}$/.test(saved.imageHash)
    || (saved.previousVideoId !== null && !/^[a-f0-9-]{36}$/.test(saved.previousVideoId))
    || (saved.previousImage !== null && typeof saved.previousImage !== 'string')) {
    throw new Error('Invalid background image recovery record');
  }
  const previous = saved.previousImage === null ? null : Buffer.from(saved.previousImage, 'base64');
  if (previous !== null && (previous.length === 0 || previous.length > MAX_SAVED_BYTES
    || previous.toString('base64') !== saved.previousImage)) throw new Error('Invalid background image recovery backup');
  return { saved, previous };
}

// Even if a locked cleanup/restore cannot finish, reads must show the logical
// saved state. The backup remains the selected image until its video is gone.
async function getRecoverableBackgroundImage(userDataPath, currentVideoId) {
  const recovery = await readRecovery(userDataPath);
  if (recovery && recovery.saved.previousVideoId !== null
    && recovery.saved.previousVideoId === currentVideoId) return recovery.previous;
  return getBackgroundImage(userDataPath);
}

async function recoverBackgroundImage(userDataPath, currentVideoId = null) {
  const recovery = path.join(userDataPath, RECOVERY_NAME);
  const record = await readRecovery(userDataPath);
  if (!record) { await cleanupStages(userDataPath); return; }
  const { saved, previous } = record;
  const currentHash = digest(await getBackgroundImage(userDataPath));
  const previousHash = digest(previous);
  if (![previousHash, saved.imageHash].includes(currentHash)) {
    throw new Error('Background image changed while recovery is pending');
  }
  const committed = currentHash === saved.imageHash
    && (saved.previousVideoId === null || currentVideoId !== saved.previousVideoId);
  if (!committed && currentHash !== previousHash) {
    if (previous === null) await removeIfPresent(backgroundImagePath(userDataPath));
    else {
      await withStage(userDataPath, async (directory) => {
        const temporary = path.join(directory, 'restore.png');
        await writePrivate(temporary, previous);
        await fs.promises.rename(temporary, backgroundImagePath(userDataPath));
      });
    }
  }
  await cleanupStages(userDataPath);
  await removeIfPresent(recovery);
}

async function importBackgroundImage(sourcePath, userDataPath, nativeImage, {
  clearVideo = async () => {}, getVideoId = async () => null
} = {}) {
  await recoverBackgroundImage(userDataPath, await getVideoId());
  const bytes = await readRegularImage(sourcePath, MAX_SOURCE_BYTES);
  let image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('Image format is not supported');
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) throw new Error('Image dimensions are invalid');
  if (width > MAX_EDGE || height > MAX_EDGE) {
    const scale = Math.min(MAX_EDGE / width, MAX_EDGE / height);
    image = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
  }
  const png = image.toPNG();
  if (png.length === 0 || png.length > MAX_SAVED_BYTES) throw new Error('Image is too large after conversion');

  const destination = backgroundImagePath(userDataPath);
  const recovery = path.join(userDataPath, RECOVERY_NAME);
  await withStage(userDataPath, async (directory) => {
    const temporary = path.join(directory, 'candidate.png');
    await writePrivate(temporary, png);
    let failure;
    try {
      const previous = await getBackgroundImage(userDataPath);
      const stagedRecovery = path.join(directory, 'recovery.json');
      await writePrivate(stagedRecovery, JSON.stringify({
        version: 1, previousImage: previous?.toString('base64') ?? null,
        previousVideoId: await getVideoId(), imageHash: digest(png)
      }));
      await fs.promises.rename(stagedRecovery, recovery);
      // Publication must succeed before deleting the video. The durable backup
      // lets a failed deletion roll the PNG back, including on a later retry.
      await fs.promises.rename(temporary, destination);
      await clearVideo();
    } catch (error) { failure = error; }
    try {
      await recoverBackgroundImage(userDataPath, await getVideoId());
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Background image change and recovery failed', { cause: failure }) : error;
    }
    if (failure) throw failure;
  });
  // Bytes, not a data URL: Blink silently truncates CSS values set through
  // setProperty() at 2 MiB, which truncated the url("data:...") value and left
  // larger saved PNGs invisible. The renderer turns these bytes into a blob:
  // URL, which has no such limit.
  return png;
}

async function clearBackgroundImage(userDataPath) {
  try {
    await fs.promises.unlink(backgroundImagePath(userDataPath));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

module.exports = { backgroundImagePath, clearBackgroundImage, getBackgroundImage, getRecoverableBackgroundImage, importBackgroundImage, recoverBackgroundImage };
