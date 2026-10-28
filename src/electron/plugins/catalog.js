'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const { parsePackage, readBounded, MAX_PACKAGE_BYTES, describePackage, digest } = require('./package');
const { assertHostCompatibility } = require('./contracts');
const { localize } = require('../../shared/plugins/localized');
const { createCatalogSources } = require('./catalogSources');
const OFFICIAL = Object.freeze({ id: 'bundled', kind: 'official', label: 'Token Monitor' });
function createPluginCatalog({ manager, managed, getLocale = () => 'en', root, fetchImpl, catalogDirectory = path.join(__dirname, 'catalog') }) {
  const sources = createCatalogSources({ root, fetchImpl, getLocale, cancelPreviews: id => managed.cancelSource(id) });
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
      entries.push({ ...describePackage(pkg, { locale: getLocale() }), origin: OFFICIAL,
        status: !compatible ? 'incompatible' : !installed.exists ? 'available'
          : installed.version && installed.record?.origin.id === OFFICIAL.id && semver.gt(pkg.manifest.version, installed.version) ? 'update' : 'installed',
        installedVersion: installed.version });
    }
    for (const entry of sources.entries()) {
      const installed = installation(entry.id);
      const compatible = entry.versions.filter(v => v.compatible);
      const chosen = compatible.find(v => !semver.prerelease(v.version)) || compatible[0] || entry.versions[0];
      entries.push({ id: entry.id, name: localize(entry.name, getLocale()), description: localize(entry.description, getLocale()), author: entry.author, identityIcon: entry.identityIcon,
        types: chosen.types, origin: entry.origin, version: chosen.version, installedVersion: installed.version,
        status: !chosen.compatible ? 'incompatible' : !installed.exists ? 'available' : installed.version && installed.record?.origin.id === entry.origin.id && semver.gt(chosen.version, installed.version) ? 'update' : 'installed',
        versions: entry.versions.map(v => ({ ...v, installable: v.compatible && (!installed.exists || Boolean(installed.version && installed.record?.origin.id === entry.origin.id && semver.gt(v.version, installed.version))), changelog: localize(v.changelog, getLocale()) })) });
    }
    const state = sources.list();
    return { sources: [OFFICIAL, ...state.sources], entries, error: [...errors, state.error].filter(Boolean).join('\n'), communityConfigured: state.sources.length > 0 };
  }
  return {
    list,
    async addSource(input) { await sources.add(input); return list(); },
    async refreshSource(id) { await sources.refresh(id); return list(); },
    removeSource(id) { sources.remove(id); return list(); },
    dispose: () => sources.dispose(),
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
