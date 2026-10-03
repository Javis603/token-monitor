'use strict';

// Verifies every id tokscaleClientFilter() actually sends for a DEFAULT_CLIENTS
// scan is a client the real,
// currently-authoritative tokscale binary recognizes. This deliberately checks
// the same expanded set collectUsageOnce hands to runTokscale/runTokscaleGraph
// — including TOKSCALE_CLIENT_ALIASES sub-source ids like antigravity-cli —
// not just the logical DEFAULT_CLIENTS entries, since a binary can drop an
// alias while still recognizing its umbrella id and this gate would otherwise
// stay green while that alias silently starts failing in production. This is
// the production capability contract: a client can be merged upstream and
// pinned into the vendor build well before it's in a tagged npm release (dsh,
// cherrystudio), so checking the plain npm-installed binary would only prove
// something about an executable packaged releases don't ship — that's why
// this always resolves the binary through the same manifest-driven path
// ensure-vendored-tokscale.js uses, rather than skipping.
//
// mode "override" (the default): ensure-vendored-tokscale.js has already
// swapped in the pinned fork build at this path, so this verifies that.
// mode "upstream": no swap ever happens, so this verifies the plain
// npm-installed binary instead — deliberately NOT skipped, because switching
// to upstream is exactly the moment this contract most needs proving: if the
// newly-bumped tokscale dependency doesn't actually support everything
// DEFAULT_CLIENTS needs, this must fail loudly instead of the runtime
// capability fallback silently dropping a client. This runs in
// vendor-tokscale.yml, after ensure-vendored-tokscale.js.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveManifestEntry, resolveTargetBinPath, loadManifest, manifestMode } = require('./vendoredTokscale');
const { parseSupportedClients } = require('../src/shared/tokscaleCapabilities');
const { KNOWN_CLIENTS } = require(path.join(__dirname, '..', 'src', 'shared', 'clientTracking'));
const { FORK_ONLY_CLIENT_IDS } = require(path.join(__dirname, '..', 'src', 'shared', 'clientCatalog'));
const { tokscaleClientFilter } = require(path.join(__dirname, '..', 'src', 'shared', 'collector'));

// Clients parsed by Token Monitor's tokscale fork (`forkOnly` in the client
// catalog). The fork strips them from --client before clap parses argv, so
// they never appear in --help's possible values; they are verified by a real
// scan instead.
const FORK_ONLY_CLIENTS = new Set(FORK_ONLY_CLIENT_IDS);

function supportedClients(binPath, spawn = spawnSync) {
  const result = spawn(binPath, ['--help'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw new Error(`--help failed to execute: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`--help exited ${result.status}: ${result.stderr || result.stdout}`);
  return parseSupportedClients(`${result.stdout || ''}\n${result.stderr || ''}`);
}

// A binary without the fork's client module rejects these ids with clap's
// exit 2. The scan runs against an empty --home so it proves only that the
// ids are accepted, never what the CI machine happens to have on disk.
function forkOnlyClientsAccepted(binPath, clients, spawn = spawnSync) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-tokscale-fork-clients-'));
  try {
    const result = spawn(binPath, ['--json', '--client', clients.join(','), '--today', '--home', home], {
      encoding: 'utf8',
      timeout: 30_000
    });
    if (result.error) return `scan failed to execute: ${result.error.message}`;
    if (result.status !== 0) return `scan exited ${result.status}: ${result.stderr || result.stdout}`;
    return null;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function verifyVendoredTokscaleClients({
  manifest = loadManifest(),
  resolveEntry = resolveManifestEntry,
  resolveTarget = resolveTargetBinPath,
  spawn = spawnSync,
  log = console.log
} = {}) {
  const mode = manifestMode(manifest);
  const isUpstream = mode === 'upstream';
  const { key, entry } = resolveEntry(manifest);
  const binPath = resolveTarget(entry);

  // KNOWN_CLIENTS, not DEFAULT_CLIENTS: an opt-in client (qodercn) sends the
  // same --client value the moment a user enables it, and tokscale exits 2 on
  // an id it does not recognize, so a binary missing one breaks that client's
  // scans outright. Scoping this to the default-on list would leave every
  // opt-in client — and its alias sub-sources — unguarded.
  const tokscaleOnlyClients = KNOWN_CLIENTS.split(',').filter((client) => !FORK_ONLY_CLIENTS.has(client));
  const clients = tokscaleClientFilter(tokscaleOnlyClients.join(',')).split(',');
  const supported = supportedClients(binPath, spawn);
  const unsupported = clients.filter((client) => !supported.has(client));
  if (unsupported.length > 0) {
    throw new Error(
      `${isUpstream ? 'npm-installed' : 'Vendored'} tokscale (${key}) does not recognize these client ` +
        `ids: ${unsupported.join(', ')}. Either the ${isUpstream ? 'tokscale dependency' : 'vendor pin'} needs ` +
        'updating, or these clients need to be removed from KNOWN_CLIENTS / TOKSCALE_CLIENT_ALIASES.'
    );
  }
  const forkOnlyClients = [...FORK_ONLY_CLIENTS];
  const forkFailure = forkOnlyClients.length > 0
    ? forkOnlyClientsAccepted(binPath, forkOnlyClients, spawn)
    : null;
  if (forkFailure) {
    throw new Error(
      `${isUpstream ? 'npm-installed' : 'Vendored'} tokscale (${key}) does not accept the fork-only client ` +
        `ids ${forkOnlyClients.join(', ')} (${forkFailure.trim()}). They need a fork build that carries ` +
        'crates/tokscale-core/src/token_monitor/; upstream tokscale cannot serve them.'
    );
  }

  log(`Verified ${isUpstream ? 'npm-installed' : 'vendored'} tokscale (${key}): all ${clients.length} effective client ids (known clients plus their tokscale aliases) are supported, and the ${forkOnlyClients.length} fork-only client ids are accepted.`);
  return { key, mode, clients: clients.length, forkOnlyClients: forkOnlyClients.length };
}

if (require.main === module) {
  try {
    verifyVendoredTokscaleClients();
  } catch (error) {
    console.error(`verify-vendored-tokscale-clients failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  supportedClients,
  verifyVendoredTokscaleClients
};
