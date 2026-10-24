'use strict';
// Versioned authored-document contract. Paths are portable package entries,
// never URLs or host filesystem paths. The renderer receives no internal DOM.
const TARGETS = Object.freeze(['model', 'tool', 'device']);
const SURFACES = Object.freeze(['notch', 'edgeDock', 'home', 'page']);
const TYPES = Object.freeze({ html: 'text/html', css: 'text/css', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', woff2: 'font/woff2' });
function assetPath(value) {
  return typeof value === 'string' && value.length <= 120 && value.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part) && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) && Object.hasOwn(TYPES, value.split('.').at(-1));
}
function normalizeWebUi(raw, permissions, errors, views = []) {
  if (raw === undefined) return null;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.assets) || raw.assets.length > 64 || !Array.isArray(raw.documents) || raw.documents.length > 8) { errors.push('webUi needs version 1, at most 64 assets and 8 documents'); return null; }
  const initialErrors = errors.length;
  const assets = [...new Set(raw.assets)];
  if (!assets.every(assetPath) || new Set(assets.map(p => p.toLowerCase())).size !== assets.length) { errors.push('webUi assets must be unique portable local paths'); return null; }
  if (!permissions.includes('ui.web')) errors.push('webUi requires ui.web permission');
  const documents = [], ids = new Set();
  for (const doc of raw.documents) {
    if (!doc || !/^[a-z][a-z0-9-]{0,31}$/.test(doc.id) || ids.has(doc.id) || !assets.includes(doc.entry) || !doc.entry.endsWith('.html') || ![...TARGETS, ...SURFACES, 'settings'].includes(doc.target) || !['before', 'after', 'replace'].includes(doc.slot)) { errors.push('invalid webUi document id, entry, target or slot'); continue; }
    if (TARGETS.includes(doc.target) && !permissions.includes('tm.pages')) errors.push('original page documents require tm.pages permission');
    const surface = SURFACES.includes(doc.target);
    if (doc.target === 'settings' && (doc.slot !== 'replace' || doc.view !== undefined || doc.variant && doc.variant !== 'full' || documents.some(other => other.target === 'settings'))) errors.push('settings document must be unique, view-independent and use replace/full');
    const variant = doc.variant || 'full';
    if (surface && (doc.slot !== 'replace' || !views.some(view => view.id === doc.view && view.surfaces.includes(doc.target)) || !['full', 'compact'].includes(variant) || (doc.target !== 'edgeDock' && variant !== 'full') || documents.some(other => other.target === doc.target && other.view === doc.view && other.variant === variant))) errors.push('surface document needs a unique declared view/variant and replace slot');
    if (doc.retainMs !== undefined && doc.retainMs !== 'until-evicted' && (!Number.isSafeInteger(doc.retainMs) || doc.retainMs < 0)) errors.push('webUi retainMs must be a nonnegative safe integer or until-evicted');
    ids.add(doc.id);
    documents.push(Object.freeze({ id: doc.id, ...(doc.retainMs !== undefined ? { retainMs: doc.retainMs } : {}), ...(surface ? { view: doc.view, variant } : {}), entry: doc.entry, target: doc.target, slot: doc.slot, height: Math.max(surface ? 40 : 120, Math.min(surface ? 600 : 800, Number(doc.height) || 320)), title: String(doc.title || doc.id).slice(0, 80) }));
  }
  if (errors.length !== initialErrors) return null;
  return Object.freeze({ version: 1, assets: Object.freeze(assets), documents: Object.freeze(documents) });
}
function pageSnapshot(raw) {
  const number = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  return { version: 1, target: TARGETS.includes(raw?.target) ? raw.target : null, period: String(raw?.period || '').slice(0, 32),
    totalTokens: number(raw?.totalTokens), costUsd: number(raw?.costUsd),
    rows: (Array.isArray(raw?.rows) ? raw.rows : []).slice(0, 500).map((row, index) => ({ key: String(index), label: String(row.label || '').slice(0, 160), tokens: number(row.tokens), costUsd: number(row.costUsd) })) };
}
module.exports = { TARGETS, SURFACES, TYPES, assetPath, normalizeWebUi, pageSnapshot };
