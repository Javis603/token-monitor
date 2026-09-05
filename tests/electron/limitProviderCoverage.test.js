'use strict';

// Catalog → settings completeness.
//
// A limits provider is only usable once the settings page gives it somewhere to
// go: an account group, whose state is reported by a status pill, or — for the
// providers detected without a credential — a connection explainer. Both live in
// hand-maintained maps in app.js keyed by provider id. Nothing asserted that a
// catalog entry reached either, so a provider added without its settings wiring
// shipped as a row that expands into nothing.
//
// The direction matters, as in clientPresentationCoverage.test.js: the account
// group check in limitProviderPresentation.test.js starts from a written-out
// list of providers, so it cannot see one that never reached the maps at all.
//
// This proves coverage, not correctness. It says every provider resolves to some
// configurable or explained path; it cannot say the path it resolves to suits
// how that provider actually authenticates.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limitProviders');
const { MESSAGES } = require('../../src/electron/renderer/i18n');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const read = (file) => fs.readFileSync(path.join(rendererDir, file), 'utf8');

// Read from source because these maps are still declared inside app.js, which
// only loads in a browser. When the renderer boundary is split they can be
// required instead, without any invariant here changing.
function providerMap(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `${name} should be declared in app.js`);
  const end = source.indexOf('\n};', start);
  assert.notEqual(end, -1, `${name} should be a closed object literal`);
  // Strip comments first: a commented-out entry is absent from the runtime map,
  // so counting it would report coverage the renderer does not have.
  const body = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return Object.fromEntries(
    [...body.matchAll(/^\s+([A-Za-z0-9_]+):\s*'([^']+)'/gm)].map((entry) => [entry[1], entry[2]])
  );
}

const app = read('app.js');
const accountGroups = providerMap(app, 'LIMIT_PROVIDER_ACCOUNT_GROUP_IDS');
const accountStatuses = providerMap(app, 'LIMIT_PROVIDER_ACCOUNT_STATUS_IDS');
const connectionDetails = providerMap(app, 'LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS');

test('every account group reports its state through a status pill', () => {
  // limitProviderAccountGroup and limitProviderAccountStatus are looked up
  // independently, so a group with no status entry renders an expandable panel
  // that never shows whether the credential took.
  assert.deepEqual(Object.keys(accountGroups).sort(), Object.keys(accountStatuses).sort());
});

test('every catalog provider reaches an account group or a connection explainer', () => {
  // A deliberate contract, and stricter than the renderer's own
  // `accountGroup || settings || connectionDetailKey` gate. LIMIT_PROVIDER_SETTINGS
  // is that third path, but it holds display toggles — Claude prepaid balance,
  // Codex additional limits, OpenCode local limits — so a provider carrying only
  // a toggle would expand into options that cannot connect it. What is asserted
  // here is that every provider offers somewhere to put a credential, or an
  // explanation of how it connects without one.
  // The two maps are deliberately not exclusive — antigravity carries an
  // explainer above its account group — so this is a union, not a partition.
  const configured = new Set([...Object.keys(accountGroups), ...Object.keys(connectionDetails)]);
  assert.deepEqual([...configured].sort(), [...LIMIT_PROVIDER_IDS].sort());
});

test('every mapped settings element exists in index.html', () => {
  // Strip comments first: getElementById cannot see a commented-out element, so
  // matching inside one would report a surface the settings page has not got.
  const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
  // Require whitespace before the attribute. A bare `id="x"` also matches
  // data-id="x", and so does `\bid="x"` — the hyphen is a word boundary — and
  // neither is an element the renderer can look up.
  const tagWithId = (elementId) => html.match(new RegExp(`<[^>]*\\sid="${elementId}"[^>]*>`));
  for (const [provider, groupId] of Object.entries(accountGroups)) {
    assert.ok(tagWithId(groupId), `${provider} maps to a missing #${groupId}`);
  }
  for (const [provider, statusId] of Object.entries(accountStatuses)) {
    // Match the tag, then its attributes separately: the pill class is the
    // contract, the order it is written in is not.
    const tag = tagWithId(statusId);
    assert.ok(tag, `${provider} maps to a missing #${statusId}`);
    assert.match(tag[0], /class="[^"]*\bcursor-status-pill\b/, `#${statusId} should render as a status pill`);
  }
});

test('every connection explainer resolves to translated copy', () => {
  // limitProviderConnectionDetail passes the key straight to t(), which echoes
  // an unknown key back, so a missing entry ships the key itself as body text.
  // Only English is checked here; i18n.test.js holds the locales to it.
  for (const [provider, key] of Object.entries(connectionDetails)) {
    assert.ok(MESSAGES.en[key], `${provider} needs a ${key} entry in i18n.js`);
  }
});
