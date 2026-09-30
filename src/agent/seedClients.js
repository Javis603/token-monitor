'use strict';

const path = require('node:path');
const { readJson, sharedDataDir, writeJsonAtomic } = require('../shared/config');
const { seedSplitClients } = require('../shared/clientIdentitySplits');

// The headless equivalent of the widget's `seededClientSplits`. A resolved CSV
// written before a client identity split listed the merged id while the scan
// counted both products, so the split client has to be added once or its usage
// silently drops. `--clients` and TOKEN_MONITOR_CLIENTS carry no history of their
// own, so the record lives in the shared data directory; without it, an operator
// who removes the client afterwards would have it re-added on the next launch.
function seedAgentClients(resolved, options = {}) {
  const markerPath = path.join(sharedDataDir(options), 'seeded-client-splits.json');
  const stored = readJson(markerPath, null);
  // The CSV is a fresh declaration on every launch, so recording only that the
  // migration ran is not enough: the next launch would read the unchanged
  // pre-split CSV, see the split id as applied, and drop the client it added.
  // The seeded result is what has to persist, bound to the CSV it came from —
  // an unchanged declaration keeps the seeded list, while an edited CSV is a
  // new declaration and is seeded (or taken literally) on its own terms.
  if (stored && typeof stored === 'object'
      && stored.sourceCsv === resolved
      && typeof stored.clients === 'string' && stored.clients) {
    return stored.clients;
  }
  // A marker without a recorded result cannot prove the seed ever landed, so
  // its `applied` set is only trusted when the source CSV was recorded too.
  const applied = stored && typeof stored === 'object' && typeof stored.sourceCsv === 'string'
    && Array.isArray(stored.applied)
    ? stored.applied
    : [];
  const seeded = seedSplitClients(resolved, { applied });
  // A dry run still resolves the post-split client list so the preview shows
  // what a real launch would collect, but it must not record the migration:
  // persisting here would consume the one-shot seed on a run that collected
  // nothing, and the next real launch would silently drop the split client.
  if (options.persist !== false) {
    const next = [...new Set([
      ...applied.map((value) => String(value || '').trim()).filter(Boolean),
      ...seeded.evaluated
    ])];
    try {
      writeJsonAtomic(markerPath, { version: 1, applied: next, sourceCsv: resolved, clients: seeded.clients });
    } catch (error) {
      // A read-only data directory must not stop collection; the worst case is
      // that the next launch re-evaluates and re-adds the split client.
      console.warn('[agent] could not record the client-identity migration: ' + error.message);
    }
  }
  return seeded.clients;
}

module.exports = { seedAgentClients };
