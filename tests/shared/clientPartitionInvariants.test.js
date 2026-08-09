'use strict';

// Targeted watch ticks (`--client <changed client> --today`) key the scan on a
// client id that is produced by two independent code paths: clientWatchCandidates()
// maps a changed file back to an id, and normalizeClientName() decides which id
// tokscale's rows land under. replaceTodayPartitions() clears the target's
// partition and fills it from whatever key the fresh rows normalize to, so the
// moment those two disagree a client's partition is zeroed on every watch tick
// and applyPeriodDelta() feeds the negative delta into month/allTime until the
// next full scan. These are cheap invariants; the failure they prevent is
// silently wrong token counts.

const assert = require('node:assert/strict');
const test = require('node:test');

const { DEFAULT_CLIENTS } = require('../../src/shared/clientTracking');
const {
  clientWatchCandidates,
  tokscaleClientFilter,
  TOKSCALE_CLIENT_ALIASES
} = require('../../src/shared/collector');
const { normalizeClientName } = require('../../src/shared/usage');

const trackedClients = DEFAULT_CLIENTS.split(',').map((value) => value.trim()).filter(Boolean);

test('every tracked client id is a fixed point of normalizeClientName', () => {
  for (const client of trackedClients) {
    assert.equal(
      normalizeClientName(client),
      client,
      `${client} normalizes to "${normalizeClientName(client)}", so a targeted scan would clear the "${client}" partition and write a different key`
    );
  }
});

test('every watch-mapped client id is a tracked client id', () => {
  // A watch root that maps to an id outside the tracked set produces a target
  // canTargetTodayPartitions() can never satisfy, silently degrading every
  // watch tick to a full scan (or worse, targeting a partition nothing fills).
  const watched = Object.keys(clientWatchCandidates(DEFAULT_CLIENTS));
  assert.ok(watched.length > 0, 'expected the default client list to produce watch candidates');
  for (const client of watched) {
    assert.ok(
      trackedClients.includes(client),
      `clientWatchCandidates() emitted "${client}", which is not in DEFAULT_CLIENTS`
    );
  }
});

test('every tokscale alias normalizes back to the client that owns it', () => {
  for (const [client, aliases] of Object.entries(TOKSCALE_CLIENT_ALIASES)) {
    assert.ok(trackedClients.includes(client), `alias owner "${client}" is not a tracked client`);
    for (const alias of aliases) {
      assert.equal(
        normalizeClientName(alias),
        client,
        `alias "${alias}" normalizes to "${normalizeClientName(alias)}" instead of "${client}", so its rows would land in a partition the targeted scan never clears`
      );
    }
  }
});

test('tokscaleClientFilter expands a targeted client to all of its aliases', () => {
  for (const [client, aliases] of Object.entries(TOKSCALE_CLIENT_ALIASES)) {
    const filter = tokscaleClientFilter(client).split(',');
    assert.ok(filter.includes(client), `targeting "${client}" dropped the client itself`);
    for (const alias of aliases) {
      assert.ok(
        filter.includes(alias),
        `targeting "${client}" alone would skip its "${alias}" data, under-counting the client on every watch tick`
      );
    }
  }
});

test('tokscaleClientFilter keeps Reasonix in the current Tokscale subprocess', () => {
  assert.equal(tokscaleClientFilter('reasonix'), 'reasonix');
  assert.equal(tokscaleClientFilter('reasonix,claude'), 'reasonix,claude');
});

test('tokscaleClientFilter never emits the synthetic pseudo-client', () => {
  // tokscale treats a client list containing `synthetic` as "enable every
  // client" (include_synthetic in scanner.rs), which re-enables all scan roots
  // and turns a targeted scan back into a full one with no visible symptom
  // beyond the CPU the targeting was supposed to save.
  const full = tokscaleClientFilter(DEFAULT_CLIENTS).split(',');
  assert.ok(!full.includes('synthetic'), 'the full client filter leaked the synthetic pseudo-client');
  for (const client of trackedClients) {
    assert.ok(
      !tokscaleClientFilter(client).split(',').includes('synthetic'),
      `targeting "${client}" leaked the synthetic pseudo-client into the tokscale filter`
    );
  }
});
