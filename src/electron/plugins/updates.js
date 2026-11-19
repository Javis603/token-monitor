'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const { atomicJson } = require('./managed');
const { ID_RE, readBounded } = require('./package');

// Preferences are host-owned, separate from publisher-controlled catalogs.
function createPluginUpdates({ root, catalog, manager, managed, enabled = () => true, apply, log = () => {} }) {
  const file = path.join(root, 'updates.json');
  let preferences = { enabled: true, plugins: {} }, error = '', pending = null;
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(readBounded(file, 16384));
      if (typeof data?.enabled !== 'boolean' || !data.plugins || typeof data.plugins !== 'object' || Array.isArray(data.plugins)
        || Object.keys(data.plugins).length > 64 || Object.entries(data.plugins).some(([id, value]) => !ID_RE.test(id) || typeof value !== 'boolean')) throw Error('Invalid plugin update preferences');
      preferences = { enabled: data.enabled, plugins: data.plugins };
    }
  } catch (cause) { error = cause.message; preferences.enabled = false; }
  function allowed(entry) {
    const plugin = manager.list().plugins.find(plugin => plugin.id === entry.id);
    const source = catalog.list().sources.find(source => source.id === entry.origin.id);
    return !error && enabled() && preferences.enabled && entry.status === 'update' && !semver.prerelease(entry.version)
      && (entry.origin.kind === 'official' || entry.origin.kind === 'maintainer') && source && !source.error
      && preferences.plugins[entry.id] !== false && plugin?.trusted === true
      && managed.describe(entry.id)?.origin.id === entry.origin.id;
  }
  return {
    list: () => ({ ...preferences, plugins: { ...preferences.plugins }, error }),
    configure(id, value) {
      if (error) throw Error(error);
      if (typeof value !== 'boolean' || id !== null && (typeof id !== 'string' || !ID_RE.test(id) || !managed.describe(id))) throw Error('Invalid plugin update preference');
      const retained = Object.fromEntries(Object.entries(preferences.plugins).filter(([key]) => managed.describe(key)));
      const next = id === null ? { ...preferences, enabled: value } : { ...preferences, plugins: { ...retained, [id]: value } };
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      atomicJson(file, next, 16384); preferences = next;
    },
    async run() {
      if (pending) return pending;
      pending = (async () => {
        for (const entry of catalog.list().entries) {
          if (!allowed(entry)) continue;
          let preview;
          try {
            preview = await catalog.preview(entry.origin.id, entry.id, entry.version);
            // New first-use choices require an explicit review. Never apply
            // publisher defaults during an unattended update.
            if (preview.operation !== 'update' || preview.initialSetup?.fields.length) continue;
            const check = () => { if (!allowed(entry)) throw Error('Automatic plugin update deferred'); };
            check();
            await apply(preview, check);
          } catch (cause) { log(`[plugins] Update deferred for ${entry.id}: ${cause.message}`); }
          finally { if (preview) managed.cancel(preview.token); }
        }
      })();
      try { await pending; } finally { pending = null; }
    }
  };
}
module.exports = { createPluginUpdates };
