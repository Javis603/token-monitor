'use strict';

// Invariants over the tracked-client catalog and the lists derived from it.
//
// Two kinds of check live here. The structural ones (unique ids, non-empty
// labels, complete label coverage) protect the catalog shape itself. The three
// pinned literals are a migration safety net: DEFAULT_CLIENTS and KNOWN_CLIENTS
// are persisted in user settings and accepted from TOKEN_MONITOR_CLIENTS, so a
// derivation that silently reorders or drops an id would change the tracked
// tools of every existing install. Adding a client is expected to update those
// literals deliberately.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CLIENT_CATALOG,
  NON_CATALOG_CLIENT_LABELS,
  CLIENT_IDS,
  DEFAULT_CLIENT_IDS,
  LOCALLY_PARSED_CLIENT_IDS,
  CLIENT_LABELS,
  KNOWN_CLIENT_LIST
} = require('../../src/shared/clientCatalog');
const { DEFAULT_CLIENTS, KNOWN_CLIENTS, PARSE_LOCAL_CLIENTS } = require('../../src/shared/clientTracking');
const { CLIENT_IDENTITY_SPLITS, seedSplitClients } = require('../../src/shared/clientIdentitySplits');

const rootDir = path.join(__dirname, '..', '..');

test('catalog ids are unique and labels are non-empty', () => {
  assert.equal(new Set(CLIENT_IDS).size, CLIENT_IDS.length, 'duplicate client id in the catalog');
  for (const client of CLIENT_CATALOG) {
    assert.match(client.id, /^[a-z0-9-]+$/, `${client.id} is not a plain client id`);
    assert.equal(typeof client.label, 'string');
    assert.ok(client.label.trim().length > 0, `${client.id} has an empty label`);
  }
});

test('resolved catalog entries expose boolean tracking flags', () => {
  // Entries omit the flags they do not override, so the catalog fills both in.
  // What this guards is the override: a truthy-but-not-boolean value such as
  // defaultTracked: 'false' would flip a derived list without failing anywhere.
  for (const client of CLIENT_CATALOG) {
    assert.equal(typeof client.defaultTracked, 'boolean', `${client.id} defaultTracked`);
    assert.equal(typeof client.locallyParsed, 'boolean', `${client.id} locallyParsed`);
  }
});

test('derived KNOWN_CLIENTS keeps the established id order', () => {
  assert.equal(KNOWN_CLIENTS, CLIENT_IDS.join(','));
  assert.equal(
    KNOWN_CLIENTS,
    'claude,codex,opencode,hermes,openclaw,cursor,antigravity,cline,amp,droid,kimi,qwen,grok,copilot,pi,omp,zed,kilo,commandcode,micode,zcode,kiro,codebuddy,workbuddy,proma,qodercn,reasonix,dsh,cherrystudio,lmstudio,unsloth'
  );
});

test('derived DEFAULT_CLIENTS keeps the existing default-tracked CSV', () => {
  assert.equal(DEFAULT_CLIENTS, DEFAULT_CLIENT_IDS.join(','));
  assert.equal(
    DEFAULT_CLIENTS,
    'claude,codex,opencode,hermes,openclaw,cursor,antigravity,cline,amp,droid,kimi,qwen,grok,copilot,pi,omp,zed,kilo,commandcode,zcode,kiro,codebuddy,workbuddy,proma,reasonix,dsh,cherrystudio,lmstudio,unsloth'
  );
});

test('derived PARSE_LOCAL_CLIENTS still lists exactly the local adapters', () => {
  assert.deepEqual([...PARSE_LOCAL_CLIENTS], ['proma', 'qodercn']);
  assert.deepEqual([...LOCALLY_PARSED_CLIENT_IDS], ['proma', 'qodercn']);
});

test('default-tracked clients are a subset of the catalog, in catalog order', () => {
  const known = CLIENT_IDS;
  for (const client of DEFAULT_CLIENT_IDS) {
    assert.ok(known.includes(client), `${client} is default-tracked but not in the catalog`);
  }
  assert.deepEqual(DEFAULT_CLIENT_IDS, known.filter((id) => DEFAULT_CLIENT_IDS.includes(id)));
});

test('CLIENT_LABELS covers every catalog id plus the non-catalog ids', () => {
  for (const client of CLIENT_CATALOG) {
    assert.equal(CLIENT_LABELS[client.id], client.label);
  }
  for (const [id, label] of Object.entries(NON_CATALOG_CLIENT_LABELS)) {
    assert.equal(CLIENT_LABELS[id], label);
    assert.ok(!CLIENT_IDS.includes(id), `${id} is a non-catalog label but also a catalog client`);
  }
  assert.equal(
    Object.keys(CLIENT_LABELS).length,
    CLIENT_IDS.length + Object.keys(NON_CATALOG_CLIENT_LABELS).length
  );
});

test('KNOWN_CLIENT_LIST is the catalog projection the renderer consumes', () => {
  assert.deepEqual(KNOWN_CLIENT_LIST, CLIENT_CATALOG.map(({ id, label }) => ({ id, label })));
});

test('the widget renderer loads the catalog before app.js', () => {
  // app.js destructures window.TokenMonitorClientCatalog at its top level, so a
  // missing or late script tag is a blank-window failure at load time.
  const html = fs.readFileSync(path.join(rootDir, 'src/electron/renderer/index.html'), 'utf8');
  const catalogTag = html.indexOf('shared/clientCatalog.js');
  const appTag = html.indexOf('src="app.js"');
  assert.ok(catalogTag > -1, 'index.html must load shared/clientCatalog.js');
  assert.ok(appTag > -1, 'index.html must load app.js');
  assert.ok(catalogTag < appTag, 'clientCatalog.js must load before app.js');
});

// A client identity split (clientIdentitySplits.js) reverses a merge, so the
// split client is not a new tool for anyone who tracked its parent: those users
// were already counting it under the merged id. Seeding is therefore what keeps
// the split from silently dropping usage.
test('seedSplitClients adds the split client to a user who tracked its parent', () => {
  const seeded = seedSplitClients('claude,codex,pi');
  assert.equal(seeded.clients, 'claude,codex,pi,omp');
  assert.deepEqual(seeded.seeded, ['omp']);
  assert.deepEqual(seeded.evaluated, ['omp']);
});

test('seedSplitClients adds nothing for a user who never tracked the parent', () => {
  assert.deepEqual(seedSplitClients('claude,codex'), { clients: 'claude,codex', evaluated: ['omp'], seeded: [] });
});

test('seedSplitClients is a one-time addition, not an enforced re-add', () => {
  // A user who untracks the split client after the seed must keep it untracked.
  assert.deepEqual(
    seedSplitClients('claude,pi', { applied: 'omp' }),
    { clients: 'claude,pi', evaluated: [], seeded: [] }
  );
});

test('seedSplitClients leaves an already-tracked split client alone', () => {
  assert.deepEqual(seedSplitClients('pi,omp'), { clients: 'pi,omp', evaluated: ['omp'], seeded: [] });
});

// A fresh install takes every default-tracked client from DEFAULT_CLIENTS, so the
// split has to be default-tracked for new users to get it at all.
test('the split client is default-tracked so fresh installs collect it', () => {
  for (const { split } of CLIENT_IDENTITY_SPLITS) {
    assert.ok(DEFAULT_CLIENT_IDS.includes(split), `${split} should be tracked on a fresh install`);
  }
});

// The migration has to be decided by the launch that first runs it, not by
// whatever the user happens to track later. Recording the marker only when the
// split client is actually inserted leaves an install that tracks the parent
// afterwards still un-migrated, so the seed fires on a deliberate post-split
// choice: the user picks Pi alone, and the next launch silently adds Oh My Pi
// back. `evaluated` is what lets the caller record "this install has been
// through the migration" independently of whether it gained a client.
test('seedSplitClients reports the split as evaluated even when nothing is added', () => {
  const untouched = seedSplitClients('claude,codex');
  assert.deepEqual(untouched.seeded, [], 'no parent is tracked, so nothing is inserted');
  assert.deepEqual(
    untouched.evaluated,
    ['omp'],
    'the migration still ran for this install and must be recorded as such'
  );
});

test('a recorded evaluation keeps a later deliberate Pi-only choice intact', () => {
  // Upgrade: Oh My Pi is not tracked, but the migration is recorded anyway.
  const upgrade = seedSplitClients('claude,codex');
  const marked = upgrade.evaluated.join(',');
  // Later the user enables Pi alone, inside the already-split UI.
  const later = seedSplitClients('claude,codex,pi', { applied: marked });
  assert.deepEqual(
    later.seeded,
    [],
    'a deliberate post-split choice must not be overridden by the upgrade migration'
  );
  assert.equal(later.clients, 'claude,codex,pi');
});

// The headless deployment has no settings.json, so its migration record has to
// live somewhere else. What matters is the same property the widget has: the
// evaluation is recorded on the launch that runs it, so an operator who removes
// the split client afterwards does not have it reappear on the next start.
// Exercised through the shared helpers the agent uses, because the agent itself
// reads its input at module load.
test('a headless client list is migrated once and then left alone', () => {
  // Launch 1: the operator's CSV names the parent, as a pre-split one would.
  const first = seedSplitClients('claude,pi');
  assert.equal(first.clients, 'claude,pi,omp');
  assert.deepEqual(first.evaluated, ['omp']);

  // That evaluation is what the agent persists; the next launch replays it.
  const recorded = first.evaluated.join(',');
  const second = seedSplitClients('claude,pi', { applied: recorded });
  assert.deepEqual(second.seeded, [], 'the split client must not be re-added');
  assert.equal(second.clients, 'claude,pi');
});

// A host that never named the parent is still evaluated, so its record is a
// decision rather than an absence — the same distinction the widget relies on.
test('a headless client list is evaluated even without the parent', () => {
  const evaluated = seedSplitClients('claude,codex');
  assert.deepEqual(evaluated.evaluated, ['omp']);
  assert.deepEqual(evaluated.seeded, []);
});
