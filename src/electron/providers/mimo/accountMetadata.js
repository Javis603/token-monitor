'use strict';

const fs = require('node:fs');
const { mimoDesktopCookieCandidates, readMimoDesktopAccount } = require('../../../shared/providers/mimo/desktop');
const { mimoAccountKey } = require('../../../shared/providers/mimo/limits');

// Settings keeps only the account fingerprint, never the Cookie or raw userId.
// Quota collection continues to use the uncached shared Desktop reader.
function createMimoAccountMetadataReader({
  cookieCandidates = mimoDesktopCookieCandidates,
  readAccount = readMimoDesktopAccount
} = {}) {
  let cached = null;
  return () => {
    try {
      const candidates = cookieCandidates();
      // SQLite account changes may live only in WAL.
      const stamp = candidates.flatMap((file) => [file, `${file}-wal`]).map((file) => {
        try {
          const stat = fs.statSync(file);
          return [file, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          return [file, null];
        }
      });
      const signature = JSON.stringify(stamp);
      if (cached?.signature === signature) return cached.accountKey;
      const { userId } = readAccount({ candidates });
      const accountKey = mimoAccountKey('', { userId });
      cached = { signature, accountKey };
      return accountKey;
    } catch (_) {
      // Observed inspection/read failures retry on the next projection.
      cached = null;
      return '';
    }
  };
}

module.exports = { createMimoAccountMetadataReader };
