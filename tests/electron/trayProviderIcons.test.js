'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createTrayLayoutItem, resolveTrayLayout, VERSION } = require('../../src/shared/trayLayout');

const {
  createTrayProviderIconDeliveryGuard,
  isFlatInkPixels,
  trayProviderIconDemand,
  trayProviderIconSources,
  trayProviderBadgeLayout,
  trayProviderOpticalLayout,
  trayProviderOpticalRatio
} = require('../../src/electron/renderer/trayProviderIcons');

const CURRENT_TOOLS = ['claude', 'codex', 'hermes', 'opencode', 'openclaw', 'cursor', 'antigravity', 'cline', 'amp', 'grok', 'commandcode', 'reasonix', 'dsh', 'lmstudio', 'unsloth', 'devin'];

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
  assert.equal(trayProviderIconSources(['mimo']).mimo, '../../../assets/icons/xiaomi.svg');
  assert.equal(trayProviderIconSources(['zcode']).zcode, '../../../assets/icons/zai.svg');
  assert.equal(trayProviderIconSources(['zaiteam']).zaiteam, '../../../assets/icons/zai.svg');
  const thirdPartySource = trayProviderIconSources(['thirdparty']).thirdparty;
  assert.equal(thirdPartySource, '../../../assets/icons/thirdparty.svg');
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

test('a standalone mark fills the Windows notification-area cell, everywhere else keeps the inset', () => {
  // Windows gives each tray icon one square cell and spaces the cells itself, so
  // the 0.78 optical inset left a quarter of that cell empty at every scale
  // (#314): 12px of mark in the 16px cell at 100%, 18px in the 24px cell at 150%.
  assert.equal(trayProviderOpticalRatio('codex', { standalone: true, platform: 'win32' }), 1);
  assert.equal(trayProviderOpticalRatio('codex', { standalone: true, platform: 'darwin' }), 0.78);
  assert.equal(trayProviderOpticalRatio('codex', { standalone: true, platform: 'linux' }), 0.78);
  // Composed icons (bars / sessions / the custom layout) share their canvas with
  // bars or text on every platform, so the mark keeps its breathing room there.
  assert.equal(trayProviderOpticalRatio('codex', { platform: 'win32' }), 0.78);
  assert.equal(trayProviderOpticalRatio('codex', { standalone: false, platform: 'win32' }), 0.78);
});

test('a standalone Windows mark is scaled to fill its box edge to edge', () => {
  const ratio = trayProviderOpticalRatio('codex', { standalone: true, platform: 'win32' });
  assert.deepEqual(trayProviderOpticalLayout({ width: 128, height: 128 }, 44, ratio), {
    x: 0,
    y: 0,
    width: 44,
    height: 44
  });
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

test('tray icon demand covers reported usage, limit providers and layout picks', () => {
  const demand = trayProviderIconDemand({
    stats: {
      periods: {
        today: { clients: { codex: 10, ' Claude ': 2 }, clientCosts: { hermes: 0.2 } },
        allTime: { clients: { opencode: 4 } }
      },
      limits: { providers: [{ provider: 'cursor' }, {}] }
    },
    layouts: [
      { items: [{ type: 'icon', source: { provider: 'claude-brand' } }, { type: 'icon', source: { provider: 'auto' } }] },
      { items: [{ type: 'bars', rows: [{ provider: 'kimi' }, { provider: 'auto' }] }] },
      null
    ]
  });
  assert.deepEqual([...demand].sort(), ['claude', 'claude-brand', 'codex', 'cursor', 'hermes', 'kimi', 'opencode']);
});

test('the recent provider icon is available before the provider reports usage or limits', () => {
  const stats = {
    localRecentUsageActivity: { provider: 'codex' },
    periods: { today: { clients: { claude: 10 } } }
  };
  const layout = {
    version: VERSION,
    items: [{ ...createTrayLayoutItem('providerIcon'), autoMode: 'recent' }]
  };
  const availableProviderIds = [...trayProviderIconDemand({ stats, layouts: [layout] })];

  assert.equal(resolveTrayLayout(layout, stats, { availableProviderIds }).items[0].provider, 'codex');
});

test('tray icon demand stays empty without data or layouts', () => {
  assert.deepEqual([...trayProviderIconDemand()], []);
  assert.deepEqual([...trayProviderIconDemand({ stats: { periods: { today: null } }, layouts: [{ items: [{ type: 'text' }] }] })], []);
});

function trayMarkDeliveryFixture(loadImage) {
  const app = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const refreshStart = app.indexOf('function refreshTrayComposers(');
  const refreshEnd = app.indexOf('\nfunction loadImage(', refreshStart);
  const start = app.indexOf('function trayProviderIconDemand() {');
  const end = app.indexOf('\nfunction setAccountGroupExpanded(', start);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart && start >= 0 && end > start);
  const context = {
    state: { settings: {}, stats: null, pluginCatalog: { limits: { modules: [] } } },
    window: {
      tokenMonitor: { setTrayIcons: async () => {} },
      TokenMonitorTrayProviderIcons: require('../../src/electron/renderer/trayProviderIcons'),
      TokenMonitorTrayComposer: { syncTrayComposerSurfaces() {} }
    },
    els: {},
    trayComposers: {},
    createTrayComposer() {},
    syncCustomTrayClockTimer() {},
    trayIconProviderIds: new Set(['claude-brand', 'chatgpt', 'codex', 'claude']),
    trayProviderImages: {},
    trayProviderImageIds: new WeakMap(),
    trayProviderImageOpticalSamples: new WeakMap(),
    trayProviderIconsRequested: new Set(),
    trayProviderIconsLoading: new Set(),
    trayProviderIconDeliveryGuard: createTrayProviderIconDeliveryGuard(),
    loadImage,
    providerImageOpticalSample: () => ({ canvas: {} }),
    providerImageToPngDataUrl: () => 'bitmap',
    isSettingsSurfaceVisible: () => false,
    statsForTrayComposer: () => ({ limits: { providers: [{ provider: 'codex' }, { provider: 'claude' }] } }),
    maybeUpdateBarsIcon() {},
    renderFloatingBubbleContent() {}
  };
  vm.createContext(context);
  vm.runInContext(app.slice(refreshStart, refreshEnd), context);
  vm.runInContext(app.slice(start, end), context);
  const pick = (provider) => {
    context.state.settings = { trayCustomLayout: { items: [{ type: 'icon', source: { provider } }] } };
  };
  return { context, pick };
}

test('opening the tray composer requests the providers used by its quota preview', async () => {
  const { context } = trayMarkDeliveryFixture(() => Promise.resolve({}));
  await context.deliverTrayProviderIcons();
  assert.deepEqual(Object.keys(context.trayProviderImages), ['app']);

  context.isSettingsSurfaceVisible = () => true;
  context.refreshTrayComposers();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(Object.keys(context.trayProviderImages).sort(), ['app', 'claude', 'codex']);
});

test('a mark dropped by a superseded delivery is requested again when it returns to demand', async () => {
  let finishBrand;
  const loads = [];
  const { context, pick } = trayMarkDeliveryFixture((source) => {
    loads.push(source);
    if (source.endsWith('/claude.svg') && !finishBrand) return new Promise((resolve) => { finishBrand = resolve; });
    return Promise.resolve({});
  });
  pick('claude-brand');
  const superseded = context.deliverTrayProviderIcons();
  pick('chatgpt');
  await context.deliverTrayProviderIcons();
  finishBrand({});
  await superseded;
  assert.equal(context.trayProviderImages['claude-brand'], undefined);

  pick('claude-brand');
  context.syncTrayProviderIconDemand();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(context.trayProviderImages['claude-brand'], 'the dropped mark is delivered once it is wanted again');
  assert.ok(context.trayProviderImages.chatgpt);
});

test('a mark loaded by a superseded delivery is sent once it returns to demand', async () => {
  let finishApp;
  const sent = [];
  const { context, pick } = trayMarkDeliveryFixture((source) => {
    if (source.endsWith('tray-token-monitor.png') && !finishApp) return new Promise((resolve) => { finishApp = resolve; });
    return Promise.resolve({});
  });
  context.window.tokenMonitor.setTrayIcons = async (icons) => {
    for (const [id, bitmap] of Object.entries(icons)) if (bitmap !== null) sent.push(id);
  };
  pick('claude-brand');
  const superseded = context.deliverTrayProviderIcons();
  await new Promise((resolve) => setImmediate(resolve));
  pick('chatgpt');
  await context.deliverTrayProviderIcons();
  finishApp({});
  await superseded;
  assert.ok(context.trayProviderImages['claude-brand'], 'the superseded delivery cached the mark');
  assert.equal(sent.includes('claude-brand'), false, 'but never sent it to main');

  pick('claude-brand');
  context.syncTrayProviderIconDemand();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.includes('claude-brand'), true);
});

test('a mark left out of a theme redelivery is drawn for the new theme when it returns', async () => {
  const { context, pick } = trayMarkDeliveryFixture(() => Promise.resolve({}));
  let theme = 'dark';
  const held = {};
  context.providerImageToPngDataUrl = () => `bitmap-${theme}`;
  context.window.tokenMonitor.setTrayIcons = async (icons) => {
    for (const [id, bitmap] of Object.entries(icons)) {
      if (bitmap === null) delete held[id];
      else held[id] = bitmap;
    }
  };
  pick('claude-brand');
  await context.deliverTrayProviderIcons();
  assert.equal(held['claude-brand'], 'bitmap-dark');

  pick('chatgpt');
  theme = 'light';
  await context.deliverTrayProviderIcons();
  assert.equal(held['claude-brand'], undefined, 'main drops the old-theme bitmap');

  pick('claude-brand');
  context.syncTrayProviderIconDemand();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(held['claude-brand'], 'bitmap-light');
});

test('a mark that failed to load is not retried on every stats push', async () => {
  let loads = 0;
  const { context, pick } = trayMarkDeliveryFixture((source) => {
    if (source.endsWith('/claude.svg')) { loads += 1; return Promise.reject(new Error('decode')); }
    return Promise.resolve({});
  });
  pick('claude-brand');
  await context.deliverTrayProviderIcons();
  context.syncTrayProviderIconDemand();
  context.syncTrayProviderIconDemand();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
});
