'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'background-image.png';
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

function imageDataUrl(bytes) {
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

async function getBackgroundImage(userDataPath) {
  try {
    return imageDataUrl(await readRegularImage(backgroundImagePath(userDataPath), MAX_SAVED_BYTES));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function importBackgroundImage(sourcePath, userDataPath, nativeImage) {
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
  const temporary = path.join(userDataPath, `.background-image-${crypto.randomUUID()}.png`);
  try {
    await fs.promises.writeFile(temporary, png, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, destination);
  } finally {
    await fs.promises.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
  return imageDataUrl(png);
}

async function clearBackgroundImage(userDataPath) {
  try {
    await fs.promises.unlink(backgroundImagePath(userDataPath));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

module.exports = { backgroundImagePath, clearBackgroundImage, getBackgroundImage, importBackgroundImage };
