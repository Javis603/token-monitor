'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Token Monitor's tokscale fork parsed Proma before upstream did. It read only
// `<home>/.proma/agent-sessions/*.jsonl` and keyed each journal as
// `<file stem>@<root namespace>`, the namespace being the first 6 bytes of
// sha256 over the normalized root path. Upstream reads the same journals but
// keys their usage by SDK or native Pi session ids, which cannot be derived
// from the stem. A session archived under the fork id would therefore replay
// beside the same usage reported under its upstream id.
//
// While the journal still exists, a completed scan has just reported its usage
// under the upstream ids, so the fork row is redundant. Once the journal is
// gone, the fork row may be the only record and keeps replaying.
function legacyPromaSessionKeys(homes, options = {}) {
  const readdirSync = options.readdirSync || fs.readdirSync;
  const pathApi = options.platform === 'win32' ? path.win32 : path.posix;
  const keys = [];
  for (const home of new Set(homes.filter(Boolean))) {
    const root = pathApi.join(home, '.proma', 'agent-sessions');
    let names;
    try {
      names = readdirSync(root);
    } catch (_) {
      continue;
    }
    const namespace = crypto.createHash('sha256').update(pathApi.normalize(root)).digest('hex').slice(0, 12);
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      keys.push(`proma:${name.slice(0, -'.jsonl'.length)}@${namespace}`);
    }
  }
  return keys;
}

module.exports = { legacyPromaSessionKeys };
