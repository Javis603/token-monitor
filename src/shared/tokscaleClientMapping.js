'use strict';

// Some Token Monitor rows combine multiple concrete Tokscale clients. Keep
// both subprocess filtering and custom-root expansion on this one mapping so a
// source cannot be counted by a normal scan but silently skipped by an extra
// directory scan.
const TOKSCALE_CLIENT_GROUPS = Object.freeze({
  antigravity: Object.freeze({
    aliases: Object.freeze(['antigravity-cli', 'antigravity-extension']),
    // CLI and extension parse the same *.db format. Hand each custom root to
    // one parser so generations without responseId cannot be counted twice.
    customScanIds: Object.freeze(['antigravity', 'antigravity-cli'])
  }),
  // Xiaomi MiMo Desktop and the MiMo Code CLI share one `mimocode` SQLite
  // store; tokscale re-stamps a row as `micode-desktop` when its
  // `session.version` starts with `desktop-`. Both surfaces are one Token
  // Monitor row.
  //
  // `mimo` is an umbrella id like `devin`, for a different reason: upstream's
  // client id is a fossil of a path typo. Tokscale originally scanned
  // `~/.local/share/micode/` and named the client after that directory;
  // upstream PR #784 fixed the path to `~/.local/share/mimocode/` but left the
  // id alone, and upstream still has no `mimo` id. So a bare `mimo` --client
  // value is rejected with exit 2 and the scan list is the aliases themselves.
  // Dropping either alias would silently stop counting that surface.
  mimo: Object.freeze({
    aliases: Object.freeze(['micode', 'micode-desktop']),
    scanIds: Object.freeze(['micode', 'micode-desktop'])
  }),
  // Oh My Pi wrote Pi's JSONL format and was folded into the `pi` row here
  // until the two products were split back apart in clientIdentitySplits.js, so
  // this table no longer groups them. Their default roots stay distinct, and
  // each id now takes its own custom roots; neither is a sub-source of the
  // other any more.
  // Kilo CLI loads one fixed SQLite database and Tokscale rejects extra roots
  // for it. The combined row can still accept custom Kilo Code task roots.
  kilo: Object.freeze({
    aliases: Object.freeze(['kilocode']),
    customScanIds: Object.freeze(['kilocode'])
  }),
  // `devin` is an umbrella id only: tokscale splits the product into the CLI
  // database scanner (devin-cli) and the Desktop ACP-event scanner
  // (devin-desktop), and rejects a bare `devin` --client value. The scan list
  // is therefore the aliases themselves, not `devin` plus the aliases.
  devin: Object.freeze({
    aliases: Object.freeze(['devin-cli', 'devin-desktop']),
    scanIds: Object.freeze(['devin-cli', 'devin-desktop'])
  })
});

const TOKSCALE_CLIENT_ALIASES = Object.freeze(Object.fromEntries(
  Object.entries(TOKSCALE_CLIENT_GROUPS).map(([client, group]) => [client, group.aliases])
));

function tokscaleScanClientIds(client) {
  return TOKSCALE_CLIENT_GROUPS[client]?.scanIds || [client, ...(TOKSCALE_CLIENT_GROUPS[client]?.aliases || [])];
}

function tokscaleCustomScanClientIds(client) {
  return TOKSCALE_CLIENT_GROUPS[client]?.customScanIds || tokscaleScanClientIds(client);
}

module.exports = {
  TOKSCALE_CLIENT_ALIASES,
  TOKSCALE_CLIENT_GROUPS,
  tokscaleCustomScanClientIds,
  tokscaleScanClientIds
};
