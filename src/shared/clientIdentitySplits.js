'use strict';

// Client identity splits: a Tokscale client id that Token Monitor used to
// record under a different client id, and that is now tracked on its own.
//
// Oh My Pi splits from Pi. Tokscale has always parsed .omp/agent/sessions as
// its own omp client (4.13.0 onwards), but Token Monitor folded omp into pi
// from 2026-08-25 so both products shared one row. Splitting them back apart
// changes the *identity* of already-stored usage, which is not a rename: the
// durable archives hold pi rows whose numbers include Oh My Pi, and a fresh
// scan of the same day now answers with two rows. Replaying that answer on top
// of the merged row would count Oh My Pi twice, so both archives need to know
// which ids used to be one.
//
// This table is what keeps that knowledge in one place: the daily archive folds
// the pair back together for days that were captured while they were merged,
// and the session archive treats an archived merged-id session as already
// covered when the split id reports the same session live.
const CLIENT_IDENTITY_SPLITS = Object.freeze([
  Object.freeze({
    merged: 'pi',
    split: 'omp',
  })
]);

const SPLIT_TO_MERGED = new Map(CLIENT_IDENTITY_SPLITS.map(({ merged, split }) => [split, merged]));
const MERGED_TO_SPLIT = new Map(CLIENT_IDENTITY_SPLITS.map(({ merged, split }) => [merged, split]));

// The client-identity generation an archive entry was written under.
//
// An entry with no generation predates the split, so its merged-id usage may also
// contain the split client. An entry carrying this value was written after the
// split and is taken at face value. This is provenance the entry has to carry
// itself: inferring it from the archive's current contents fails in both
// directions, because a merged-era day and a post-split day that happens to have
// only the merged client look identical ("pi, no omp" is a legal post-split
// state), and a post-split day that legitimately records Pi first and Oh My Pi
// later would otherwise be folded forever.
const CLIENT_IDENTITY_GENERATION = 2;

function isPreSplitEntry(entry) {
  const generation = Number(entry?.clientIdentityGeneration);
  return !Number.isFinite(generation) || generation < CLIENT_IDENTITY_GENERATION;
}

// The id a split client rows were recorded under before the split, or null
// when the id was never merged.
function mergedClientIdFor(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw ? SPLIT_TO_MERGED.get(raw) || null : null;
}

// The id a merged client rows are recorded under now, or null when the client
// never split.
function splitClientIdFor(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw ? MERGED_TO_SPLIT.get(raw) || null : null;
}

// Add a split client to the tracked CSV when its merged parent is already
// tracked and the split has not been seeded before.
//
// This is not the usual "new client arrives, users opt in" path. A user who
// tracked Pi was already collecting Oh My Pi, because the two ids resolved to
// one row; leaving the split id out does not spare them a new tool, it silently
// drops usage that was counted yesterday. The mirror case is right for free: a
// user who never tracked the parent never tracked the child either.
//
// `applied` is the persisted set of split ids already seeded, so the addition
// happens once: a user who deliberately untracks the split client afterwards
// must not have it silently re-added on the next launch.
//
// A client the user does not track today is still *evaluated* here, and the
// caller is expected to record that evaluation even though nothing was added.
// Otherwise the decision is deferred to whatever the user happens to track at
// the next launch, and the migration would fire on a deliberate post-split
// choice instead of on the upgrade it belongs to. `evaluated` is that set.
function seedSplitClients(clientsCsv, options = {}) {
  const appliedSource = Array.isArray(options.applied)
    ? options.applied
    : String(options.applied || '').split(',');
  const applied = new Set(appliedSource
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean));
  const tracked = String(clientsCsv || '').split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const present = new Set(tracked);
  const seeded = [];
  const clients = [];
  for (const client of tracked) {
    clients.push(client);
    for (const { merged, split } of CLIENT_IDENTITY_SPLITS) {
      if (client !== merged || applied.has(split)) continue;
      if (present.has(split)) continue;
      // Directly after its parent, so the CSV reads in the order the split
      // actually happened instead of growing an unrelated tail.
      clients.push(split);
      seeded.push(split);
    }
  }
  // Every split is decided by this pass, whether or not its parent is tracked.
  // An install that happens not to track the parent still has to record that
  // the migration ran, or the decision waits for whatever the user tracks at
  // some later launch and fires on a deliberate post-split choice instead.
  const evaluated = CLIENT_IDENTITY_SPLITS
    .map(({ split }) => split)
    .filter((split) => !applied.has(split));
  return { clients: clients.join(','), evaluated, seeded };
}

module.exports = {
  CLIENT_IDENTITY_GENERATION,
  CLIENT_IDENTITY_SPLITS,
  isPreSplitEntry,
  mergedClientIdFor,
  seedSplitClients,
  splitClientIdFor
};
