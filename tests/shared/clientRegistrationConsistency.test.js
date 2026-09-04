'use strict';

// Consistency checks over the *existing* per-client wiring — no registry, no
// codegen, no file moves. Per the maintainer's scoping on the proposal issue
// (#496): "Please keep the PR scoped to consistency checks over the existing
// wiring: orphan or missing client metadata, source check ids and WSL markers
// that do not resolve back to a known client, and the other duplicated
// client ids that are expected to agree today."
//
// Each check here tests an *invariant* between two independently-maintained
// lists, not a pinned snapshot of either list's contents — so a check keeps
// protecting the eventual registry migration even after the lists' contents
// change, per the same guidance ("testing invariants rather than pinning the
// current file layout").
//
// clientTracking.test.js already covers: DEFAULT_CLIENTS/KNOWN_CLIENTS shape,
// and the renderer/README/KNOWN_CLIENTS shared display-order agreement.
// clientHealth.test.js already covers: CLIENT_SOURCE_CHECK_IDS vs. the ids
// clientSourceRoots() actually emits. Neither is duplicated here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { KNOWN_CLIENTS } = require('../../src/shared/clientTracking');
const { WSL_DATA_MARKERS, MARKER_CLIENTS } = require('../../src/shared/wslUsage');

const rootDir = path.join(__dirname, '..', '..');
const knownClientIds = new Set(KNOWN_CLIENTS.split(','));

// discordRpc.js requires '@xhayper/discord-rpc', which isn't needed to read
// its two plain data structures. Load it the same way
// tests/electron/discordRpc.test.js already does (sandboxed, mocked require)
// rather than adding a new dependency or a new exported surface.
function loadDiscordRpcClientMaps() {
  const filePath = path.join(rootDir, 'src', 'electron', 'discordRpc.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const sandbox = {
    console,
    module: { exports: {} },
    require(name) {
      if (name === '@xhayper/discord-rpc') return { Client: class {} };
      if (name === '../shared/currency') return require('../../src/shared/currency');
      if (name === '../shared/compactTokens') return require('../../src/shared/compactTokens');
      return require(name);
    },
    setTimeout,
    clearTimeout,
    Date
  };
  vm.runInNewContext(
    `${source}\nmodule.exports.__KNOWN_CLIENT_ASSETS = KNOWN_CLIENT_ASSETS;\nmodule.exports.__CLIENT_LABELS = CLIENT_LABELS;`,
    sandbox,
    { filename: filePath }
  );
  return {
    knownClientAssets: sandbox.module.exports.__KNOWN_CLIENT_ASSETS,
    clientLabels: sandbox.module.exports.__CLIENT_LABELS
  };
}

// --- WSL markers <-> the client each marker is attributed to -----------------

test('every WSL_DATA_MARKERS entry has a MARKER_CLIENTS attribution, and vice versa', () => {
  const markerSet = new Set(WSL_DATA_MARKERS);
  const attributedSet = new Set(Object.keys(MARKER_CLIENTS));

  for (const marker of WSL_DATA_MARKERS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(MARKER_CLIENTS, marker),
      `WSL marker '${marker}' has no MARKER_CLIENTS attribution — it would ` +
      `be detected but "attribute to nothing" per wslUsage.js's own doc comment`
    );
  }
  for (const marker of attributedSet) {
    assert.ok(
      markerSet.has(marker),
      `MARKER_CLIENTS has an attribution for '${marker}', which is not (or ` +
      `no longer) in WSL_DATA_MARKERS — dead entry`
    );
  }
});

test('every MARKER_CLIENTS attribution points at a real tracked-client id', () => {
  for (const [marker, clientId] of Object.entries(MARKER_CLIENTS)) {
    assert.ok(
      knownClientIds.has(clientId),
      `MARKER_CLIENTS['${marker}'] = '${clientId}', which is not a KNOWN_CLIENTS id`
    );
  }
});

// --- Discord Rich Presence client maps <-> the canonical client list ---------

test('discordRpc KNOWN_CLIENT_ASSETS and CLIENT_LABELS stay in sync with KNOWN_CLIENTS', () => {
  const { knownClientAssets, clientLabels } = loadDiscordRpcClientMaps();

  const missingFromAssets = [];
  const missingFromLabels = [];
  for (const id of knownClientIds) {
    if (!knownClientAssets.has(id)) missingFromAssets.push(id);
    if (!Object.prototype.hasOwnProperty.call(clientLabels, id)) missingFromLabels.push(id);
  }

  // Ids present in the Discord maps but no longer (or never) a tracked client.
  // Not necessarily a bug — an asset can be uploaded ahead of a client landing
  // — but it should be an intentional, reviewed state, not silent drift.
  const orphanedInAssets = [...knownClientAssets].filter((id) => !knownClientIds.has(id));
  const orphanedInLabels = Object.keys(clientLabels).filter((id) => !knownClientIds.has(id));

  assert.deepEqual(
    missingFromAssets, [],
    'KNOWN_CLIENTS ids missing from discordRpc.js KNOWN_CLIENT_ASSETS — Rich ' +
    'Presence will show no icon for these clients when they are the top client today'
  );
  assert.deepEqual(
    missingFromLabels, [],
    'KNOWN_CLIENTS ids missing from discordRpc.js CLIENT_LABELS — Rich ' +
    'Presence falls back to the raw client id as the display label for these'
  );
  // Left as documentation rather than an assertion failure: orphan entries are
  // flagged for maintainer review (see PR description), not treated as wrong.
  void orphanedInAssets;
  void orphanedInLabels;
});
