'use strict';
const { openrouterProfileName, openrouterToken } = require('../../shared/providers/openrouter/limits');

// Compatibility bridge for the old preload API. Storage and refresh ownership
// belong to the serialized slot service; names are only a lookup for old callers.
function createOpenRouterProfileCommands(service, env = process.env) {
  const accounts = () => service.list('openrouter').accounts.filter(item => !item.source);
  const find = name => accounts().find(item => item.label === String(name || '').trim());
  const missing = () => ({ ok: false, error: 'Profile not found' });
  return {
    getProfiles: () => ({ profiles: Object.fromEntries(accounts().map(item => [item.label, { apiKey: 'set', enabled: item.enabled }])), hasEnvVar: Boolean(openrouterToken(env)) }),
    async saveProfile(rawName, rawApiKey) {
      const name = openrouterProfileName(rawName);
      const apiKey = openrouterToken({}, rawApiKey);
      if (!name) return { ok: false, errorCode: 'invalidName' };
      if (!apiKey) return { ok: false, errorCode: 'missingApiKey' };
      const old = find(name);
      const result = old ? await service.replace('openrouter', old.id, { openrouterApiKey: apiKey })
        : await service.add('openrouter', { openrouterApiKey: apiKey }, name);
      if (result.saved && old?.enabled === false) await service.setEnabled('openrouter', old.id, true);
      return { ok: Boolean(result.saved), ...(!result.saved ? { errorCode: result.errorCode || result.verdict } : {}) };
    },
    deleteProfile(name) { const item = find(name); return item ? service.remove('openrouter', item.id) : missing(); },
    renameProfile(oldName, rawName) {
      const name = openrouterProfileName(rawName);
      if (!name || name === oldName) return { ok: false, errorCode: 'invalidName' };
      if (find(name)) return { ok: false, error: 'Profile name already exists' };
      const item = find(oldName);
      return item ? service.rename('openrouter', item.id, name) : missing();
    },
    setProfileEnabled(name, enabled) { const item = find(name); return item ? service.setEnabled('openrouter', item.id, Boolean(enabled)) : missing(); }
  };
}
module.exports = { createOpenRouterProfileCommands };
