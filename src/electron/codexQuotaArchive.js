'use strict';

const fs = require('node:fs');
const { writeJsonAtomic } = require('../shared/config');
const { readRegularFileNoFollow } = require('../shared/credentialStore');
const {
  ARCHIVE_VERSION,
  codexQuotaArchiveStructureError,
  emptyCodexQuotaArchive,
  normalizeCodexQuotaArchive,
  observeCodexQuota
} = require('../shared/codexQuota');

// Stable, desensitized load results. They are logged as codes only: never the
// archive path, file contents, account keys or credentials.
const LOAD_MISSING = 'archive-missing';
const LOAD_UNREADABLE = 'archive-unreadable';
const LOAD_CORRUPT = 'archive-corrupt';
const LOAD_VERSION_UNSUPPORTED = 'archive-version-unsupported';
const LOAD_OK = 'archive-loaded';
const PERSIST_FAILED = 'persist-failed';

function defaultReadFile(filePath) {
  return readRegularFileNoFollow(filePath, { description: 'Codex quota archive' });
}

function defaultWriteFile(filePath, value) {
  writeJsonAtomic(filePath, value);
}

// Existing path must already be a regular file, or must not exist yet.
// Symlinks, junctions, directories and other special files stay locked so a
// later persist cannot atomically replace an unconfirmed target. lstat then
// open/rename is not a single syscall: on Windows O_NOFOLLOW is often 0, so
// credentialStore compares lstat/fstat ino+dev, and a replacement between
// that check and rename remains a residual race.
function archivePathUnsafeToReplace(filePath, fsApi = fs) {
  try {
    const stat = fsApi.lstatSync(filePath);
    if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) return true;
    return typeof stat.isFile !== 'function' || !stat.isFile();
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    return true;
  }
}

// Distinguishes "no archive yet" (safe to create) from "an archive exists but
// cannot be trusted" (must never be overwritten in this process). A missing
// file may seed an empty archive; an unreadable, unparseable, empty or
// wrong-version file is locked so the next observation cannot silently
// replace the original evidence with a fresh document.
function loadCodexQuotaArchiveFile(filePath, deps = {}) {
  const readFile = deps.readFile || defaultReadFile;
  let text;
  try {
    text = readFile(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { archive: emptyCodexQuotaArchive(), locked: false, code: LOAD_MISSING };
    }
    return { archive: emptyCodexQuotaArchive(), locked: true, code: LOAD_UNREADABLE };
  }
  if (typeof text !== 'string' || !text.trim()) {
    return { archive: emptyCodexQuotaArchive(), locked: true, code: LOAD_CORRUPT };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { archive: emptyCodexQuotaArchive(), locked: true, code: LOAD_CORRUPT };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== ARCHIVE_VERSION) {
    return { archive: emptyCodexQuotaArchive(), locked: true, code: LOAD_VERSION_UNSUPPORTED };
  }
  // A JSON-valid file of the current version can still be structurally
  // broken (an array field replaced by a string, a map replaced by a scalar,
  // non-object rows). That damage must not reach the lenient normalize — it
  // would silently turn the broken fields into empty collections and the
  // next capture would overwrite the original evidence — so it fails closed
  // with the same stable corrupt code as unparseable JSON.
  if (codexQuotaArchiveStructureError(parsed)) {
    return { archive: emptyCodexQuotaArchive(), locked: true, code: LOAD_CORRUPT };
  }
  return { archive: normalizeCodexQuotaArchive(parsed), locked: false, code: LOAD_OK };
}

function createCodexQuotaArchiveStore(filePath, deps = {}) {
  const readFile = deps.readFile || defaultReadFile;
  const writeFile = deps.writeFile || defaultWriteFile;
  const log = deps.log || ((message) => console.log(message));
  let cached = null;
  let locked = false;
  let loadCode = '';

  function load() {
    if (cached) return cached;
    const result = loadCodexQuotaArchiveFile(filePath, { readFile });
    loadCode = result.code;
    if (result.locked) {
      // The damaged file keeps its original bytes for manual recovery; this
      // process only ever reads from the in-memory fallback.
      locked = true;
      log(`[codex-quota] archive locked: ${result.code}`);
    }
    cached = result.archive;
    return cached;
  }

  function capture(device, observedAt, snapshot) {
    if (!device) return null;
    const current = load();
    if (locked) return current;
    const next = observeCodexQuota(current, { device, observedAt, snapshot });
    if (next === current) return current;
    cached = next;
    if (archivePathUnsafeToReplace(filePath)) {
      locked = true;
      log(`[codex-quota] persist failed: ${PERSIST_FAILED}`);
      return next;
    }
    try {
      writeFile(filePath, next);
    } catch {
      log(`[codex-quota] persist failed: ${PERSIST_FAILED}`);
    }
    return next;
  }

  return {
    capture,
    load,
    isLocked: () => locked,
    lastLoadCode: () => loadCode
  };
}

module.exports = {
  LOAD_CODES: Object.freeze([LOAD_MISSING, LOAD_UNREADABLE, LOAD_CORRUPT, LOAD_VERSION_UNSUPPORTED, LOAD_OK]),
  LOAD_CORRUPT,
  LOAD_MISSING,
  LOAD_OK,
  LOAD_UNREADABLE,
  LOAD_VERSION_UNSUPPORTED,
  createCodexQuotaArchiveStore,
  loadCodexQuotaArchiveFile
};
