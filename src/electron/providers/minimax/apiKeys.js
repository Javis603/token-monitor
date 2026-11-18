'use strict';

const { randomUUID } = require('node:crypto');
const limits = require('../../../shared/providers/minimax/limits');
const { hashKey } = require('../../../shared/hashKey');
const { createCredentialCommands, providerSelectionIncluding } = require('../../limits/credentialCommands');

function createMinimaxApiKeys({ getSettings, saveSettings, probeDeps, changed, slotPersistence, env = process.env }) {
  const profiles = () => limits.minimaxApiProfiles(getSettings());
  async function commit(next, key, reason, removedId) {
    const settings = getSettings();
    const before = new Set(limits.configuredMinimaxAccounts(settings, { env }).map(account => account.apiKey));
    const preferences = () => {
      const current = getSettings();
      if (reason === 'key-save') return { limitsEnabled: true, limitProviders: providerSelectionIncluding(current.limitProviders, 'minimax') };
      // The legacy field stays for downgrades until its own key is removed.
      return limits.minimaxToken({}, current.minimaxApiKey) === key ? { minimaxApiKey: '' } : {};
    };
    if (slotPersistence) {
      await slotPersistence.commit(Object.entries(next).map(([id, profile]) => ({ id,
        accountKey: hashKey('minimax', profile.apiKey), enabled: profile.enabled,
        billingMode: profile.billingMode, apiRegion: profile.apiRegion
      })), [...Object.entries(next).map(([id, profile]) => ({ id, credential: profile.apiKey })),
        ...(removedId ? [{ id: removedId, credential: null }] : [])], undefined, preferences);
    } else {
      const patch = { ...preferences(), minimaxApiProfiles: next };
      const previous = { ...settings };
      try {
        Object.assign(settings, patch);
        saveSettings({ throwOnError: true });
      } catch (error) {
        for (const key of Object.keys(patch)) {
          if (Object.hasOwn(previous, key)) settings[key] = previous[key];
          else delete settings[key];
        }
        throw error;
      }
    }
    const after = limits.configuredMinimaxAccounts(getSettings(), { env });
    for (const previous of before) {
      if (!after.some(account => account.apiKey === previous)) changed(hashKey('minimax', previous), false, reason);
    }
    for (const account of after) {
      if (account.apiKey === key || !before.has(account.apiKey)) changed(hashKey('minimax', account.apiKey), true, reason);
    }
  }
  const commands = createCredentialCommands({
    getSettings, env: {},
    probeDeps: () => ({ ...probeDeps(), probe: true, providerRuntimeState: new Map() }),
    commitCredential: async ({ candidate }) => {
      const next = profiles();
      const key = candidate.minimaxApiKey;
      const id = Object.keys(next).find(id => next[id].apiKey === key) || randomUUID();
      next[id] = { apiKey: key, enabled: true, billingMode: candidate.minimaxBillingMode, apiRegion: candidate.minimaxApiRegion };
      await commit(next, key, 'key-save');
    }
  });
  return {
    getKeys() {
      return Object.entries(profiles()).map(([id, profile]) => ({
        id, accountKey: hashKey('minimax', profile.apiKey), billingMode: profile.billingMode,
        apiRegion: limits.minimaxRegion({ minimaxApiRegion: profile.apiRegion }, env), enabled: profile.enabled !== false
      }));
    },
    async addKey(input = {}) {
      const apiRegion = input.apiRegion ?? 'auto';
      const result = await commands.saveCredential('minimax', {
        apiRegion, minimaxApiKey: input.apiKey, minimaxBillingMode: input.billingMode,
        minimaxApiRegion: limits.minimaxRegion({ minimaxApiRegion: apiRegion }, env)
      }, { includeIndependentSettings: true });
      return { ok: result.saved, status: result.status, errorCode: result.errorCode || result.verdict };
    },
    removeKey(id) {
      const next = profiles();
      if (!Object.hasOwn(next, id)) return { ok: false, error: 'API key not found' };
      commands.noteSettingsPatch({ minimaxApiKey: '' });
      const key = next[id].apiKey;
      delete next[id];
      const task = commit(next, key, 'key-remove', id);
      return slotPersistence ? task.then(() => ({ ok: true })) : { ok: true };
    },
    noteSettingsPatch(patch) {
      commands.noteSettingsPatch(Object.hasOwn(patch, 'minimaxApiProfiles') ? { minimaxApiKey: '' } : patch);
    }
  };
}

module.exports = { createMinimaxApiKeys };
