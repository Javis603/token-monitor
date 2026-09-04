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
    'claude,codex,opencode,hermes,openclaw,cursor,antigravity,cline,kimi,qwen,grok,copilot,pi,zed,kilocode,commandcode,micode,zcode,kiro,codebuddy,workbuddy,proma,qodercn,reasonix,dsh,cherrystudio,lmstudio,unsloth'
  );
});

test('derived DEFAULT_CLIENTS keeps the existing default-tracked CSV', () => {
  assert.equal(DEFAULT_CLIENTS, DEFAULT_CLIENT_IDS.join(','));
  assert.equal(
    DEFAULT_CLIENTS,
    'claude,codex,opencode,hermes,openclaw,cursor,antigravity,cline,kimi,qwen,grok,copilot,pi,zed,kilocode,commandcode,zcode,kiro,codebuddy,workbuddy,proma,reasonix,dsh,cherrystudio,lmstudio,unsloth'
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
