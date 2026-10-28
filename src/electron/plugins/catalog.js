'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const { randomUUID } = require('node:crypto');
const { renderReadme } = require('./catalogReadme');
const { imageBudget } = require('./catalogImagePolicy');
const { parsePackage, readBounded, MAX_PACKAGE_BYTES, describePackage, digest } = require('./package');
const { assertHostCompatibility } = require('./contracts');
const { localize } = require('../../shared/plugins/localized');
const { createCatalogSources } = require('./catalogSources');
const OFFICIAL = Object.freeze({ id: 'bundled', kind: 'official', label: 'Token Monitor' });
const { createGitHubDiscovery } = require('./githubDiscovery');
const { createCatalogMedia } = require('./catalogMedia');
const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;
function createPluginCatalog({ nativeImage, manager, managed, getLocale = () => 'en', root, fetchImpl, catalogDirectory = path.join(__dirname, 'catalog'), githubDiscoveryEnabled = false, maintainerSources = [], now = Date.now }) {
  const sources = createCatalogSources({ root, fetchImpl, getLocale, maintainerSources, now, cancelPreviews: id => managed.cancelSource(id) });
  const github = createGitHubDiscovery({ root, fetchImpl, enabled: githubDiscoveryEnabled });
  const media = createCatalogMedia({ fetchImpl, nativeImage });
  let readmeDocument = null, detailRevision = 0, discoveryPending = null, lastAttempt = null;
  const packages = new Map(), errors = [];
  // Only App-distributed files receive official attribution. Discovery never
  // executes them, and a broken entry must not disable package management.
  try {
    for (const name of fs.readdirSync(catalogDirectory).filter(name => name.endsWith('.tmplugin')).sort()) {
      try {
        const pkg = parsePackage(readBounded(path.join(catalogDirectory, name), MAX_PACKAGE_BYTES), { checkCompatibility: false });
        if (packages.has(pkg.manifest.id)) throw new Error('duplicate bundled catalog identity');
        let compatible = true;
        try { assertHostCompatibility(pkg.rawManifest); } catch { compatible = false; }
        packages.set(pkg.manifest.id, { pkg, compatible });
      } catch (error) { errors.push(`${name}: ${error.message}`); }
    }
  } catch (error) { errors.push(`Official catalog unavailable: ${error.message}`); }
  function list() {
    const plugins = manager.list().plugins;
    function installation(id) {
      const discovered = plugins.find(plugin => plugin.id === id);
      const record = managed.describe(id);
      // Invalid discovery records omit their manifest/version. The managed
      // baseline still identifies the version that a recovery update replaces.
      return { exists: Boolean(discovered || record), record,
        version: semver.valid(record?.version) || semver.valid(discovered?.version) || null };
    }
    const entries = [];
    for (const { pkg, compatible } of packages.values()) {
      const installed = installation(pkg.manifest.id);
      const homepage = pkg.manifest.homepage;
      entries.push({ ...describePackage(pkg, { locale: getLocale() }), origin: OFFICIAL,
        repository: /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(homepage) ? homepage : '',
        status: !compatible ? 'incompatible' : !installed.exists ? 'available'
          : installed.version && installed.record?.origin.id === OFFICIAL.id && semver.gt(pkg.manifest.version, installed.version) ? 'update' : 'installed',
        installedVersion: installed.version });
    }
    for (const entry of sources.entries()) {
      const installed = installation(entry.id);
      const compatible = entry.versions.filter(v => v.compatible);
      const chosen = compatible.find(v => !semver.prerelease(v.version)) || compatible[0] || entry.versions[0];
      entries.push({ id: entry.id, name: localize(entry.name, getLocale()), description: localize(entry.description, getLocale()), author: entry.author, identityIcon: entry.identityIcon,
        repository: entry.repository, readmePaths: entry.readmePaths, types: chosen.types, origin: entry.origin, version: chosen.version, installedVersion: installed.version,
        status: !chosen.compatible ? 'incompatible' : !installed.exists ? 'available' : installed.version && installed.record?.origin.id === entry.origin.id && semver.gt(chosen.version, installed.version) ? 'update' : 'installed',
        versions: entry.versions.map(v => ({ ...v, installable: v.compatible && (!installed.exists || Boolean(installed.version && installed.record?.origin.id === entry.origin.id && semver.gt(v.version, installed.version))), changelog: localize(v.changelog, getLocale()) })) });
    }
    const state = sources.list();
    return { sources: [OFFICIAL, ...state.sources], entries, github: github.list(), error: [...errors, state.error].filter(Boolean).join('\n'), communityConfigured: state.sources.length > 0 };
  }
  function closeDetails() {
    detailRevision++; readmeDocument?.controller.abort(); readmeDocument?.loads.clear(); readmeDocument = null;
  }
  return {
    list,
    closeDetails,
    async discover(force = false) {
      if (discoveryPending) return discoveryPending;
      if (!force && lastAttempt !== null && now() - lastAttempt < 300000) return list();
      lastAttempt = now();
      discoveryPending = (async () => {
        await Promise.all([github.refresh(force), ...sources.list().sources
          .filter(s => s.kind === 'maintainer' && (force || !s.cached || now() - s.lastFetched >= CATALOG_REFRESH_MS)).map(s => sources.refresh(s.id))]);
        return list();
      })();
      try { return await discoveryPending; } finally { discoveryPending = null; }
    },
    async details(sourceId, id) {
      closeDetails();
      const revision = detailRevision;
      const document = { id: randomUUID(), controller: new AbortController(), budget: imageBudget(), loads: new Map() };
      readmeDocument = document;
      let repository, filePath = '';
      if (sourceId !== 'github-discovery') {
        const entry = list().entries.find(p => p.id === id && p.origin.id === sourceId);
        if (!entry) throw new Error('Unknown catalog entry');
        repository = entry.repository;
        filePath = localize(entry.readmePaths, getLocale());
        if (!repository) return { html: '', imageCount: 0 };
      }
      const result = repository ? await github.repositoryReadme(repository, document.controller.signal, filePath) : await github.readme(id, document.controller.signal);
      if (revision !== detailRevision) throw new Error('README details are no longer current');
      Object.assign(document, renderReadme(result.readme, result.baseUrl, result.imageBaseUrl), { baseUrl: result.imageBaseUrl });
      return { html: document.html, documentId: document.id, imageCount: document.images.length };
    },
    async readmeImage(documentId, index) {
      const document = readmeDocument;
      if (!document || document.id !== documentId || !Number.isInteger(index) || index < 0 || !document.images?.[index]) throw new Error('Unknown README image');
      if (!document.loads.has(index)) document.loads.set(index, media.load(document.images[index], { baseUrl: document.baseUrl, signal: document.controller.signal, budget: document.budget }));
      return document.loads.get(index);
    },
    async addSource(input) { await sources.add(input); return list(); },
    async refreshSource(id) { await sources.refresh(id); return list(); },
    removeSource(id) { sources.remove(id); return list(); },
    dispose() { closeDetails(); sources.dispose(); github.dispose(); media.dispose(); },
    async preview(sourceId, id, version) {
      if (sourceId === OFFICIAL.id) {
        const entry = packages.get(id);
        if (!entry?.compatible || entry.pkg.manifest.version !== version) throw new Error('catalog version is missing or incompatible');
        return managed.preview(entry.pkg, OFFICIAL);
      }
        const entry = sources.entries().find(p => p.id === id && p.origin.id === sourceId);
        const selected = entry?.versions.find(v => v.version === version);
        if (!selected?.compatible) throw new Error('catalog version is missing or incompatible');
        const bytes = await sources.request(sourceId, selected.url, MAX_PACKAGE_BYTES);
        if (digest(bytes) !== selected.sha256) throw new Error('downloaded package SHA-256 does not match the selected catalog version');
        const pkg = parsePackage(bytes);
        if (pkg.manifest.id !== id || pkg.manifest.version !== selected.version) throw new Error('downloaded package identity does not match the selected catalog version');
        return managed.preview(pkg, { ...entry.origin, packageUrl: selected.url });
    }
  };
}
module.exports = { createPluginCatalog };
