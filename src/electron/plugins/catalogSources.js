'use strict';
const { normalizeTypes } = require('./types');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const { normalizeIdentityIcon } = require('../../shared/plugins/identityIcon');
const { atomicJson } = require('./managed');
const { ID_RE, readBounded, digest } = require('./package');
const { normalizeLocalized, localize, cleanText } = require('../../shared/plugins/localized');
const MAX_INDEX_BYTES = 1024 * 1024;
const HOST_VERSION = require('../../../package.json').version;
function normalizeReadmePaths(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16) throw new Error('README paths must be a locale map');
  const paths = {};
  for (const [locale, file] of Object.entries(value)) {
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(locale) || typeof file !== 'string' || file.length > 240 ||
      !file.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..') || !/\.md$/.test(file)) throw new Error('invalid repository README path');
    paths[locale] = file;
  }
  if (!Object.keys(paths).length) throw new Error('README paths cannot be empty');
  return paths;
}
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('source must be an HTTPS URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('source must be HTTPS without credentials or a fragment');
  if (url.href.length > 2048) throw new Error('normalized HTTPS URL exceeds 2048 characters');
  return url.href;
}
function signingKey(pem) {
  if (typeof pem !== 'string' || pem.length > 1024) throw new Error('invalid public key');
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('signing key must be Ed25519');
  return { pem: key.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: digest(key.export({ type: 'spki', format: 'der' })) };
}
function parseIndex(bytes, publicKey) {
  if (bytes.length > MAX_INDEX_BYTES) throw new Error('catalog exceeds 1 MB');
  let raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (publicKey) {
    if (typeof raw?.payload !== 'string' || typeof raw.signature !== 'string') throw new Error('catalog signature is required for this pinned source');
    const payload = Buffer.from(raw.payload, 'base64');
    if (payload.length > MAX_INDEX_BYTES || !crypto.verify(null, payload, publicKey, Buffer.from(raw.signature, 'base64'))) throw new Error('catalog signature is invalid');
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  }
  if (raw?.format !== 1 || !Array.isArray(raw.plugins) || raw.plugins.length > 128) throw new Error('catalog needs format 1 and at most 128 plugins');
  const title = normalizeLocalized(raw.title, 80);
  if (!title) throw new Error('catalog title is required');
  const seen = new Set();
  const plugins = raw.plugins.map(entry => {
    if (!entry || typeof entry.id !== 'string' || !ID_RE.test(entry.id) || seen.has(entry.id)) throw new Error('invalid or duplicate catalog plugin id');
    seen.add(entry.id);
    const name = normalizeLocalized(entry.name, 80);
    if (!name || !Array.isArray(entry.versions) || !entry.versions.length || entry.versions.length > 32) throw new Error(`${entry.id}: name and 1–32 versions are required`);
    const repository = entry.repository === undefined ? '' : httpsUrl(entry.repository);
    if (repository && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repository)) throw new Error('repository must be a GitHub repository URL');
    const readmePaths = normalizeReadmePaths(entry.readmePaths);
    if (readmePaths && !repository) throw new Error('README paths require a repository');
    const versionsSeen = new Set();
    const versions = entry.versions.map(v => {
      if (typeof v?.version !== 'string' || !semver.valid(v.version) || versionsSeen.has(v.version)) throw new Error(`${entry.id}: invalid or duplicate version`);
      versionsSeen.add(v.version);
      if (typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)) throw new Error(`${entry.id}: SHA-256 is required`);
      const range = v.engines?.tokenMonitor;
      if (range !== undefined && (typeof range !== 'string' || !semver.validRange(range))) throw new Error(`${entry.id}: invalid compatibility range`);
      return { types: normalizeTypes(v.types), version: v.version, sha256: v.sha256, url: httpsUrl(v.url), compatible: !range || semver.satisfies(HOST_VERSION, range),
        changelog: normalizeLocalized(v.changelog, 2000), engines: range || '*' };
    }).sort((a, b) => semver.rcompare(a.version, b.version));
    return { id: entry.id, name, repository, readmePaths, description: normalizeLocalized(entry.description, 500), author: cleanText(entry.author, 100), identityIcon: normalizeIdentityIcon(entry.identityIcon), versions };
  });
  return { title, plugins };
}
async function download(fetchImpl, url, limit, signal, accept = 'application/json') {
  const response = await fetchImpl(httpsUrl(url), { redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
    headers: { Accept: accept } });
  if (!response.ok || response.status < 200 || response.status >= 300) throw new Error(`download failed (HTTP ${response.status}); redirects are not followed`);
  if (Number(response.headers?.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('download exceeds size limit'); }
  if (!response.body?.getReader) throw new Error('streaming download is unavailable');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('download exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { try { await reader.cancel(); } catch {} throw error; }
  return Buffer.concat(chunks);
}
function createCatalogSources({ root, fetchImpl, cancelPreviews = () => {}, getLocale = () => 'en', now = Date.now, maintainerSources = [] }) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const configFile = path.join(root, 'sources.json');
  const sources = new Map(), cache = new Map(), activeRefreshes = new Map(), activePackages = new Map();
  let loadError = '';
  function cacheFile(id) { return path.join(root, `${id}.json`); }
  function persist() { atomicJson(configFile, [...sources.values()].filter(s => !s.preset).map(({ id, url, publicKey, fingerprint }) => ({ id, url, publicKey, fingerprint }))); }
  function loadCache(source) {
    if (!fs.existsSync(cacheFile(source.id))) return;
    try {
      const saved = JSON.parse(readBounded(cacheFile(source.id), MAX_INDEX_BYTES * 2));
      if (saved.url !== source.url) throw new Error('cached source does not match');
      const index = parseIndex(Buffer.from(saved.bytes, 'base64'), source.publicKey);
      cache.set(source.id, index); source.lastFetched = saved.at;
    } catch (error) { source.error = `cached catalog unavailable: ${error.message}`; }
  }
  try {
    const raw = fs.existsSync(configFile) ? JSON.parse(readBounded(configFile, 64 * 1024)) : [];
    if (!Array.isArray(raw) || raw.length > 16) throw new Error('invalid catalog source configuration');
    for (const s of raw) {
      if (!/^custom-[a-f0-9-]{36}$/.test(s.id) || sources.has(s.id)) throw new Error('invalid catalog source id');
      const key = s.publicKey ? signingKey(s.publicKey) : null;
      const source = { id: s.id, url: httpsUrl(s.url), publicKey: key?.pem || '', fingerprint: key?.fingerprint || '', error: '', lastFetched: null };
      sources.set(s.id, source);
      loadCache(source);
    }
  } catch (error) { loadError = `catalog sources could not be loaded: ${error.message}`; sources.clear(); cache.clear(); }
  // Only the host constructor supplies these definitions. Persisted config,
  // index titles, manifest authors and add-source IPC cannot opt into this role.
  for (const s of maintainerSources) {
    if (!/^maintainer-[a-z0-9-]+$/.test(s.id) || sources.has(s.id)) throw new Error('invalid maintainer source id');
    const key = s.publicKey ? signingKey(s.publicKey) : null;
    const source = { id: s.id, url: httpsUrl(s.url), publicKey: key?.pem || '', fingerprint: key?.fingerprint || '', error: '', lastFetched: null, preset: true };
    sources.set(s.id, source); loadCache(source);
  }
  function requireWritable() { if (loadError) throw new Error(loadError); }
  function list() {
    return { error: loadError, sources: [...sources.values()].map(s => ({ id: s.id, kind: s.preset ? 'maintainer' : 'community', url: s.url,
      label: localize(cache.get(s.id)?.title, getLocale()) || new URL(s.url).hostname,
      fingerprint: s.fingerprint, signed: Boolean(s.publicKey && cache.has(s.id)), lastFetched: s.lastFetched,
      cached: cache.has(s.id), error: s.error, refreshing: activeRefreshes.has(s.id) })) };
  }
  async function request(id, url, limit, active) {
    const source = sources.get(id); if (!source) throw new Error('unknown catalog source');
    if (active.has(id)) throw new Error('this source already has a download in progress');
    const controller = new AbortController(); active.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 15_000); timer.unref?.();
    try {
      const bytes = await download(fetchImpl, url, limit, controller.signal);
      if (sources.get(id) !== source || controller.signal.aborted) throw new Error('catalog source was removed or download cancelled');
      return bytes;
    } finally { clearTimeout(timer); if (active.get(id) === controller) active.delete(id); }
  }
  async function refresh(id) {
    const s = sources.get(id);
    if (!s) { requireWritable(); throw new Error('unknown catalog source'); }
    if (!s.preset) requireWritable();
    try {
      const bytes = await request(id, s.url, MAX_INDEX_BYTES, activeRefreshes);
      const index = parseIndex(bytes, s.publicKey);
      atomicJson(cacheFile(id), { url: s.url, at: now(), bytes: bytes.toString('base64') });
      cache.set(id, index); s.lastFetched = now(); s.error = '';
    } catch (error) { s.error = cleanText(error.message, 300); }
    return list();
  }
  return {
    list, refresh,
    // Index refreshes and package previews may overlap. Keep each bounded to
    // one request per source, with independent deadlines and cancellation.
    request: (id, url, limit) => request(id, url, limit, activePackages),
    entries() { return [...sources.values()].flatMap(s => (cache.get(s.id)?.plugins || []).map(p => ({ ...p, origin: {
      id: s.id, kind: s.preset ? 'maintainer' : 'community', label: localize(cache.get(s.id).title, getLocale()), url: s.url, fingerprint: s.fingerprint,
      signed: Boolean(s.publicKey), cached: true, lastFetched: s.lastFetched, error: s.error } }))); },
    async add({ url, publicKey = '' } = {}) {
      requireWritable(); const normalized = httpsUrl(url);
      if ([...sources.values()].filter(s => !s.preset).length >= 16 || [...sources.values()].some(s => s.url === normalized)) throw new Error('source already exists or source limit reached');
      const key = publicKey ? signingKey(publicKey) : null;
      const source = { id: `custom-${crypto.randomUUID()}`, url: normalized, publicKey: key?.pem || '', fingerprint: key?.fingerprint || '', error: '', lastFetched: null };
      sources.set(source.id, source);
      try { persist(); } catch (error) { sources.delete(source.id); throw error; }
      return refresh(source.id);
    },
    remove(id) {
      requireWritable(); const source = sources.get(id); if (!source) throw new Error('unknown catalog source');
      if (source.preset) throw new Error('App-distributed catalog sources cannot be removed');
      sources.delete(id); try { persist(); } catch (error) { sources.set(id, source); throw error; }
      activeRefreshes.get(id)?.abort(); activePackages.get(id)?.abort(); cache.delete(id); cancelPreviews(id);
      fs.rmSync(cacheFile(id), { force: true }); return list();
    },
    dispose() { for (const active of [activeRefreshes, activePackages]) { for (const controller of active.values()) controller.abort(); active.clear(); } }
  };
}
module.exports = { MAX_INDEX_BYTES, httpsUrl, signingKey, parseIndex, download, createCatalogSources };
