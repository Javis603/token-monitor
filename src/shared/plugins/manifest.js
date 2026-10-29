'use strict';
const semver = require('semver');
const { normalizeSettings } = require('./settings');
const { normalizeIdentityIcon } = require('./identityIcon');
const { normalizeAppearance } = require('./appearance');
const { normalizeLocalized, cleanText } = require('./localized');
const API_MAJOR = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SURFACES = Object.freeze(['home', 'page', 'notch', 'edgeDock', 'tray', 'settings']);
const SKIN_COLOR_KEYS = Object.freeze(['accent', 'chart', 'bg', 'text', 'muted']);
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;
const MAX = { skins: 8 };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function apiMajor(value) { return Number.isInteger(value) ? value : null; }
function filePath(value) {
  return typeof value === 'string' && value.length <= 240 && value.split('/').every(part =>
    /^[a-zA-Z0-9_@.-]+$/.test(part) && part !== '.' && part !== '..' && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function normalizeSkins(raw, errors) {
  const skins = [];
  const seen = new Set();
  for (const entry of (Array.isArray(raw) ? raw : []).slice(0, MAX.skins)) {
    const id = String(entry?.id || '');
    if (!isObject(entry) || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || seen.has(id)) {
      errors.push(`skins.${id || '?'}: invalid or duplicate skin id`);
      continue;
    }
    const name = normalizeLocalized(entry.name, 40);
    const colors = {};
    for (const key of SKIN_COLOR_KEYS) {
      const value = entry.colors?.[key];
      if (typeof value === 'string' && HEX6_RE.test(value.trim())) colors[key] = value.trim().toLowerCase();
    }
    let appearance;
    if (entry.appearance !== undefined) { try { appearance = normalizeAppearance(entry.appearance); } catch (error) { errors.push(`skins.${id}: ${error.message}`); continue; } }
    if (!name || (!Object.keys(colors).length && !appearance)) {
      errors.push(`skins.${id}: needs a name and at least one #rrggbb colour`);
      continue;
    }
    const vendorColors = {};
    if (isObject(entry.vendorColors)) {
      for (const [vendor, value] of Object.entries(entry.vendorColors).slice(0, 64)) {
        if (/^[a-z0-9-]{1,32}$/.test(vendor) && typeof value === 'string' && HEX6_RE.test(value.trim())) {
          vendorColors[vendor] = value.trim().toLowerCase();
        }
      }
    }
    seen.add(id);
    skins.push(Object.freeze({ id, name, colors: Object.freeze(colors), vendorColors: Object.freeze(vendorColors), ...(appearance ? { appearance } : {}) }));
  }
  return skins;
}


// Experimental plugin API. Only the current manifest contract is accepted.
function normalizeManifest(raw, { source = 'user' } = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!isObject(raw)) return { ok: false, manifest: null, errors: ['manifest must be an object'] };
  if (raw.tmApi !== API_MAJOR) fail(`incompatible-plugin-api: this host requires tmApi ${API_MAJOR}`);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) fail('invalid plugin id');
  if (typeof raw.version !== 'string' || !semver.valid(raw.version)) fail('version must be semver');
  const name = normalizeLocalized(raw.name, 48);
  if (!name) fail('name is required');
  for (const key of ['main', 'permissions', 'network', 'metrics', 'alerts', 'webUi', 'visible']) if (raw[key] !== undefined) fail(`unsupported manifest field: ${key}`);
  const ui = raw.ui ?? null, backend = raw.backend ?? null;
  for (const [key, value] of [['ui', ui], ['backend', backend]]) if (value !== null && (!filePath(value) || !/\.(?:mjs|cjs|js)$/.test(value))) fail(`${key} must be a package-local JS file`);
  const files = Array.isArray(raw.files) ? raw.files : [];
  if (files.length > 4096 || files.some(name => !filePath(name) || name.toLowerCase() === 'manifest.json')) fail('invalid package files');
  if (new Set(files.map(name => String(name).toLowerCase())).size !== files.length) fail('duplicate package files');
  for (const entry of [ui, backend].filter(Boolean)) if (!files.includes(entry)) fail(`undeclared entry: ${entry}`);
  const css = raw.css ?? [];
  if (!Array.isArray(css) || css.some(name => !files.includes(name) || !name.endsWith('.css'))) fail('invalid css files');
  const seen = new Set();
  const views = [];
  if (raw.views !== undefined && !Array.isArray(raw.views)) fail('views must be an array');
  for (const view of Array.isArray(raw.views) ? raw.views : []) {
    if (!isObject(view) || typeof view.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(view.id) || seen.has(view.id)) { fail('invalid or duplicate view'); continue; }
    seen.add(view.id);
    if (!ui) fail('views require ui');
    const surfaces = Array.isArray(view.surfaces) ? [...new Set(view.surfaces)] : [];
    if (surfaces.some(surface => !SURFACES.includes(surface))) fail(`invalid surface: ${view.id}`);
    const defaultSurfaces = view.defaultSurfaces ?? [];
    if (!Array.isArray(defaultSurfaces) || new Set(defaultSurfaces).size !== defaultSurfaces.length || defaultSurfaces.some(surface => (!surfaces.includes(surface) || surface === 'settings'))) fail(`defaultSurfaces must be a subset of surfaces: ${view.id}`);
    const targets = Array.isArray(view.targets) ? [...new Set(view.targets)] : [];
    if (targets.some(target => typeof target !== 'string' || !/^[a-zA-Z][a-zA-Z0-9.-]{0,119}$/.test(target))) fail(`invalid content target: ${view.id}`);
    if (!surfaces.length && !targets.length) fail(`view needs surfaces or content targets: ${view.id}`);
    const mode = view.mode ?? 'append';
    if (!['append', 'replace', 'decorate'].includes(mode)) fail(`invalid view mode: ${view.id}`);
    const selector = view.selector ?? null;
    if (selector !== null && (typeof selector !== 'string' || !selector.trim() || selector.length > 500 || !targets.length)) fail(`invalid content selector: ${view.id}`);
    if (mode === 'replace' && targets.includes('main.navigation.content')) fail('core navigation cannot be replaced');
    views.push({ id: view.id, title: normalizeLocalized(view.title, 80) || name, surfaces, defaultSurfaces, targets, mode, selector,
      icon: typeof view.icon === 'string' ? view.icon.slice(0, 32) : 'dot' });
  }
  const trayMenu = [], menuIds = new Set();
  if (raw.trayMenu !== undefined && (!Array.isArray(raw.trayMenu) || raw.trayMenu.length > 32)) fail('trayMenu must contain at most 32 items');
  for (const item of Array.isArray(raw.trayMenu) ? raw.trayMenu : []) {
    const label = normalizeLocalized(item?.label, 80);
    if (!backend || !isObject(item) || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id) || menuIds.has(item.id) || !label) { fail('invalid Tray menu item or missing backend'); continue; }
    menuIds.add(item.id); trayMenu.push({ id: item.id, label });
  }
  let settings, identityIcon;
  try { settings = normalizeSettings(raw.settings); identityIcon = normalizeIdentityIcon(raw.identityIcon); } catch (error) { fail(error.message); }
  const skins = normalizeSkins(raw.skins, errors);
  if (!ui && !backend && !skins.length) fail('plugin must provide ui, backend or skins');
  if (raw.background !== undefined && typeof raw.background !== 'boolean') fail('background must be boolean');
  const initial = raw.defaults ?? {};
  if (!isObject(initial) || Object.keys(initial).some(key => !['content', 'background', 'skin'].includes(key))) fail('invalid plugin defaults');
  const content = {};
  const replacements = new Map();
  for (const view of views.filter(view => view.mode === 'replace')) for (const target of view.targets) {
    if (!replacements.has(target)) replacements.set(target, []);
    replacements.get(target).push(view.id);
  }
  if (initial.content !== undefined && !isObject(initial.content)) fail('defaults.content must be an object');
  for (const [target, ids] of replacements) content[target] = Object.hasOwn(initial.content || {}, target) ? initial.content[target] : ids[0];
  if (Object.entries(initial.content || {}).some(([target, id]) => !replacements.has(target) || id !== null && !replacements.get(target).includes(id))) fail('invalid defaults.content selection');
  if (initial.background !== undefined && (typeof initial.background !== 'boolean' || initial.background && (!backend || raw.background !== true))) fail('defaults.background requires background support');
  if (initial.skin !== undefined && initial.skin !== null && !skins.some(skin => skin.id === initial.skin)) fail('invalid defaults.skin selection');
  const defaults = Object.freeze({ content: Object.freeze(content), background: initial.background === true, skin: initial.skin ?? null });
  if (errors.length) return { ok: false, manifest: null, errors };
  return { ok: true, errors, manifest: Object.freeze({ id: raw.id, version: raw.version, apiMajor: API_MAJOR, source,
    name, description: normalizeLocalized(raw.description, 240), author: cleanText(raw.author, 80),
    homepage: typeof raw.homepage === 'string' && /^https:\/\//.test(raw.homepage) ? raw.homepage.slice(0, 300) : '',
    ui, backend, files: Object.freeze([...files]), css: Object.freeze([...css]), views: Object.freeze(views),
    skins: Object.freeze(skins), trayMenu: Object.freeze(trayMenu), settings, identityIcon, defaults, background: raw.background === true }) };
}
module.exports = { API_MAJOR, ID_RE, SURFACES, SKIN_COLOR_KEYS, apiMajor, filePath, normalizeManifest };
