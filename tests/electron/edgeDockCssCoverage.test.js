'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const dockCss = path.join(rendererDir, 'edgeDock', 'dock.css');

// `.edge-dock-*` belongs to one page, and that page's own sources are the ones
// that can emit it, so a class no source names is a rule that dresses nothing.
function emittedClasses(dir) {
  const found = new Set();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const name of emittedClasses(full)) found.add(name);
      continue;
    }
    if (!/\.(?:js|html)$/.test(entry.name)) continue;
    const source = fs.readFileSync(full, 'utf8');
    for (const match of source.matchAll(/edge-dock-[a-z0-9-]+/g)) found.add(match[0]);
  }
  return found;
}

test('every class the dock stylesheet styles is still rendered somewhere', () => {
  // The card was rebuilt on the Limits view's own rows and its own row builders
  // were deleted, but the rules that dressed them stayed behind: they hung off
  // `.edge-dock-account`, a wrapper that no longer existed, so the card's quota
  // grid gap and its tooltip clamp described nothing while reading as if they
  // applied — and the rule above the Codex forecast went missing in a
  // single-account card the same way, because the block that used to carry it
  // was gone. CSS cannot fail, so nothing reported any of it. Comments are
  // stripped first: a selector named in prose is not a rule.
  const css = fs.readFileSync(dockCss, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const declared = new Set(
    (css.match(/\.edge-dock-[a-z0-9-]+/g) || []).map((token) => token.slice(1))
  );
  assert.ok(declared.size > 20, 'the stylesheet should still be the dock sheet');
  const emitted = emittedClasses(rendererDir);
  const dead = [...declared].filter((name) => !emitted.has(name));
  assert.deepEqual(dead, [], `dock.css styles classes nothing renders: ${dead.join(', ')}`);
});
