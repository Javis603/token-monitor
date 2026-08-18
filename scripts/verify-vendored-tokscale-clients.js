'use strict';

// Verifies every DEFAULT_CLIENTS entry (other than clients Token Monitor
// parses itself) is a client the real vendored tokscale binary actually
// recognizes. This is the production capability contract: a client can be
// merged upstream and pinned into the vendor build well before it's in a
// tagged npm release (dsh, cherrystudio), so checking the plain
// npm-installed binary would only prove something about an executable
// packaged releases don't ship. This runs in vendor-tokscale.yml, after
// install-vendored-tokscale.js has already swapped in the real binary.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { resolveManifestEntry, resolveTargetBinPath, loadManifest } = require('./vendoredTokscale');
const { DEFAULT_CLIENTS, PARSE_LOCAL_CLIENTS } = require(path.join(__dirname, '..', 'src', 'shared', 'clientTracking'));

// Clients Token Monitor parses itself rather than through tokscale — see the
// "Adding a tracked client" table in AGENTS.md (parse_local clients). These
// are expected to be absent from tokscale's own --client list; everything
// else in DEFAULT_CLIENTS must be a client tokscale genuinely recognizes.
const LOCALLY_PARSED_CLIENTS = new Set(PARSE_LOCAL_CLIENTS);

function supportedClients(binPath) {
  const result = spawnSync(binPath, ['--help'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw new Error(`--help failed to execute: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`--help exited ${result.status}: ${result.stderr || result.stdout}`);
  const help = `${result.stdout || ''}\n${result.stderr || ''}`;
  const possibleValues = help.match(/\[possible values: ([^\]]+)\]/);
  if (!possibleValues) throw new Error('tokscale --help did not list --client possible values');
  return new Set(possibleValues[1].split(',').map((client) => client.trim()).filter(Boolean));
}

function main() {
  const manifest = loadManifest();
  const { key, entry } = resolveManifestEntry(manifest);
  const binPath = resolveTargetBinPath(entry);

  const clients = DEFAULT_CLIENTS.split(',');
  const supported = supportedClients(binPath);
  const unsupported = clients.filter(
    (client) => !supported.has(client) && !LOCALLY_PARSED_CLIENTS.has(client)
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Vendored tokscale (${key}) does not recognize these DEFAULT_CLIENTS entries: ${unsupported.join(', ')}. ` +
        'Either the vendor pin needs updating, or these clients need to be parsed locally (add to PARSE_LOCAL_CLIENTS) ' +
        'or removed from DEFAULT_CLIENTS.'
    );
  }

  console.log(`Verified vendored tokscale (${key}): all ${clients.length} default clients are supported (tokscale-native or locally parsed).`);
}

try {
  main();
} catch (error) {
  console.error(`verify-vendored-tokscale-clients failed: ${error.message}`);
  process.exit(1);
}
