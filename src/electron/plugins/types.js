'use strict';
// Display metadata only: these labels never grant permissions or enable views.
const TYPES = Object.freeze(['widget', 'page', 'appearance', 'automation']);
function normalizeTypes(value) {
  return TYPES.filter(type => Array.isArray(value) && value.includes(type));
}
function pluginTypes(manifest) {
  const surfaces = (manifest.views || []).flatMap(view => view.surfaces || []);
  return [
    surfaces.some(surface => ['home', 'tray', 'edgeDock', 'notch'].includes(surface)) && 'widget',
    (surfaces.includes('page') || (manifest.views || []).some(view => view.targets?.length)) && 'page',
    manifest.skins?.length > 0 && 'appearance',
    manifest.category === 'automation' && 'automation'
  ].filter(Boolean);
}
module.exports = { normalizeTypes, pluginTypes };
