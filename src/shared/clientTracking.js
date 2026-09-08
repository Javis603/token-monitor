'use strict';

// Tracked-client CSV helpers. The client list itself lives in clientCatalog.js;
// this module only projects it into the CSV shape that settings, the
// TOKEN_MONITOR_CLIENTS env var and the collector already speak. Those CSV
// values are a compatibility surface — they are persisted in user settings, so
// the derivations below must keep producing the same ids in the same order.
const {
  CLIENT_IDS,
  DEFAULT_CLIENT_IDS,
  LOCALLY_PARSED_CLIENT_IDS
} = require('./clientCatalog');

// Clients read by a local adapter instead of tokscale (collector.js excludes
// these from the tokscale client filter).
const PARSE_LOCAL_CLIENTS = LOCALLY_PARSED_CLIENT_IDS;

// Tracked on a fresh install.
const DEFAULT_CLIENTS = DEFAULT_CLIENT_IDS.join(',');

// Every wired client id, including the opt-in ones kept out of DEFAULT_CLIENTS.
// Display-preference normalization (hide/pin/reorder) keys off this list, so an
// opt-in client's prefs survive a round-trip instead of being silently dropped.
const KNOWN_CLIENTS = CLIENT_IDS.join(',');

const LEGACY_CLIENT_ID_ALIASES = Object.freeze({
  kilocode: 'kilo'
});

function normalizeTrackedClientId(value) {
  const id = String(value || '').trim().toLowerCase();
  return LEGACY_CLIENT_ID_ALIASES[id] || id;
}

function normalizeClientsCsv(value) {
  const seen = new Set();
  const clients = [];
  for (const part of String(value ?? '').split(',')) {
    const client = normalizeTrackedClientId(part);
    if (!client || seen.has(client)) continue;
    seen.add(client);
    clients.push(client);
  }
  return clients.join(',');
}

function clientsCsvForSetting(value, fallback = DEFAULT_CLIENTS) {
  if (value === undefined || value === null) return normalizeClientsCsv(fallback);
  return normalizeClientsCsv(value);
}

module.exports = {
  DEFAULT_CLIENTS,
  PARSE_LOCAL_CLIENTS,
  KNOWN_CLIENTS,
  clientsCsvForSetting,
  normalizeClientsCsv,
  normalizeTrackedClientId
};
