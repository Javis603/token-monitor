'use strict';
const semver = require('semver');
const { parsePackage, MAX_PACKAGE_BYTES, digest } = require('./package');
const { localize } = require('../../shared/plugins/localized');
const { createCatalogSources } = require('./catalogSources');
function createPluginCatalog({ manager, managed, getLocale = () => 'en', root, fetchImpl }) {
  const sources = createCatalogSources({ root, fetchImpl, getLocale, cancelPreviews: id => managed.cancelSource(id) });
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
    return { sources: state.sources, entries, error: state.error, communityConfigured: state.sources.length > 0 };
  }
  return {
    list,
    async addSource(input) { await sources.add(input); return list(); },
    async refreshSource(id) { await sources.refresh(id); return list(); },
    removeSource(id) { sources.remove(id); return list(); },
    dispose: () => sources.dispose(),
    async preview(sourceId, id, version) {

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
