'use strict';

// Verifies every id tokscaleClientFilter() actually sends for a DEFAULT_CLIENTS
// scan (other than clients Token Monitor parses itself) is a client the real,
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
const path = require('node:path');
const { resolveManifestEntry, resolveTargetBinPath, loadManifest, manifestMode } = require('./vendoredTokscale');
const { parseSupportedClients } = require('../src/shared/tokscaleCapabilities');
const { DEFAULT_CLIENTS, PARSE_LOCAL_CLIENTS } = require(path.join(__dirname, '..', 'src', 'shared', 'clientTracking'));
const { tokscaleClientFilter } = require(path.join(__dirname, '..', 'src', 'shared', 'collector'));

// Clients Token Monitor parses itself rather than through tokscale — see the
// "Adding a tracked client" table in AGENTS.md (parse_local clients). These
// are expected to be absent from tokscale's own --client list; everything
// else in DEFAULT_CLIENTS must be a client tokscale genuinely recognizes.
const LOCALLY_PARSED_CLIENTS = new Set(PARSE_LOCAL_CLIENTS);

function supportedClients(binPath, spawn = spawnSync) {
  const result = spawn(binPath, ['--help'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw new Error(`--help failed to execute: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`--help exited ${result.status}: ${result.stderr || result.stdout}`);
  return parseSupportedClients(`${result.stdout || ''}\n${result.stderr || ''}`);
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

  const tokscaleOnlyClients = DEFAULT_CLIENTS.split(',').filter((client) => !LOCALLY_PARSED_CLIENTS.has(client));
  const clients = tokscaleClientFilter(tokscaleOnlyClients.join(',')).split(',');
  const supported = supportedClients(binPath, spawn);
  const unsupported = clients.filter((client) => !supported.has(client));
  if (unsupported.length > 0) {
    throw new Error(
      `${isUpstream ? 'npm-installed' : 'Vendored'} tokscale (${key}) does not recognize these client ` +
        `ids: ${unsupported.join(', ')}. Either the ${isUpstream ? 'tokscale dependency' : 'vendor pin'} needs ` +
        'updating, or these clients need to be parsed locally (add to PARSE_LOCAL_CLIENTS) or removed from DEFAULT_CLIENTS / TOKSCALE_CLIENT_ALIASES.'
    );
  }

  log(`Verified ${isUpstream ? 'npm-installed' : 'vendored'} tokscale (${key}): all ${clients.length} effective client ids (default clients plus their tokscale aliases) are supported (tokscale-native or locally parsed).`);
  return { key, mode, clients: clients.length };
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
