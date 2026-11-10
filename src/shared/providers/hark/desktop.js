'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { errorWithStatus } = require('../../limits/providerHelpers');

// Hark's macOS session uses WebKit binarycookies, not Chromium SQLite.
const HARK_COOKIE_FILE = 'com.harklabs.hark.mac.binarycookies';
const HARK_COOKIE_NAME = '__Secure-hark.session_token';
const HARK_COOKIE_HOSTS = new Set(['hark.com', '.hark.com']);

function harkDesktopCookieCandidates(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return [];
  const home = options.home || os.homedir();
  return [path.join(home, 'Library', 'HTTPStorages', HARK_COOKIE_FILE)];
}

function cString(buffer, offset) {
  if (offset < 32 || offset >= buffer.length) throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
  const end = buffer.indexOf(0, offset);
  if (end < 0) throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
  return buffer.toString('utf8', offset, end);
}

function readBinaryCookies(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.toString('ascii', 0, 4) !== 'cook') {
    throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
  }
  const pageCount = buffer.readUInt32BE(4);
  const headerBytes = 8 + pageCount * 4;
  if (!pageCount || headerBytes > buffer.length) {
    throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
  }
  const cookies = [];
  let pageOffset = headerBytes;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageSize = buffer.readUInt32BE(8 + pageIndex * 4);
    if (pageSize < 8 || pageOffset + pageSize > buffer.length) {
      throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
    }
    const page = buffer.subarray(pageOffset, pageOffset + pageSize);
    pageOffset += pageSize;
    const count = page.readUInt32LE(4);
    if (8 + count * 4 > page.length) {
      throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
    }
    for (let cookieIndex = 0; cookieIndex < count; cookieIndex += 1) {
      const recordOffset = page.readUInt32LE(8 + cookieIndex * 4);
      if (recordOffset < 8 + count * 4 || recordOffset + 32 > page.length) {
        throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
      }
      const recordSize = page.readUInt32LE(recordOffset);
      if (recordSize < 32 || recordOffset + recordSize > page.length) {
        throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
      }
      const record = page.subarray(recordOffset, recordOffset + recordSize);
      cookies.push({
        domain: cString(record, record.readUInt32LE(16)),
        name: cString(record, record.readUInt32LE(20)),
        path: cString(record, record.readUInt32LE(24)),
        value: cString(record, record.readUInt32LE(28))
      });
    }
  }
  return cookies;
}

// Unreadable stores are unavailable; only a missing store/cookie means signed out.
function readHarkDesktopSession(options = {}) {
  const fsApi = options.fs || fs;
  const candidates = options.candidates || harkDesktopCookieCandidates(options);
  if (!candidates.length) {
    throw errorWithStatus('notConfigured', 'Hark desktop session is not supported on this platform');
  }

  let statFailure = null;
  const filePath = candidates.find((candidate) => {
    try {
      return fsApi.statSync(candidate).isFile();
    } catch (error) {
      if (error?.code !== 'ENOENT') statFailure = error;
      return false;
    }
  });
  if (!filePath) {
    if (statFailure) throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
    throw errorWithStatus('notConfigured', 'Hark desktop app is not signed in');
  }

  let cookies;
  try {
    cookies = readBinaryCookies(fsApi.readFileSync(filePath));
  } catch (error) {
    if (error?.status) throw error;
    throw errorWithStatus('unavailable', 'Hark cookie store could not be read');
  }
  const row = cookies.find((cookie) => cookie.name === HARK_COOKIE_NAME && HARK_COOKIE_HOSTS.has(cookie.domain));
  return typeof row?.value === 'string' ? row.value : '';
}

module.exports = {
  HARK_COOKIE_FILE,
  HARK_COOKIE_HOSTS,
  HARK_COOKIE_NAME,
  harkDesktopCookieCandidates,
  readBinaryCookies,
  readHarkDesktopSession
};
