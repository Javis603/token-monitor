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

function rendererSource() {
  return fs.readFileSync(path.join(rootDir, 'src/electron/renderer/app.js'), 'utf8');
}

function rendererStyles() {
  return fs.readFileSync(path.join(rootDir, 'src/electron/renderer/styles.css'), 'utf8');
}

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
  const block = rendererSource().match(/const clientsWithIcon = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'clientsWithIcon declaration should exist in app.js');
  const iconIds = new Set([...block[1].matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]));
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
  const styles = rendererStyles();
  for (const id of CLIENT_IDS) {
    // The class must be terminated by a selector separator, not just a word
    // boundary: the renderer applies exactly `row-icon-${client}`, so a suffixed
    // rule such as .row-icon-<id>-sm would satisfy \b while rendering nothing.
    const rule = styles.match(new RegExp(`\\.row-icon-${id}(?=[\\s,{])[^{}]*\\{([^}]*)\\}`));
    assert.ok(rule, `${id} needs a .row-icon-${id} rule in styles.css`);
    const asset = rule[1].match(/assets\/icons\/([a-z0-9-]+)\.svg/);
    assert.ok(asset, `.row-icon-${id} should reference an icon under assets/icons/`);
    assert.ok(
      fs.existsSync(path.join(rootDir, 'assets', 'icons', `${asset[1]}.svg`)),
      `.row-icon-${id} references assets/icons/${asset[1]}.svg, which does not exist`
    );
  }
});
