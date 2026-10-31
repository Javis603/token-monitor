'use strict';

// Placing a plugin view writes the setting each surface already owns, so the
// existing composers (Home order and hiding, Edge Dock items, the tray layout)
// keep working on plugin entries without a parallel placement store.

const placements = require('../../shared/plugins/placements');
const trayLayout = require('../../shared/trayLayout');
const { defaultEdgeDockItems, normalizeEdgeDockItems, MAX_ITEMS: MAX_EDGE_DOCK_ITEMS } = require('../renderer/edgeDock/items');

const PLACEMENT_SURFACES = Object.freeze(['home', 'edgeDock', 'tray', 'notch', 'page']);

function summaryBitmapRefs(settings) {
  if (settings.notchSummaryEnabled === false) return [];
  if (settings.notchSummaryMode === 'custom') return trayLayout.trayLayoutPluginRefs(settings.notchCustomLayout);
  return settings.notchSummaryMode === 'tray' && settings.trayContent === 'custom'
    ? trayLayout.trayLayoutPluginRefs(settings.trayCustomLayout) : [];
}

function splitList(value) {
  return String(value || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function placementsFor(settings, ref) {
  const token = placements.homeToken(ref);
  const hidden = new Set(splitList(settings?.hiddenHomeModules));
  return {
    page: placements.normalizeRefList(settings?.pluginMainPages, 32).includes(ref),
    home: splitList(settings?.homeModuleOrder).includes(token) && !hidden.has(token),
    edgeDock: (normalizeEdgeDockItems(settings?.edgeDockItems) || []).some((item) => item.type === 'plugin' && item.ref === ref),
    tray: settings?.trayContent === 'custom' && trayLayout.trayLayoutPluginRefs(settings?.trayCustomLayout).includes(ref),
    notch: placements.normalizeNotchPluginPages(settings?.notchPluginPages).includes(ref)
  };
}

function trayItemId(ref) {
  return `plugin-${ref.replace('/', '-')}`;
}

// Returns a settings patch. `context.defaultEdgeDockProviders` materialises
// the automatic dock list the first time it is edited; `context.trayPresetLayout`
// is the current tray preset expressed as a custom layout, so adding a plugin
// to a preset tray keeps what the user already sees.
function placementPatch(settings, { ref, surface, placed }, context = {}) {
  if (!placements.isRef(ref)) throw new Error('invalid plugin view');
  if (!PLACEMENT_SURFACES.includes(surface)) throw new Error('unknown surface');
  if (surface === 'page') {
    const pages = placements.normalizeRefList(settings.pluginMainPages, 32).filter(entry => entry !== ref);
    if (placed) {
      if (pages.length >= 32) throw new Error('page-full');
      pages.push(ref);
    }
    return { pluginMainPages: pages };
  }
  if (surface === 'home') {
    const token = placements.homeToken(ref);
    const order = splitList(settings.homeModuleOrder).filter((id) => id !== token);
    const hidden = splitList(settings.hiddenHomeModules).filter((id) => id !== token);
    if (placed) order.push(token);
    return { homeModuleOrder: order.join(','), hiddenHomeModules: hidden.join(',') };
  }
  if (surface === 'edgeDock') {
    const current = normalizeEdgeDockItems(settings.edgeDockItems);
    const base = current || defaultEdgeDockItems(context.defaultEdgeDockProviders || []);
    const items = base.filter((item) => !(item.type === 'plugin' && item.ref === ref));
    if (placed) {
      if (items.length >= MAX_EDGE_DOCK_ITEMS) throw new Error('edgeDock-full');
      items.push({ type: 'plugin', ref });
    }
    return { edgeDockItems: items };
  }
  if (surface === 'tray') {
    if (!placed) {
      const layout = trayLayout.normalizeTrayLayout(settings.trayCustomLayout);
      return { trayCustomLayout: { ...layout, items: layout.items.filter((item) => !(item.type === 'plugin' && item.ref === ref)) } };
    }
    const base = settings.trayContent === 'custom'
      ? trayLayout.normalizeTrayLayout(settings.trayCustomLayout)
      : trayLayout.normalizeTrayLayout(context.trayPresetLayout || trayLayout.createDefaultTrayLayout());
    const items = base.items.filter((item) => !(item.type === 'plugin' && item.ref === ref));
    if (items.length >= trayLayout.MAX_ITEMS) throw new Error('tray-full');
    items.push(trayLayout.createTrayLayoutItem('plugin', { ref, idFactory: () => trayItemId(ref) }));
    return { trayContent: 'custom', trayCustomLayout: { version: trayLayout.VERSION, items } };
  }
  const pages = placements.normalizeNotchPluginPages(settings.notchPluginPages).filter((entry) => entry !== ref);
  if (placed) {
    if (pages.length >= placements.MAX_NOTCH_PAGES) throw new Error('Notch page storage limit exceeded');
    pages.push(ref);
  }
  return { notchPluginPages: pages };
}

function removePluginPlacements(settings, id) {
  const owns = ref => typeof ref === 'string' && ref.startsWith(`${id}/`);
  const tokenPrefix = placements.homeToken(`${id}/x`).slice(0, -1);
  return {
    ...Object.fromEntries(['floatingBubbleCustomLayout', 'notchCustomLayout'].filter(key => Object.hasOwn(settings, key)).map(key => {
      const layout = trayLayout.normalizeTrayLayout(settings[key]);
      return [key, { ...layout, items: layout.items.filter(item => !(item.type === 'plugin' && owns(item.ref))) }];
    })),
    ...(Object.hasOwn(settings, 'notchPageOrder') ? { notchPageOrder: placements.normalizeNotchPageOrder(settings.notchPageOrder).filter(token => !token.startsWith(tokenPrefix)) } : {}),
    homeModuleOrder: splitList(settings.homeModuleOrder).filter(token => !token.startsWith(tokenPrefix)).join(','),
    hiddenHomeModules: splitList(settings.hiddenHomeModules).filter(token => !token.startsWith(tokenPrefix)).join(','),
    edgeDockItems: settings.edgeDockItems == null ? null : (normalizeEdgeDockItems(settings.edgeDockItems) || []).filter(item => !(item.type === 'plugin' && owns(item.ref))),
    trayCustomLayout: { ...trayLayout.normalizeTrayLayout(settings.trayCustomLayout), items: trayLayout.normalizeTrayLayout(settings.trayCustomLayout).items.filter(item => !(item.type === 'plugin' && owns(item.ref))) },
    ...(Object.hasOwn(settings, 'pluginContentOrder') ? { pluginContentOrder: Object.fromEntries(Object.entries(placements.normalizeContentOrder(settings.pluginContentOrder)).map(([target, refs]) => [target, refs.filter(ref => !owns(ref))])) } : {}),
    pluginContentSelections: Object.fromEntries(Object.entries(placements.normalizeContentSelections(settings.pluginContentSelections)).filter(([, ref]) => !owns(ref))),
    pluginMainPages: placements.normalizeRefList(settings.pluginMainPages, 32).filter(ref => !owns(ref)),
    notchPluginPages: placements.normalizeNotchPluginPages(settings.notchPluginPages).filter(ref => !owns(ref))
  };
}
module.exports = { summaryBitmapRefs, PLACEMENT_SURFACES, placementPatch, placementsFor, removePluginPlacements };
