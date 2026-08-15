'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createTrayProviderIconDeliveryGuard,
  isFlatInkPixels,
  trayProviderIconSources,
  trayProviderBadgeLayout,
  trayProviderOpticalLayout,
  trayProviderOpticalRatio
} = require('../../src/electron/renderer/trayProviderIcons');

const CURRENT_TOOLS = ['claude', 'codex', 'hermes', 'opencode', 'openclaw', 'cursor', 'antigravity', 'cline', 'grok', 'commandcode', 'reasonix'];

function assetPathFromRendererSource(source) {
  return path.resolve(__dirname, '..', '..', 'src', 'electron', 'renderer', source);
}

test('tray provider icon sources cover all currently supported tools', () => {
  const sources = trayProviderIconSources(CURRENT_TOOLS);
  assert.deepEqual(Object.keys(sources).sort(), CURRENT_TOOLS.slice().sort());
  for (const tool of CURRENT_TOOLS) {
    assert.equal(fs.existsSync(assetPathFromRendererSource(sources[tool])), true, `${tool} icon asset exists`);
  }
});

test('tray provider icon sources keep optimized menubar icons where available', () => {
  const sources = trayProviderIconSources(CURRENT_TOOLS);
  assert.equal(sources.claude, '../../../assets/icons/tray-claude.svg');
  assert.equal(sources.codex, '../../../assets/icons/tray-codex.svg');
  assert.equal(trayProviderIconSources(['claude-brand'])['claude-brand'], '../../../assets/icons/claude.svg');
  assert.equal(trayProviderIconSources(['chatgpt']).chatgpt, '../../../assets/icons/codex.svg');
  assert.equal(sources.hermes, '../../../assets/icons/hermes-agent.svg');
  assert.equal(sources.grok, '../../../assets/icons/grok.svg');
  assert.equal(trayProviderIconSources(['kimi']).kimi, '../../../assets/icons/kimi.svg');
  assert.equal(trayProviderIconSources(['micode']).micode, '../../../assets/icons/xiaomi.svg');
  assert.equal(trayProviderIconSources(['mimo']).mimo, '../../../assets/icons/xiaomi.svg');
  assert.equal(trayProviderIconSources(['zcode']).zcode, '../../../assets/icons/zai.svg');
  assert.equal(trayProviderIconSources(['zaiteam']).zaiteam, '../../../assets/icons/zai.svg');
  const thirdPartySource = trayProviderIconSources(['thirdparty']).thirdparty;
  assert.equal(thirdPartySource, '../../../assets/icons/newapi.svg');
  assert.equal(fs.existsSync(assetPathFromRendererSource(thirdPartySource)), true);
  // CodeBuddy/WorkBuddy have their own brand svg, so they fall through to the id-named default.
  assert.equal(trayProviderIconSources(['codebuddy']).codebuddy, '../../../assets/icons/codebuddy.svg');
  assert.equal(trayProviderIconSources(['workbuddy']).workbuddy, '../../../assets/icons/workbuddy.svg');
});

test('tray provider badge stays legible at renderer and native tray sizes', () => {
  assert.deepEqual(trayProviderBadgeLayout(44), {
    iconSize: 44,
    badgeSize: 19,
    x: 24,
    y: 24,
    radius: 5,
    borderWidth: 2
  });
  assert.deepEqual(trayProviderBadgeLayout(20), {
    iconSize: 20,
    badgeSize: 9,
    x: 10,
    y: 10,
    radius: 3,
    borderWidth: 2
  });
});

test('tray provider optical layout gives differently padded artwork one shared visible box', () => {
  assert.deepEqual(trayProviderOpticalLayout({ width: 128, height: 128 }, 44), {
    x: 4.84,
    y: 4.84,
    width: 34.32,
    height: 34.32
  });
  assert.deepEqual(trayProviderOpticalLayout({ width: 96, height: 48 }, 44), {
    x: 4.84,
    y: 13.42,
    width: 34.32,
    height: 17.16
  });
});

test('Claude Code keeps its intentional wide mark while other providers use the shared optical box', () => {
  assert.equal(trayProviderOpticalRatio('claude'), 1);
  assert.equal(trayProviderOpticalRatio('claude-brand'), 0.78);
  assert.equal(trayProviderOpticalRatio('codex'), 0.78);
});

test('tray provider icon delivery guard invalidates older async work', () => {
  const guard = createTrayProviderIconDeliveryGuard();
  const olderDelivery = guard.begin();
  assert.equal(guard.isCurrent(olderDelivery), true);

  const latestDelivery = guard.begin();
  assert.equal(guard.isCurrent(olderDelivery), false);
  assert.equal(guard.isCurrent(latestDelivery), true);
});

// Which provider marks may be re-inked for a dark taskbar. This is the one
// genuinely heuristic step in that decision, so it is tested against pixels
// rather than only through the palette helper that consumes its verdict.
function rgbaPixels(...stops) {
  return Uint8ClampedArray.from(stops.flat());
}

test('a flat mark reads as single ink however soft its edges are', () => {
  // A `fill="currentColor"` mark: one colour, coverage carried entirely by alpha.
  assert.equal(isFlatInkPixels(rgbaPixels([0, 0, 0, 255], [0, 0, 0, 140], [0, 0, 0, 30])), true);
  // pi and proma are authored white rather than black.
  assert.equal(isFlatInkPixels(rgbaPixels([255, 255, 255, 255], [255, 255, 255, 96])), true);
  // Rasterization leaves channels off by a hair; that is inside the tolerance.
  assert.equal(isFlatInkPixels(rgbaPixels([0, 3, 2, 255], [4, 0, 1, 210])), true);
  // Pixels below the alpha floor are not ink and cannot decide anything.
  assert.equal(isFlatInkPixels(rgbaPixels([0, 0, 0, 255], [200, 30, 30, 4])), true);
});

test('brand artwork is not single ink and must be left in colour', () => {
  // tray-claude.svg is a solid terracotta: one colour, but not achromatic.
  assert.equal(isFlatInkPixels(rgbaPixels([217, 119, 87, 255])), false);
  assert.equal(isFlatInkPixels(rgbaPixels([0, 0, 0, 255], [217, 119, 87, 255])), false);
  // Greyscale with real shading: achromatic, yet more than one tone. Re-inking
  // this would flatten the artwork, which is why one condition is not enough.
  assert.equal(isFlatInkPixels(rgbaPixels([20, 20, 20, 255], [150, 150, 150, 255])), false);
});

test('nothing opaque means no ink to match, so the artwork is left untouched', () => {
  assert.equal(isFlatInkPixels(rgbaPixels([0, 0, 0, 0], [255, 255, 255, 5])), false);
  assert.equal(isFlatInkPixels(rgbaPixels()), false);
  assert.equal(isFlatInkPixels(null), false);
  assert.equal(isFlatInkPixels(undefined), false);
});

test('the alpha floor and the tolerance are both adjustable for callers', () => {
  const nearlyClear = rgbaPixels([0, 0, 0, 20]);
  assert.equal(isFlatInkPixels(nearlyClear), true);
  assert.equal(isFlatInkPixels(nearlyClear, { alphaThreshold: 40 }), false, 'raised floor discards the only ink');
  const twoTones = rgbaPixels([20, 20, 20, 255], [60, 60, 60, 255]);
  assert.equal(isFlatInkPixels(twoTones), false);
  assert.equal(isFlatInkPixels(twoTones, { tolerance: 64 }), true);
});
