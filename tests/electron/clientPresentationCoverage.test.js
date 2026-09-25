'use strict';

// Catalog → presentation completeness.
//
// Every tracked client needs a colour, a vendor label, an ordering slot and a
// row icon before it renders correctly. All four derive from one entry in the
// vendor presentation table (src/shared/vendorPresentation.js), and this file
// asserts each derived surface covers every CLIENT_CATALOG entry, so a client
// added without that entry fails CI instead of shipping as an unlabelled grey
// row.
//
// The direction matters: themePresets.test.js already checks that every
// clientColors brand key has a label and an ordering slot. That starts from the
// colour table. These checks start from the catalog, which is what catches a
// client that never reached the colour table at all.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { CLIENT_IDS, CLIENT_LABELS } = require('../../src/shared/clientCatalog');
const { VENDOR_ORDER, VENDOR_LABELS } = require('../../src/electron/renderer/themePresets');
const { clientColors } = require('../../src/electron/renderer/usageCharts');
const { VENDOR_IDS } = require('../../src/shared/vendorPresentation');
const { STYLES_PATH: stylesPath, rendererStyles } = require('../helpers/rendererStyles');

const rootDir = path.join(__dirname, '..', '..');
const rendererPath = path.join(rootDir, 'src/electron/renderer/app.js');

test('every catalog client has a usage chart colour', () => {
  assert.deepEqual(
    Object.keys(clientColors).filter((id) => CLIENT_IDS.includes(id)),
    CLIENT_IDS,
    'tracked clientColors entries should follow CLIENT_CATALOG display order'
  );
  for (const id of CLIENT_IDS) {
    assert.ok(clientColors[id], `${id} needs a clientColors entry in usageCharts.js`);
  }
});

test('every catalog client has a vendor ordering slot and label', () => {
  assert.deepEqual(
    VENDOR_ORDER.filter((id) => CLIENT_IDS.includes(id)),
    CLIENT_IDS,
    'tracked VENDOR_ORDER entries should follow CLIENT_CATALOG display order'
  );
  assert.deepEqual(
    Object.keys(VENDOR_LABELS).filter((id) => CLIENT_IDS.includes(id)),
    CLIENT_IDS,
    'tracked VENDOR_LABELS entries should follow CLIENT_CATALOG display order'
  );
  for (const id of CLIENT_IDS) {
    assert.ok(VENDOR_ORDER.includes(id), `${id} needs a VENDOR_ORDER slot in themePresets.js`);
    assert.ok(VENDOR_LABELS[id], `${id} needs a VENDOR_LABELS entry in themePresets.js`);
  }
});

test('every catalog client has a vendor mark', () => {
  // Subset, never equality: the vendor table also carries model-vendor ids and
  // limits marks. app.js builds clientsWithIcon from VENDOR_IDS
  // (rendererClientLabels.test.js asserts that), so this is the icon set.
  assert.deepEqual(
    VENDOR_IDS.filter((id) => CLIENT_IDS.includes(id)),
    CLIENT_IDS,
    'tracked vendor entries should follow CLIENT_CATALOG display order'
  );
});

test('every catalog client resolves to an icon asset through its CSS rule', () => {
  // The invariant is that a client resolves to an icon, not that the file is
  // named after the client. Several clients deliberately reuse a vendor mark
  // (hermes → hermes-agent.svg, grok → xai.svg, mimo → xiaomi.svg,
  // zcode → zai.svg), so the installed mask rule is the mapping and the asset
  // is checked through it rather than assumed from the id.
  const styles = rendererStyles();
  for (const id of CLIENT_IDS) {
    // The class must be terminated by a selector separator: the renderer applies
    // exactly `row-icon-${client}`, so neither a suffixed rule
    // (.row-icon-<id>-sm) nor a descendant rule (.row-icon-<id> .child) styles
    // the element this guard is about, and both would otherwise satisfy it.
    const rule = styles.match(new RegExp(`\\.row-icon-${id}(?=\\s*[,{])[^{}]*\\{([^}]*)\\}`));
    assert.ok(rule, `${id} needs a .row-icon-${id} mask (a vendor table entry)`);
    // Resolve the URL the way the browser does — relative to styles.css — so a
    // wrong number of parent segments fails here instead of rendering a broken
    // icon. Matching the basename alone would accept any depth.
    const url = rule[1].match(/url\(\s*['"]?([^'")\s]+\.svg)['"]?\s*\)/);
    assert.ok(url, `.row-icon-${id} should reference an .svg through url()`);
    const resolved = path.resolve(path.dirname(stylesPath), url[1]);
    assert.ok(
      fs.existsSync(resolved),
      `.row-icon-${id} references ${url[1]}, which resolves to a missing file: ${resolved}`
    );
  }
});

test('the subscription usage comparison reads the scan, never a display-label table', () => {
  // Same category of mistake as clientsWithIcon above, in the other direction:
  // CLIENT_LABELS is a display lookup, not a client list. It deliberately
  // carries ids that are not catalog clients, so a key in it answers "can we
  // render a name for this" rather than "does this provider name a client we
  // count tokens for". The comparison needs the second question — it decides
  // whether a subscription's price is set against a usage figure — and it now
  // asks it of the map the scan itself produced: every key there is a client id
  // by construction, so no label table can be consulted even by accident. Read
  // from source because the answer is which accessor the function reads.
  const labelOnly = Object.keys(CLIENT_LABELS).filter((id) => !CLIENT_IDS.includes(id));
  const view = fs.readFileSync(path.join(rootDir, 'src/electron/renderer/limitWindowsView.js'), 'utf8');
  const body = view.match(/function subscriptionUsageCostUsd\([\s\S]*?\n {2}\}/);
  assert.ok(body, 'subscriptionUsageCostUsd should exist in the shared view');
  assert.doesNotMatch(
    body[0],
    /clientLabels|CLIENT_LABELS|catalogClientIds/,
    `subscriptionUsageCostUsd must not read a label table as a membership test; CLIENT_LABELS alone carries ${labelOnly.length} non-catalog id(s) (${labelOnly.join(', ') || 'none right now'})`
  );
  assert.match(body[0], /monthClientCosts\(\)/, 'the month costs are read through the dep the host supplies');

  // And every key in it is resolved through the catalog rather than compared to
  // the provider id, which is the same question one level down: a provider whose
  // client is named otherwise (droid, zcode, qodercn, dsh) has its cost
  // under that client's key, so an id comparison answers "no usage" for it
  // forever.
  assert.match(
    body[0],
    /limitProviderForClient\(client\)/,
    'the client key decides which provider a cost belongs to, not the id spelling'
  );

  // And the hosts supply the scan's own figure. The dock reaches it through the
  // cell it is rendering rather than the appearance: costs change on every stats
  // push, while the appearance is only re-pushed when settings change.
  const app = fs.readFileSync(rendererPath, 'utf8');
  const dock = fs.readFileSync(path.join(rootDir, 'src/electron/renderer/edgeDock/dock.js'), 'utf8');
  const presentation = fs.readFileSync(
    path.join(rootDir, 'src/electron/renderer/edgeDock/presentation.js'), 'utf8'
  );
  assert.match(app, /monthClientCosts: \(\) => state\.stats\?\.periods\?\.month\?\.clientCosts,/);
  assert.match(dock, /monthClientCosts: \(\) => state\.payload\?\.cell\?\.monthClientCosts,/);
  assert.match(presentation, /monthClientCosts: options\.stats\?\.periods\?\.month\?\.clientCosts \|\| \{\}/);
});
