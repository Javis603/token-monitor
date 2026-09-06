'use strict';

// Catalog → limits presentation completeness.
//
// A limits provider renders as a mark through three hand-maintained surfaces:
// the icon set the Limits list picks a mark from, the tray set whose artwork is
// rasterized and handed to the OS, and the CSS mask that paints both. Each fails
// differently and none of them fails loudly — a missing mark draws a bare dot, a
// missing tray id draws the provider's first letter, and a missing mask rule
// draws a solid square. This file asserts each covers every
// LIMIT_PROVIDER_CATALOG entry, so a provider added without its presentation
// wiring fails CI instead of shipping unmarked.
//
// The direction matters. trayProviderIcons.test.js checks that assets exist, but
// it starts from its own hand-listed tool ids, so a provider that never reached
// that list is invisible to it. Starting from the catalog is what catches the
// entry that reached none of these surfaces.
//
// The catalog's other hand-wired presentation surfaces are already guarded from
// the catalog elsewhere and are deliberately not repeated here: the Swift
// WidgetFormat.provider mirror in macWidgetProviderLabels.test.js, the README
// tables in readmeConsistency.test.js, and account settings in
// limitProviderCoverage.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limitProviders');
const { trayProviderIconSources } = require('../../src/electron/renderer/trayProviderIcons');
const { limitProviderCapabilityTags } = require('../../src/electron/renderer/limitProviderPresentation');

const rootDir = path.join(__dirname, '..', '..');
const rendererDir = path.join(rootDir, 'src/electron/renderer');
const rendererPath = path.join(rendererDir, 'app.js');
const stylesPath = path.join(rendererDir, 'styles.css');

// Read the Sets the renderer actually builds, by evaluating their declarations
// rather than pattern-matching entries. Both are derived from the catalog now,
// so most of their membership is not in their own literal and there is nothing
// to pattern-match; evaluating is what keeps these checks reading the result
// production uses, whether it is derived or listed. It also lets the JS parser
// decide what a comment is. Read from source because the Sets are still declared
// inside app.js; when the renderer boundary is split this can require a module
// instead, without the invariant changing.
const ICON_SET_DECLARATIONS = [
  ['clientsWithIcon', 'new Set([', ']);'],
  ['limitMarksWithIcon', 'new Set([', ']);'],
  ['TRAY_ICON_VARIANTS', '[', '];'],
  ['trayIconProviderIds', 'new Set([', ']);']
];

function rendererIconSets() {
  const source = fs.readFileSync(rendererPath, 'utf8');
  const declarations = ICON_SET_DECLARATIONS.map(([name, opener, closer]) => {
    const start = source.indexOf(`const ${name} = ${opener}`);
    assert.notEqual(start, -1, `${name} should be declared in app.js as a \`${opener}\` literal`);
    const end = source.indexOf(closer, start);
    assert.notEqual(end, -1, `${name} should be a closed literal`);
    return source.slice(start, end + closer.length);
  });
  // Returned as a trailing expression, not read back off the sandbox: `const`
  // declarations never become properties of a contextified global.
  return vm.runInNewContext(
    `${declarations.join('\n')}\n({ limitMarksWithIcon, trayIconProviderIds })`,
    { LIMIT_PROVIDER_IDS }
  );
}

test('every catalog provider has a limits icon mark', () => {
  // Subset, never equality: the mark set is an icon table, not a provider list.
  // It also carries every tracked client, model-vendor ids, and relay ids that
  // are not providers at all, so requiring the two to match would fail on
  // entries that are correctly there.
  const { limitMarksWithIcon } = rendererIconSets();
  for (const id of LIMIT_PROVIDER_IDS) {
    assert.ok(limitMarksWithIcon.has(id), `${id} needs a limitMarksWithIcon entry in app.js`);
  }
});

test('every catalog provider has tray artwork the tray actually loads', () => {
  // Two halves, because either alone passes while the tray shows a letter. The
  // tray draws only what deliverTrayProviderIcons rasterized, and that iterates
  // trayIconProviderIds — so an id absent from that set has no tray image no
  // matter how many assets exist. Asking trayProviderIconSources for the catalog
  // directly would answer for every provider and prove nothing about the tray.
  const { trayIconProviderIds } = rendererIconSets();
  const missing = LIMIT_PROVIDER_IDS.filter((id) => !trayIconProviderIds.has(id));
  assert.deepEqual(missing, [], 'these providers are never given a tray image');

  // The other half: the composed path is never the thing missing — an unknown id
  // falls through to the id-named default — so what matters is whether a file is
  // behind it. The mapping is its own table because the menubar prefers
  // optimized artwork (claude, codex) and some providers share a vendor mark
  // (mimo, zaiteam); it does not always agree with the mask below, either —
  // grok is masked with xai.svg and trayed with grok.svg.
  const sources = trayProviderIconSources(trayIconProviderIds);
  for (const id of LIMIT_PROVIDER_IDS) {
    const resolved = path.resolve(rendererDir, sources[id]);
    assert.ok(
      fs.existsSync(resolved),
      `${id} trays ${sources[id]}, which resolves to a missing file: ${resolved}`
    );
  }
});

test('every catalog provider resolves to a mark asset through its CSS rule', () => {
  // One mask table, not two. renderLimitProviderMark used to carry a parallel
  // .limit-icon-<id> copy of every rule; it now sizes the mark and asks for the
  // same .row-icon-<id> mask a breakdown row does. That class name is built by
  // template literal, so nothing fails if it stops matching the table — which is
  // why the call site is asserted here, next to the table it depends on.
  const source = fs.readFileSync(rendererPath, 'utf8');
  assert.match(
    source,
    /mark\.className = `limit-icon row-icon-\$\{id\}`;/,
    'renderLimitProviderMark should draw its mark from the shared .row-icon-<id> table'
  );

  const styles = fs.readFileSync(stylesPath, 'utf8');
  for (const id of LIMIT_PROVIDER_IDS) {
    // The class must be terminated by a selector separator: the renderer applies
    // exactly `row-icon-${id}`, so neither a suffixed rule (.row-icon-<id>-sm)
    // nor a descendant rule (.row-icon-<id> .child) paints the element this
    // guard is about, and both would otherwise satisfy it.
    const rule = styles.match(new RegExp(`^\\.row-icon-${id}(?=\\s*[,{])[^{}]*\\{([^}]*)\\}`, 'm'));
    assert.ok(rule, `${id} needs a .row-icon-${id} rule in styles.css`);
    // The invariant is that a provider resolves to a mark, not that the mark is
    // named after it — zaiteam masks with zai.svg, mimo with xiaomi.svg — so the
    // rule is the mapping and the asset is checked through it. Resolve the URL
    // the way the browser does, relative to styles.css, so a wrong number of
    // parent segments fails here instead of painting an empty square.
    const url = rule[1].match(/url\(\s*['"]?([^'")\s]+\.svg)['"]?\s*\)/);
    assert.ok(url, `.row-icon-${id} should reference an .svg through url()`);
    const resolved = path.resolve(path.dirname(stylesPath), url[1]);
    assert.ok(
      fs.existsSync(resolved),
      `.row-icon-${id} references ${url[1]}, which resolves to a missing file: ${resolved}`
    );
  }
});

test('sharing one mask table keeps Grok the mark that differs between the two', () => {
  // Grok is the reason the shared table needs an override rather than a rename:
  // the tracked client reuses the vendor mask while the limits provider has its
  // own, and collapsing the two tables is exactly the change that would quietly
  // give the provider the vendor mark.
  const styles = fs.readFileSync(stylesPath, 'utf8');
  const override = styles.match(/\.limit-icon\.row-icon-grok(?=\s*[,{])[^{}]*\{([^}]*)\}/);
  assert.ok(override, 'the Limits list needs a .limit-icon.row-icon-grok override');
  assert.match(override[1], /icons\/grok\.svg/, 'the Limits mark should stay the Grok mark');
  const shared = styles.match(/^\.row-icon-grok(?=\s*[,{])[^{}]*\{([^}]*)\}/m);
  assert.ok(shared, 'the shared table needs a .row-icon-grok rule in styles.css');
  assert.match(shared[1], /icons\/xai\.svg/, 'the client row should stay the vendor mark');
});

test('every catalog provider has capability tags', () => {
  // Read through the accessor rather than the table behind it: a missing entry
  // is not an error there, it returns an empty list, so the settings row simply
  // renders without the tags that say how the provider is collected. Nothing
  // else fails, which is why this needs asserting from the catalog.
  for (const id of LIMIT_PROVIDER_IDS) {
    const tags = limitProviderCapabilityTags(id);
    assert.ok(
      Array.isArray(tags) && tags.length > 0,
      `${id} needs a CAPABILITY_TAGS entry in limitProviderPresentation.js`
    );
  }
});
