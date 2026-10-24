'use strict';

// Plugin manifest validation. The manifest is the whole contract between a
// plugin and the host: what it reads, where it may send data, which metrics
// its sandboxed code may publish, and what it draws where. Everything is
// normalised here once, in main, so later code never re-checks raw input.

const { normalizeSettings } = require('./settings');
const { normalizeIdentityIcon } = require('./identityIcon');
const { normalizeAppearance } = require('./appearance');
const { normalizeLocalized, cleanText } = require('./localized');
const { PERMISSIONS, PERMISSION_IDS, normalizeHostPattern, sourcePermission } = require('./permissions');
const { normalizeView, normalizeBinding, isBinding } = require('./viewSpec');

const { normalizeWebUi } = require('./webUi');
const API_MAJOR = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,32})?$/;
const METRIC_ID_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;
const MAIN_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,120}\.js$/;
const METRIC_KINDS = Object.freeze(['number', 'text', 'series', 'draw', 'rows', 'object']);
const ALERT_OPS = Object.freeze(['>', '>=', '<', '<=']);
const SKIN_COLOR_KEYS = Object.freeze(['accent', 'chart', 'bg', 'text', 'muted']);
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

const MAX = Object.freeze({ views: 16, metrics: 32, alerts: 8, skins: 8, hosts: 16 });

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function intIn(value, min, max, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
  return number === null ? fallback : Math.max(min, Math.min(max, number));
}

// "^1", "1", "1.x" and 1 all mean API major 1. Anything else is a plugin
// written for a host that does not exist yet (or never did).
function apiMajor(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const match = /^\^?(\d+)(?:\.(?:\d+|x))*$/.exec(String(value || '').trim());
  return match ? Number(match[1]) : null;
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString().slice(0, 300) : '';
  } catch {
    return '';
  }
}

function normalizeMetrics(raw, errors) {
  const metrics = [];
  const seen = new Set();
  for (const entry of (Array.isArray(raw) ? raw : []).slice(0, MAX.metrics)) {
    if (!isObject(entry) || !METRIC_ID_RE.test(String(entry.id || ''))) {
      errors.push(`metrics: invalid metric id "${entry?.id}"`);
      continue;
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const kind = METRIC_KINDS.includes(entry.kind) ? entry.kind : null;
    if (!kind) {
      errors.push(`metrics.${entry.id}: kind must be one of ${METRIC_KINDS.join(', ')}`);
      continue;
    }
    metrics.push(Object.freeze({
      id: entry.id,
      kind,
      label: normalizeLocalized(entry.label, 48),
      unit: normalizeLocalized(entry.unit, 16)
    }));
  }
  return metrics;
}

function normalizeAlerts(raw, ctx, errors) {
  const alerts = [];
  const seen = new Set();
  for (const entry of (Array.isArray(raw) ? raw : []).slice(0, MAX.alerts)) {
    const id = String(entry?.id || '');
    const path = `alerts.${id || '?'}`;
    if (!isObject(entry) || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || seen.has(id)) {
      errors.push(`${path}: invalid or duplicate alert id`);
      continue;
    }
    const title = normalizeLocalized(entry.title, 64);
    const message = normalizeLocalized(entry.message, 200);
    const threshold = typeof entry.value === 'number' && Number.isFinite(entry.value) ? entry.value : null;
    if (!title || !message || threshold === null || !ALERT_OPS.includes(entry.op) || !isBinding(entry.source)) {
      errors.push(`${path}: needs title, message, source, op and a numeric value`);
      continue;
    }
    const local = { metrics: ctx.metrics, sources: new Set() };
    const source = normalizeBinding(entry.source, local, `${path}.source`, errors);
    if (!source || source.history) {
      errors.push(`${path}: source must be a single numeric binding`);
      continue;
    }
    seen.add(id);
    alerts.push(Object.freeze({
      id,
      title,
      message,
      source,
      op: entry.op,
      value: threshold,
      forMs: intIn(entry.forSeconds, 0, 3600, 0) * 1000,
      cooldownMs: intIn(entry.cooldownMinutes, 1, 1440, 30) * 60 * 1000,
      sources: Object.freeze([...local.sources])
    }));
  }
  return alerts;
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

function uncoveredSources(sources, permissions) {
  return [...sources].filter((source) => !source.startsWith('@'))
    .filter((source) => {
      const permission = sourcePermission(source);
      return !permission || !permissions.includes(permission);
    });
}

// Returns { ok, manifest, errors }. `errors` lists everything that was
// rejected; ok=false means the plugin cannot load at all.
function normalizeManifest(raw, { source = 'user' } = {}) {
  const errors = [];
  if (!isObject(raw)) return { ok: false, manifest: null, errors: ['manifest must be a JSON object'] };
  const id = String(raw.id || '');
  if (!ID_RE.test(id)) errors.push('id must be 2–40 lowercase letters, digits or dashes');
  const version = String(raw.version || '');
  if (!VERSION_RE.test(version)) errors.push('version must be semver (1.2.3)');
  const major = apiMajor(raw.tmApi);
  if (major !== API_MAJOR) errors.push(`tmApi ${JSON.stringify(raw.tmApi)} is not supported (this host speaks ^${API_MAJOR})`);
  const name = normalizeLocalized(raw.name, 48);
  if (!name) errors.push('name is required');
  if (errors.length) return { ok: false, manifest: null, errors };

  const main = raw.main === undefined ? null : String(raw.main);
  if (main !== null && !MAIN_RE.test(main)) {
    return { ok: false, manifest: null, errors: ['main must be a relative .js path inside the plugin folder'] };
  }

  const permissions = [];
  for (const permission of Array.isArray(raw.permissions) ? raw.permissions : []) {
    if (!PERMISSION_IDS.includes(permission)) errors.push(`permissions: unknown permission "${permission}"`);
    else if (!permissions.includes(permission)) permissions.push(permission);
  }
  const hosts = [];
  for (const host of (Array.isArray(raw.network?.hosts) ? raw.network.hosts : []).slice(0, MAX.hosts)) {
    const pattern = normalizeHostPattern(host);
    if (!pattern) errors.push(`network.hosts: "${host}" is not a hostname`);
    else if (!hosts.includes(pattern)) hosts.push(pattern);
  }
  if (permissions.includes('network') && (!main || !hosts.length)) {
    errors.push('network needs main code and at least one network.hosts entry');
    permissions.splice(permissions.indexOf('network'), 1);
    hosts.length = 0;
  }
  if (!permissions.includes('network')) hosts.length = 0;

  const metrics = main ? normalizeMetrics(raw.metrics, errors) : [];
  if (!main && Array.isArray(raw.metrics) && raw.metrics.length) errors.push('metrics are published by main code; this plugin has none');
  const ctx = { metrics: new Set(metrics.map((metric) => metric.id)), interactive: Boolean(main) };

  const views = [];
  const viewIds = new Set();
  for (const entry of (Array.isArray(raw.views) ? raw.views : []).slice(0, MAX.views)) {
    const view = normalizeView(entry, ctx, errors);
    if (!view || viewIds.has(view.id)) continue;
    const missing = uncoveredSources(view.sources, permissions);
    if (missing.length) {
      errors.push(`views.${view.id}: reads ${missing.join(', ')} without the matching permission`);
      continue;
    }
    viewIds.add(view.id);
    views.push(view);
  }

  const alerts = normalizeAlerts(raw.alerts, ctx, errors).filter((alert) => {
    const missing = uncoveredSources(alert.sources, permissions);
    if (missing.length) errors.push(`alerts.${alert.id}: reads ${missing.join(', ')} without the matching permission`);
    return missing.length === 0;
  });
  if (alerts.length && !permissions.includes('notify')) {
    errors.push('alerts need the notify permission');
    alerts.length = 0;
  }

  const skins = normalizeSkins(raw.skins, errors);
  const webUi = normalizeWebUi(raw.webUi, permissions, errors, views);
  const background = main && isObject(raw.background)
    ? Object.freeze({ intervalMs: intIn(raw.background.intervalSeconds, 5, 3600, 60) * 1000 }) : null;
  const visible = Object.freeze({ intervalMs: intIn(raw.visible?.intervalSeconds, 1, 60, 2) * 1000 });

  if (!views.length && !skins.length && !alerts.length && !main && !webUi?.documents.length) {
    errors.push('a plugin must contribute at least one view, skin, alert or main code');
    return { ok: false, manifest: null, errors };
  }

  let settings;
  try { settings = normalizeSettings(raw.settings); } catch (error) { return { ok: false, manifest: null, errors: [...errors, error.message] }; }
  let identityIcon;
  try { identityIcon = normalizeIdentityIcon(raw.identityIcon); } catch (error) { return { ok: false, manifest: null, errors: [...errors, error.message] }; }
  return {
    ok: true,
    errors,
    manifest: Object.freeze({
      id,
      version,
      apiMajor: major,
      source: source === 'builtin' ? 'builtin' : 'user',
      name,
      identityIcon,
      settings,
      description: normalizeLocalized(raw.description, 240),
      author: cleanText(raw.author, 80),
      homepage: httpsUrl(raw.homepage),
      main,
      permissions: Object.freeze(permissions.sort()),
      network: Object.freeze({ hosts: Object.freeze(hosts.sort()) }),
      metrics: Object.freeze(metrics),
      views: Object.freeze(views),
      alerts: Object.freeze(alerts),
      skins: Object.freeze(skins),
      webUi,
      visible,
      background
    })
  };
}

module.exports = {
  API_MAJOR,
  ID_RE,
  METRIC_KINDS,
  PERMISSIONS,
  SKIN_COLOR_KEYS,
  apiMajor,
  normalizeManifest
};
