'use strict';

// Catalog → presentation completeness.
//
// Every tracked client needs a colour, a vendor label, an ordering slot and a
// row icon before it renders correctly, and each of those lives in its own
// hand-maintained table. This file asserts that each table covers every
// CLIENT_CATALOG entry, so a client added without its presentation wiring fails
// CI instead of shipping as an unlabelled grey row.
//
// The direction matters: themePresets.test.js already checks that every
// clientColors brand key has a label and an ordering slot. That starts from the
// colour table. These checks start from the catalog, which is what catches a
// client that never reached the colour table at all.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { CLIENT_IDS } = require('../../src/shared/clientCatalog');
const { VENDOR_ORDER, VENDOR_LABELS } = require('../../src/electron/renderer/themePresets');
const { clientColors } = require('../../src/electron/renderer/usageCharts');

const rootDir = path.join(__dirname, '..', '..');
const rendererPath = path.join(rootDir, 'src/electron/renderer/app.js');
const stylesPath = path.join(rootDir, 'src/electron/renderer/styles.css');

test('every catalog client has a usage chart colour', () => {
  for (const id of CLIENT_IDS) {
    assert.ok(clientColors[id], `${id} needs a clientColors entry in usageCharts.js`);
  }
});

test('every catalog client has a vendor ordering slot and label', () => {
  for (const id of CLIENT_IDS) {
    assert.ok(VENDOR_ORDER.includes(id), `${id} needs a VENDOR_ORDER slot in themePresets.js`);
    assert.ok(VENDOR_LABELS[id], `${id} needs a VENDOR_LABELS entry in themePresets.js`);
  }
});

test('clientsWithIcon covers every catalog client', () => {
  // Subset, never equality: clientsWithIcon is an icon table, not a client list.
  // It also carries model-vendor ids and, through limitMarksWithIcon, limits
  // marks, so requiring the two to match would fail on entries that are
  // correctly there. Read from source because the Set is still declared inside
  // app.js; when the renderer boundary is split this can read a module instead,
  // without the invariant changing.
  const source = fs.readFileSync(rendererPath, 'utf8');
  const block = source.match(/const clientsWithIcon = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'clientsWithIcon declaration should exist in app.js');
  // Strip comments first: a commented-out id is absent from the runtime Set, so
  // counting it would report coverage the renderer does not have.
  const entries = block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const iconIds = new Set([...entries.matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]));
  for (const id of CLIENT_IDS) {
    assert.ok(iconIds.has(id), `${id} should resolve to an icon row`);
  }
});

test('every catalog client resolves to an icon asset through its CSS rule', () => {
  // The invariant is that a client resolves to an icon, not that the file is
  // named after the client. Several clients deliberately reuse a vendor mark
  // (hermes → hermes-agent.svg, grok → xai.svg, micode → xiaomi.svg,
  // zcode → zai.svg), so the CSS rule is the mapping and the asset is checked
  // through it rather than assumed from the id.
  const styles = fs.readFileSync(stylesPath, 'utf8');
  for (const id of CLIENT_IDS) {
    // The class must be terminated by a selector separator: the renderer applies
    // exactly `row-icon-${client}`, so neither a suffixed rule
    // (.row-icon-<id>-sm) nor a descendant rule (.row-icon-<id> .child) styles
    // the element this guard is about, and both would otherwise satisfy it.
    const rule = styles.match(new RegExp(`\\.row-icon-${id}(?=\\s*[,{])[^{}]*\\{([^}]*)\\}`));
    assert.ok(rule, `${id} needs a .row-icon-${id} rule in styles.css`);
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
