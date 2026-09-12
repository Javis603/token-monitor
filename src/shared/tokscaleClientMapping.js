'use strict';

// Some Token Monitor rows combine multiple concrete Tokscale clients. Keep
// both subprocess filtering and custom-root expansion on this one mapping so a
// source cannot be counted by a normal scan but silently skipped by an extra
// directory scan.
const TOKSCALE_CLIENT_GROUPS = Object.freeze({
  antigravity: Object.freeze({ aliases: Object.freeze(['antigravity-cli']) }),
  // OMP delegates to Pi's parser because both products write the same JSONL
  // format. Keep both ids in normal scans so their distinct default roots are
  // discovered, but assign an explicit custom root to Pi only; forwarding the
  // same root to both ids would parse every matching file twice.
  pi: Object.freeze({
    aliases: Object.freeze(['omp']),
    customScanIds: Object.freeze(['pi'])
  }),
  // Kilo CLI loads one fixed SQLite database and Tokscale rejects extra roots
  // for it. The combined row can still accept custom Kilo Code task roots.
  kilo: Object.freeze({
    aliases: Object.freeze(['kilocode']),
    customScanIds: Object.freeze(['kilocode'])
  })
});

const TOKSCALE_CLIENT_ALIASES = Object.freeze(Object.fromEntries(
  Object.entries(TOKSCALE_CLIENT_GROUPS).map(([client, group]) => [client, group.aliases])
));

function tokscaleScanClientIds(client) {
  return [client, ...(TOKSCALE_CLIENT_GROUPS[client]?.aliases || [])];
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
