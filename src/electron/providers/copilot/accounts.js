'use strict';

const { randomUUID } = require('node:crypto');
const { hashKey } = require('../../../shared/hashKey');
const limits = require('../../../shared/providers/copilot/limits');
const { providerSelectionIncluding } = require('../../limits/credentialCommands');

function createCopilotAccounts({ getSettings, saveSettings, probeDeps, changed, env = process.env }) {
  let lane = Promise.resolve();
  const serialize = work => {
    const result = lane.then(work);
    lane = result.catch(() => {});
    return result;
  };
  function commit(profiles, legacyToken = getSettings().copilotApiToken, activate = false) {
    const settings = getSettings();
    const previous = { copilotProfiles: settings.copilotProfiles, copilotApiToken: settings.copilotApiToken,
      limitsEnabled: settings.limitsEnabled, limitProviders: settings.limitProviders };
    Object.assign(settings, { copilotProfiles: profiles, copilotApiToken: legacyToken,
      ...(activate ? { limitsEnabled: true, limitProviders: providerSelectionIncluding(settings.limitProviders, 'copilot') } : {}) });
    try { saveSettings({ throwOnError: true }); }
    catch (error) { Object.assign(settings, previous); throw error; }
    changed();
  }
  return {
    getAccounts() {
      return limits.configuredCopilotAccounts(getSettings(), { env }).map(({ id, accountKey, accountName, enabled }) =>
        ({ id, accountKey, accountName, enabled, external: id === 'environment' }));
    },
    addAccount(rawToken, isCurrent = () => true) {
      return serialize(async () => {
        const token = limits.copilotToken({}, { copilotApiToken: rawToken });
        if (!token) throw new Error('A GitHub Copilot token is required.');
        const settings = getSettings();
        const enterpriseHost = limits.normalizedEnterpriseHost(settings.copilotEnterpriseHost
          || env.COPILOT_ENTERPRISE_HOST || env.GITHUB_ENTERPRISE_HOST);
        const deps = { ...probeDeps(), copilotEnterpriseHost: enterpriseHost };
        const identity = await limits.fetchGitHubIdentity(token, deps);
        const row = await limits.fetchCopilotAccountLimits({ copilotApiToken: token, copilotEnterpriseHost: enterpriseHost }, deps);
        if (row.status === 'unauthorized') throw new Error('The token does not have GitHub Copilot access.');
        const legacyToken = limits.copilotToken({}, getSettings());
        let legacyIdentity;
        if (legacyToken && legacyToken !== token) {
          legacyIdentity = await limits.fetchGitHubIdentity(legacyToken, deps).catch(() => null);
        }
        if (!isCurrent()) throw new Error('GitHub Copilot sign-in was cancelled.');
        if (enterpriseHost !== limits.normalizedEnterpriseHost(getSettings().copilotEnterpriseHost
          || env.COPILOT_ENTERPRISE_HOST || env.GITHUB_ENTERPRISE_HOST)) throw new Error('GitHub host changed. Please try again.');
        const accountKey = hashKey('copilot', identity.login || String(identity.id));
        const profiles = limits.copilotProfiles(getSettings(), env);
        if (legacyIdentity) {
          for (const profile of Object.values(profiles)) {
            if (profile.token !== legacyToken) continue;
            profile.accountKey = hashKey('copilot', legacyIdentity.login || String(legacyIdentity.id));
            profile.accountName = legacyIdentity.login;
          }
        }
        const id = Object.keys(profiles).find(id => profiles[id].accountKey === accountKey || profiles[id].token === token) || randomUUID();
        const replacingLegacy = profiles[id]?.token === legacyToken;
        profiles[id] = { token, enterpriseHost, accountKey, accountName: identity.login, enabled: true };
        commit(profiles, replacingLegacy ? token : getSettings().copilotApiToken, true);
        return { ok: true };
      });
    },
    setEnabled(id, enabled) {
      return serialize(() => {
        if (typeof enabled !== 'boolean') throw new Error('Invalid account state.');
        const profiles = limits.copilotProfiles(getSettings(), env);
        if (!Object.hasOwn(profiles, id)) throw new Error('Account not found.');
        profiles[id].enabled = enabled;
        commit(profiles);
        return { ok: true };
      });
    },
    removeAccount(id) {
      return serialize(() => {
        const profiles = limits.copilotProfiles(getSettings(), env);
        if (!Object.hasOwn(profiles, id)) throw new Error('Account not found.');
        const token = profiles[id].token;
        delete profiles[id];
        commit(profiles, limits.copilotToken({}, getSettings()) === token ? '' : getSettings().copilotApiToken);
        return { ok: true };
      });
    }
  };
}

module.exports = { createCopilotAccounts };
