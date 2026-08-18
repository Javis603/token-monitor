'use strict';

// Anchored to --client's own stanza, not just the first "[possible values:
// ...]" anywhere after it in the --help output: other clap-generated flags
// (e.g. a future enum option) can carry the same annotation. The scan is cut
// off at the next option line — either `--flag` alone or clap's common
// `-f, --flag` short+long form — so a later option's own list can never be
// misread as --client's; if --client itself doesn't carry a possible-values
// annotation, this fails loudly instead of borrowing one.
function parseSupportedClients(helpText) {
  const help = String(helpText || '');
  const clientFlagIndex = help.search(/--client\b/);
  if (clientFlagIndex === -1) {
    throw new Error('tokscale --help did not mention --client');
  }
  const afterClient = help.slice(clientFlagIndex);
  // clap commonly renders a later option as `-f, --format ...` rather than
  // `--format ...` alone, so the boundary must recognize a leading short
  // form too, not just a bare long flag.
  const nextFlagMatch = afterClient.slice(1).match(/\n\s*-{1,2}[\w-]+\b/);
  const clientSection = nextFlagMatch
    ? afterClient.slice(0, nextFlagMatch.index + 1)
    : afterClient;
  const possibleValues = clientSection.match(/\[\s*possible\s+values\s*:\s*([^\]]+)\]/is);
  if (!possibleValues) {
    throw new Error('tokscale --help did not list --client possible values');
  }
  return new Set(
    possibleValues[1]
      .split(/[\s,]+/)
      .map((client) => client.trim())
      .filter(Boolean)
  );
}

function filterSupportedClients(clients, supported) {
  const allowed = supported instanceof Set ? supported : new Set(supported || []);
  return String(clients ?? '')
    .split(',')
    .map((client) => client.trim())
    .filter((client) => client && allowed.has(client))
    .join(',');
}

// Reactive, not proactive: a probe only runs after tokscale itself has
// already rejected a client id (exit code 2 — "unknown --client value"). A
// binary that recognizes every requested client therefore pays zero extra
// spawns, ever. Once an identity's real capability set is known (or known to
// be unprobeable), it is cached and reused — so a given binary is probed and
// warned about at most once, not once per failure.
function createTokscaleCapabilityResolver({ warn = () => {} } = {}) {
  const settled = new Map();
  const pending = new Map();
  const warned = new Set();

  function known(identity) {
    return settled.get(String(identity || 'default'));
  }

  // In-flight probes are cached by identity too — two scans that fail
  // concurrently on the same never-before-seen binary must share one probe,
  // not each start their own.
  function probe(identity, probeFn) {
    const key = String(identity || 'default');
    if (settled.has(key)) return Promise.resolve(settled.get(key));
    if (pending.has(key)) return pending.get(key);
    const attempt = Promise.resolve()
      .then(() => probeFn())
      .then((supported) => {
        settled.set(key, supported);
        return supported;
      })
      .catch((error) => {
        settled.set(key, null);
        if (!warned.has(key)) {
          warned.add(key);
          warn(`[collector] tokscale capability probe failed for ${key}; the original tokscale error will surface instead: ${error.message}`);
        }
        return null;
      })
      .finally(() => { pending.delete(key); });
    pending.set(key, attempt);
    return attempt;
  }

  function reset() {
    settled.clear();
    pending.clear();
    warned.clear();
  }

  return { known, probe, reset };
}

module.exports = {
  createTokscaleCapabilityResolver,
  filterSupportedClients,
  parseSupportedClients
};
