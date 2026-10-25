'use strict';
// Display metadata only: these labels never grant permissions or enable views.
const TYPES = Object.freeze(['widget', 'page', 'appearance']);
function normalizeTypes(value) {
  return TYPES.filter(type => Array.isArray(value) && value.includes(type));
}
function pluginTypes(manifest) {
  const surfaces = (manifest.views || []).flatMap(view => view.surfaces || []);
  const documents = manifest.webUi?.documents || [];
  return [
    surfaces.some(surface => ['home', 'tray', 'edgeDock', 'notch'].includes(surface)) && 'widget',
    (surfaces.includes('page') || documents.some(doc => ['model', 'tool', 'device', 'page'].includes(doc.target))) && 'page',
    manifest.skins?.length > 0 && 'appearance'
  ].filter(Boolean);
}
module.exports = { normalizeTypes, pluginTypes };
