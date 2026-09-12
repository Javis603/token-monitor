'use strict';

const path = require('node:path');
const { CLIENT_IDS, LOCALLY_PARSED_CLIENT_IDS } = require('./clientCatalog');
const { tokscaleCustomScanClientIds } = require('./tokscaleClientMapping');

const MAX_CUSTOM_SCAN_PATHS = 64;
const MAX_CUSTOM_SCAN_PATHS_PER_CLIENT = 16;
const MAX_CUSTOM_SCAN_PATH_LENGTH = 4096;
const CUSTOM_SCAN_PATH_LIMIT_ERRORS = Object.freeze({
  GLOBAL: 'custom-scan-path-limit-global',
  PER_CLIENT: 'custom-scan-path-limit-per-client'
});
// Tokscale exposes extra roots for its recursive/file scanners. Locally parsed
// clients never enter Tokscale at all. OpenCode's generic extra-root scanner
// covers only its legacy JSON storage; modern SQLite databases require the
// separate scanner.opencodeDbPaths setting, which TOKSCALE_EXTRA_DIRS cannot
// express. Cursor's scanner accepts only Tokscale's generated usage cache, not
// native Cursor session data, so an arbitrary user-selected Cursor data root is
// similarly misleading. Keep both controls hidden rather than accepting paths
// that appear healthy but contribute no usage. Token Monitor's Kilo row combines
// the `kilo` CLI database and `kilocode` extension sources; the former rejects
// extra roots, so persisted Kilo roots are forwarded to the latter.
const UNSUPPORTED_CUSTOM_SCAN_CLIENTS = new Set([
  ...LOCALLY_PARSED_CLIENT_IDS,
  'opencode',
  'cursor'
]);
const CUSTOM_SCAN_CLIENT_IDS = Object.freeze(
  CLIENT_IDS.filter((id) => !UNSUPPORTED_CUSTOM_SCAN_CLIENTS.has(id))
);
const TOKSCALE_CLIENTS = new Set(CUSTOM_SCAN_CLIENT_IDS);

function isAbsolutePath(value, platform = process.platform) {
  if (platform === 'win32') {
    return path.win32.isAbsolute(value) && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value));
  }
  return path.posix.isAbsolute(value);
}

function validCustomScanPaths(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const platform = options.platform || process.platform;
  const allowedClients = options.allowedClients || TOKSCALE_CLIENTS;
  const result = {};
  for (const client of CLIENT_IDS) {
    const rawPaths = value[client];
    if (!allowedClients.has(client) || !Array.isArray(rawPaths)) continue;
    const paths = [];
    const seen = new Set();
    for (const rawPath of rawPaths) {
      const dir = typeof rawPath === 'string' ? rawPath.trim() : '';
      if (!dir || dir.length > MAX_CUSTOM_SCAN_PATH_LENGTH || !isAbsolutePath(dir, platform)) continue;
      // TOKSCALE_EXTRA_DIRS is comma-separated and has no escaping syntax.
      // Reject values the bundled CLI could split into a different source.
      if (dir.includes(',') || dir.includes('\0') || /[\r\n]/.test(dir)) continue;
      const key = platform === 'win32' ? dir.toLowerCase() : dir;
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(dir);
    }
    if (paths.length > 0) result[client] = paths;
  }
  return result;
}

function customScanPathLimitError(value, options = {}) {
  const pathsByClient = validCustomScanPaths(value, options);
  let total = 0;
  for (const paths of Object.values(pathsByClient)) {
    if (paths.length > MAX_CUSTOM_SCAN_PATHS_PER_CLIENT) {
      return CUSTOM_SCAN_PATH_LIMIT_ERRORS.PER_CLIENT;
    }
    total += paths.length;
  }
  return total > MAX_CUSTOM_SCAN_PATHS ? CUSTOM_SCAN_PATH_LIMIT_ERRORS.GLOBAL : '';
}

function normalizeCustomScanPaths(value, options = {}) {
  const pathsByClient = validCustomScanPaths(value, options);
  const result = {};
  let total = 0;
  // Catalog order makes the persisted object and usage fingerprint stable even
  // if the renderer or an imported settings file supplied keys in another order.
  for (const [client, rawPaths] of Object.entries(pathsByClient)) {
    const remaining = MAX_CUSTOM_SCAN_PATHS - total;
    if (remaining <= 0) break;
    const paths = rawPaths.slice(0, Math.min(MAX_CUSTOM_SCAN_PATHS_PER_CLIENT, remaining));
    if (paths.length > 0) result[client] = paths;
    total += paths.length;
  }
  return result;
}

function customScanPathEntries(value, options = {}) {
  const normalized = normalizeCustomScanPaths(value, options);
  return Object.entries(normalized).flatMap(([client, paths]) => (
    paths.map((dir) => ({ client, dir }))
  ));
}

function tokscaleExtraDirsEnv(value, inherited = '', options = {}) {
  const additions = customScanPathEntries(value, options).flatMap(({ client, dir }) => (
    tokscaleCustomScanClientIds(client).map((scanId) => `${scanId}:${dir}`)
  ));
  return [String(inherited || '').trim(), ...additions].filter(Boolean).join(',');
}

module.exports = {
  CUSTOM_SCAN_PATH_LIMIT_ERRORS,
  CUSTOM_SCAN_CLIENT_IDS,
  MAX_CUSTOM_SCAN_PATHS,
  MAX_CUSTOM_SCAN_PATHS_PER_CLIENT,
  customScanPathLimitError,
  customScanPathEntries,
  normalizeCustomScanPaths,
  tokscaleExtraDirsEnv
};
