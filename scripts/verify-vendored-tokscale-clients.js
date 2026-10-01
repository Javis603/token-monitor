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
const { KNOWN_CLIENTS, PARSE_LOCAL_CLIENTS } = require(path.join(__dirname, '..', 'src', 'shared', 'clientTracking'));
const { tokscaleClientFilter } = require(path.join(__dirname, '..', 'src', 'shared', 'collector'));

// Clients Token Monitor parses itself rather than through tokscale — see the
// "Adding a tracked client" table in docs/providers/README.md (parse_local clients). These
// are expected to be absent from tokscale's own --client list; everything
// else in DEFAULT_CLIENTS must be a client tokscale genuinely recognizes.
const LOCALLY_PARSED_CLIENTS = new Set(PARSE_LOCAL_CLIENTS);

function supportedClients(binPath, spawn = spawnSync) {
  const result = spawn(binPath, ['--help'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw new Error(`--help failed to execute: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`--help exited ${result.status}: ${result.stderr || result.stdout}`);
  return parseSupportedClients(`${result.stdout || ''}\n${result.stderr || ''}`);
}

// Clients Token Monitor intends to ship to tokycale but the vendored binary
// does not yet recognize. Probe the binary; if `--client <id>` is rejected,
// drop the id from this verification. The runtime capability fallback still
// surfaces the unsupported id to the user, so a missing probe here is loud
// at use time. The deferred list is intentionally mutable so PR-time clients
// (waiting on upstream tokycale parser support) can land without breaking
// the vendor gate.
const DEFERRED_CLIENTS = new Set(['mcode']);

function verifyVendoredTokscaleClients({
  manifest = loadManifest(),
  resolveEntry = resolveManifestEntry,
  resolveTarget = resolveTargetBinPath,
  spawn = spawnSync,
  log = console.log,
  warn = console.warn
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
  const tokscaleOnlyClients = KNOWN_CLIENTS.split(',').filter((client) => !LOCALLY_PARSED_CLIENTS.has(client));
  const clients = tokscaleClientFilter(tokscaleOnlyClients.join(',')).split(',');
  const supported = supportedClients(binPath, spawn);
  // A deferred client is one Token Monitor has shipped to DEFAULT_CLIENTS but
  // whose upstream tokycale parser hasn't landed yet (PR #513 mcode is the
  // current example). Deferral only applies when the binary doesn't recognize
  // the id — if tokycale has caught up and listed mcode in `--help`, the
  // id is treated as supported and the entry in DEFERRED_CLIENTS becomes a
  // signal to remove in the next sync.
  const deferred = clients.filter((client) => DEFERRED_CLIENTS.has(client) && !supported.has(client));
  const unsupported = clients.filter((client) => !supported.has(client) && !DEFERRED_CLIENTS.has(client));
  if (unsupported.length > 0) {
    throw new Error(
      `${isUpstream ? 'npm-installed' : 'Vendored'} tokscale (${key}) does not recognize these client ` +
        `ids: ${unsupported.join(', ')}. Either the ${isUpstream ? 'tokscale dependency' : 'vendor pin'} needs ` +
        'updating, or these clients need to be parsed locally (add to PARSE_LOCAL_CLIENTS) or removed from DEFAULT_CLIENTS / TOKSCALE_CLIENT_ALIASES.'
    );
  }
  if (deferred.length > 0) {
    warn(`Deferred ${deferred.length} client id(s) not yet supported by ${isUpstream ? 'npm-installed' : 'vendored'} tokscale (${key}): ${deferred.join(', ')}. The release gate will start checking them once the upstream parser lands; remove from DEFERRED_CLIENTS at that point.`);
  }

  log(`Verified ${isUpstream ? 'npm-installed' : 'vendored'} tokscale (${key}): all ${clients.length - deferred.length} effective client ids (known clients plus their tokscale aliases) are supported (tokscale-native or locally parsed)${deferred.length > 0 ? `; ${deferred.length} deferred` : ''}.`);
  const result = { key, mode, clients: clients.length - deferred.length };
  if (deferred.length > 0) result.deferred = deferred.length;
  return result;
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
