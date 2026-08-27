'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { traeAccountKey, traeTokenAccountId } = require('./traeAccount');

const TRAE_AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide';
const TRAE_AUTH_FILE_MAX_BYTES = 4 * 1024 * 1024;

// Trae's local auth record uses its byteCrypto AES envelope. These are the two
// application constants XORed by Trae before the per-record key is derived.
// The plaintext is never written back or persisted by Token Monitor: only the
// current in-process access token and non-secret account metadata are returned.
const TRAE_AES_MASK_LEFT = Buffer.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37
]);
const TRAE_AES_MASK_RIGHT = Buffer.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125
]);

function sha512(value) {
  return crypto.createHash('sha512').update(value).digest();
}

function decryptTraeAuthStorageValue(value) {
  const envelope = Buffer.from(String(value || ''), 'base64');
  if (
    envelope.length < 54
    || envelope[0] !== 116
    || envelope[1] !== 99
    || envelope[2] !== 5
    || envelope[3] !== 16
  ) {
    throw new Error('Unsupported Trae local credential format');
  }

  const recordKey = envelope.subarray(6, 38);
  const material = Buffer.alloc(128);
  sha512(recordKey).copy(material, 0);
  for (let index = 0; index < 64; index += 1) {
    material[64 + index] = TRAE_AES_MASK_LEFT[index] ^ TRAE_AES_MASK_RIGHT[index];
  }
  sha512(material).copy(material, 0);

  const decipher = crypto.createDecipheriv(
    'aes-128-cbc',
    material.subarray(0, 16),
    material.subarray(16, 32)
  );
  const plaintext = Buffer.concat([
    decipher.update(envelope.subarray(38)),
    decipher.final()
  ]);
  if (plaintext.length < 65) throw new Error('Truncated Trae local credential');

  const body = plaintext.subarray(64);
  if (!crypto.timingSafeEqual(plaintext.subarray(0, 64), sha512(body))) {
    throw new Error('Trae local credential integrity check failed');
  }
  const userInfo = JSON.parse(body.toString('utf8'));
  if (!userInfo || typeof userInfo !== 'object') throw new Error('Invalid Trae local credential payload');
  return userInfo;
}

function traeLocalAuthStoragePaths(options = {}) {
  if (Array.isArray(options.storagePaths)) {
    return [...new Set(options.storagePaths.map(String).filter(Boolean))];
  }
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  let appSupport;
  if (platform === 'darwin') appSupport = path.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') appSupport = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  else appSupport = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['TRAE SOLO CN', 'Trae CN'].map((directory) => (
    path.join(appSupport, directory, 'User', 'globalStorage', 'storage.json')
  ));
}

function tokenExpiryIso(userInfo, accessToken) {
  const direct = Date.parse(String(userInfo?.expiredAt || ''));
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const parts = String(accessToken || '').split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const seconds = Number(payload?.exp);
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '';
  } catch (_) {
    return '';
  }
}

function readTraeAuthDocument(storagePath, options) {
  if (typeof options.readFileSync === 'function') {
    return options.readFileSync(storagePath, 'utf8');
  }
  const stat = fs.lstatSync(storagePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > TRAE_AUTH_FILE_MAX_BYTES) {
    throw new Error('Unsafe Trae local credential file');
  }
  return fs.readFileSync(storagePath, 'utf8');
}

function readTraeLocalAccount(options = {}) {
  for (const storagePath of traeLocalAuthStoragePaths(options)) {
    try {
      const document = JSON.parse(readTraeAuthDocument(storagePath, options));
      const encoded = document?.[TRAE_AUTH_STORAGE_KEY];
      if (!encoded) continue;
      const userInfo = decryptTraeAuthStorageValue(encoded);
      const accessToken = String(userInfo.token || '').trim();
      if (!accessToken) continue;
      const accountId = String(userInfo.userId || traeTokenAccountId(accessToken) || '').trim();
      return {
        accessToken,
        accountId,
        accountKey: traeAccountKey(accessToken, accountId),
        accountLabel: String(userInfo.account?.username || userInfo.account?.email || '').trim().slice(0, 128),
        accountScope: String(userInfo.account?.scope || '').trim().slice(0, 64),
        tokenExpiresAt: tokenExpiryIso(userInfo, accessToken),
        sourcePath: storagePath
      };
    } catch (_) {
      // A missing, locked, partially-written, or future-format storage file is
      // a soft miss. The collector can still use an explicitly saved token.
    }
  }
  return null;
}

module.exports = {
  TRAE_AUTH_FILE_MAX_BYTES,
  TRAE_AUTH_STORAGE_KEY,
  decryptTraeAuthStorageValue,
  readTraeLocalAccount,
  traeLocalAuthStoragePaths
};
