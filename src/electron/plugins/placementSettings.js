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

function normalizePlacementDefaults(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [id, entry] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id) || !entry || typeof entry.applied !== 'boolean' || !Array.isArray(entry.placements) || entry.placements.length > 256) continue;
    if (entry.placements.some(choice => !choice || !placements.isRef(choice.ref) || !choice.ref.startsWith(`${id}/`) || !PLACEMENT_SURFACES.includes(choice.surface))) continue;
    result[id] = { applied: entry.applied, placements: entry.placements.map(({ ref, surface }) => ({ ref, surface })) };
  }
  return result;
}

// Stored separately from executable trust so kept placements include an explicit
// choice of no locations, even across uninstall/reinstall.
function initialPlacements(manifest, selected) {
  const allowed = new Set(manifest.views.flatMap(view => view.surfaces.filter(surface => PLACEMENT_SURFACES.includes(surface)).map(surface => `${manifest.id}/${view.id}:${surface}`)));
  const choices = selected === undefined
    ? manifest.views.flatMap(view => (view.defaultSurfaces || []).map(surface => ({ ref: `${manifest.id}/${view.id}`, surface }))) : selected;
  if (!Array.isArray(choices) || choices.length > 256 || choices.some(choice => !choice || !allowed.has(`${choice.ref}:${choice.surface}`))) throw new Error('invalid initial plugin placements');
  const keys = choices.map(choice => `${choice.ref}:${choice.surface}`);
  if (new Set(keys).size !== keys.length) throw new Error('duplicate initial plugin placements');
  return choices.map(({ ref, surface }) => ({ ref, surface }));
}

function initializePlacementPatch(settings, id, context = {}, views = null) {
  const preferences = settings.pluginPlacementDefaults;
  const preference = preferences && Object.hasOwn(preferences, id) ? preferences[id] : null;
  if (!preference || preference.applied) return {};
  const patch = {};
  for (const choice of preference.placements) {
    if (views && !views.some(view => (view.ref || `${id}/${view.id}`) === choice.ref && view.surfaces.includes(choice.surface))) continue;
    if (placementsFor({ ...settings, ...patch }, choice.ref)[choice.surface]) continue;
    try { Object.assign(patch, placementPatch({ ...settings, ...patch }, { ...choice, placed: true }, context)); }
    catch (error) {
      // A default never evicts existing content. Users can place it later.
      if (!['page-full', 'edgeDock-full', 'tray-full', 'Notch page storage limit exceeded'].includes(error.message)) throw error;
    }
  }
  patch.pluginPlacementDefaults = { ...settings.pluginPlacementDefaults, [id]: { ...preference, applied: true } };
  return patch;
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
module.exports = { normalizePlacementDefaults, initialPlacements, initializePlacementPatch, summaryBitmapRefs, PLACEMENT_SURFACES, placementPatch, placementsFor, removePluginPlacements };
