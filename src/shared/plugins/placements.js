'use strict';

// Where plugin views live in existing composers. A ref names one view of one
// plugin (`<pluginId>/<viewId>`); each surface stores refs in its own setting,
// so the existing ordering UI, drag sorting and hiding keep working. Stored
// refs survive a plugin being disabled or removed: the surface skips refs it
// cannot resolve, and reinstalling the plugin restores the placement.
(function exposePluginPlacements(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginPlacements = api;
})(typeof window !== 'undefined' ? window : null, function createPluginPlacementsApi() {
  const REF_RE = /^[a-z0-9][a-z0-9-]{1,39}\/[a-z][a-z0-9-]{0,31}$/;
  const HOME_PREFIX = 'plugin:';
  // Storage bound: 64 plugins × 16 views. Visible capacity is geometry-driven.
  const MAX_NOTCH_PAGES = 1024;
  const NOTCH_BUILTIN_PAGES = Object.freeze(['home', 'limits', 'sessions', 'breakdown']);

  function normalizeNotchBuiltinPages(value) {
    return Array.isArray(value) ? NOTCH_BUILTIN_PAGES.filter(page => value.includes(page)) : [...NOTCH_BUILTIN_PAGES];
  }

  // Ordering is separate from visibility so hiding/disabling a page retains its slot.
  function normalizeNotchPageOrder(value) {
    const out = [], seen = new Set();
    for (const raw of Array.isArray(value) ? value : []) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim().toLowerCase();
      if ((!NOTCH_BUILTIN_PAGES.includes(id) && !(id.startsWith(HOME_PREFIX) && isRef(id.slice(HOME_PREFIX.length)))) || seen.has(id)) continue;
      out.push(id); seen.add(id);
      if (out.length >= MAX_NOTCH_PAGES + NOTCH_BUILTIN_PAGES.length) break;
    }
    return out;
  }

  function orderNotchPages(available, value) {
    const ids = new Set(available);
    const preferred = normalizeNotchPageOrder(value).filter(id => ids.has(id));
    const seen = new Set(preferred);
    return [...preferred, ...available.filter(id => !seen.has(id))];
  }

  function mergeNotchPageOrder(previous, displayed) {
    const desired = normalizeNotchPageOrder(displayed), present = new Set(desired);
    let spare = MAX_NOTCH_PAGES + NOTCH_BUILTIN_PAGES.length - desired.length;
    const retained = normalizeNotchPageOrder(previous).filter(id => present.has(id) || spare-- > 0);
    let index = 0;
    return [...retained.map(id => present.has(id) ? desired[index++] : id), ...desired.slice(index)];
  }

  function isRef(value) {
    return typeof value === 'string' && REF_RE.test(value);
  }

  function pluginRef(pluginId, viewId) {
    const ref = `${pluginId}/${viewId}`;
    return isRef(ref) ? ref : '';
  }

  function parseRef(ref) {
    if (!isRef(ref)) return null;
    const [pluginId, viewId] = ref.split('/');
    return { pluginId, viewId };
  }

  function homeToken(ref) {
    return isRef(ref) ? `${HOME_PREFIX}${ref}` : '';
  }

  function refFromHomeToken(token) {
    const value = String(token || '').trim().toLowerCase();
    if (!value.startsWith(HOME_PREFIX)) return '';
    const ref = value.slice(HOME_PREFIX.length);
    return isRef(ref) ? ref : '';
  }

  function isHomeToken(token) {
    return Boolean(refFromHomeToken(token));
  }

  function normalizeRefList(value, max = 16) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    for (const entry of list) {
      const ref = String(entry || '').trim().toLowerCase();
      if (isRef(ref) && !out.includes(ref)) out.push(ref);
      if (out.length >= max) break;
    }
    return out;
  }

  function normalizeNotchPluginPages(value) {
    return normalizeRefList(value, MAX_NOTCH_PAGES);
  }

  function normalizeContentSelections(value) {
    return Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      .filter(([target, ref]) => /^[a-zA-Z][a-zA-Z0-9.-]{0,119}$/.test(target) && isRef(ref)).slice(0, 128));
  }

  function normalizeContentOrder(value) {
    return Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      .filter(([target]) => /^[a-zA-Z][a-zA-Z0-9.-]{0,119}$/.test(target)).slice(0, 128)
      .map(([target, refs]) => [target, normalizeRefList(refs, 256)]));
  }

  return {
    normalizeContentOrder,
    normalizeContentSelections,
    HOME_PREFIX,
    MAX_NOTCH_PAGES,
    NOTCH_BUILTIN_PAGES,
    normalizeNotchBuiltinPages,
    normalizeNotchPageOrder,
    orderNotchPages,
    mergeNotchPageOrder,
    homeToken,
    isHomeToken,
    isRef,
    normalizeNotchPluginPages,
    normalizeRefList,
    parseRef,
    pluginRef,
    refFromHomeToken
  };
});
