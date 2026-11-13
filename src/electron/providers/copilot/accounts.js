'use strict';

const { randomUUID } = require('node:crypto');
const limits = require('../../../shared/providers/copilot/limits');
const { providerSelectionIncluding } = require('../../limits/credentialCommands');

function createCopilotAccounts({ getSettings, saveSettings, probeDeps, changed, env = process.env }) {
  let lane = Promise.resolve();
  const serialize = work => {
    const result = lane.then(work);
    lane = result.catch(() => {});
    return result;
  };
  function commit(profiles, { legacyToken = getSettings().copilotApiToken, activate = false, accountKey = '', refresh = true } = {}) {
    const settings = getSettings();
    const previous = { copilotProfiles: settings.copilotProfiles, copilotApiToken: settings.copilotApiToken,
      limitsEnabled: settings.limitsEnabled, limitProviders: settings.limitProviders };
    Object.assign(settings, { copilotProfiles: profiles, copilotApiToken: legacyToken,
      ...(activate ? { limitsEnabled: true, limitProviders: providerSelectionIncluding(settings.limitProviders, 'copilot') } : {}) });
    try { saveSettings({ throwOnError: true }); }
    catch (error) { Object.assign(settings, previous); throw error; }
    changed(accountKey, refresh);
  }
  return {
    getAccounts() {
      return limits.configuredCopilotAccounts(getSettings(), { env }).map(({ id, accountKey, accountName, enabled }) =>
        ({ id, accountKey, accountName, enabled, external: id === 'environment' }));
    },
    addAccount(rawToken, isCurrent = () => true, signal) {
      return serialize(async () => {
        signal?.throwIfAborted();
        if (!isCurrent()) throw new Error('GitHub Copilot sign-in was cancelled.');
        const token = limits.copilotToken({}, { copilotApiToken: rawToken });
        if (!token) throw new Error('A GitHub Copilot token is required.');
        const settings = getSettings();
        const enterpriseHost = limits.normalizedEnterpriseHost(settings.copilotEnterpriseHost
          || env.COPILOT_ENTERPRISE_HOST || env.GITHUB_ENTERPRISE_HOST);
        const probe = probeDeps();
        const signals = [probe.signal, signal].filter(Boolean);
        const deps = { ...probe, copilotEnterpriseHost: enterpriseHost,
          signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] };
        const identity = await limits.fetchGitHubIdentity(token, deps);
        const row = await limits.fetchCopilotAccountLimits({ copilotApiToken: token, copilotEnterpriseHost: enterpriseHost }, deps);
        if (row.status === 'unauthorized') throw new Error('The token does not have GitHub Copilot access.');
        const legacyToken = limits.copilotToken({}, getSettings());
        const legacyProfile = Object.values(limits.copilotProfiles(getSettings(), env)).find(profile => profile.token === legacyToken);
        let legacyIdentity;
        if (legacyProfile && !legacyProfile.accountName && legacyToken !== token) {
          legacyIdentity = await limits.fetchGitHubIdentity(legacyToken, { ...deps, copilotEnterpriseHost: legacyProfile.enterpriseHost }).catch(() => null);
        }
        deps.signal?.throwIfAborted();
        if (!isCurrent()) throw new Error('GitHub Copilot sign-in was cancelled.');
        if (enterpriseHost !== limits.normalizedEnterpriseHost(getSettings().copilotEnterpriseHost
          || env.COPILOT_ENTERPRISE_HOST || env.GITHUB_ENTERPRISE_HOST)) throw new Error('GitHub host changed. Please try again.');
        const accountKey = limits.copilotAccountKey(identity.login || String(identity.id), enterpriseHost);
        const profiles = limits.copilotProfiles(getSettings(), env);
        if (legacyIdentity) {
          for (const profile of Object.values(profiles)) {
            if (profile.token !== legacyToken) continue;
            profile.accountKey = limits.copilotAccountKey(legacyIdentity.login || String(legacyIdentity.id), profile.enterpriseHost);
            profile.accountName = legacyIdentity.login;
          }
        }
        const id = Object.keys(profiles).find(id => profiles[id].accountKey === accountKey || (profiles[id].token === token && profiles[id].enterpriseHost === enterpriseHost)) || randomUUID();
        const replacingLegacy = profiles[id]?.token === legacyToken;
        profiles[id] = { token, enterpriseHost, accountKey, accountName: identity.login, enabled: profiles[id]?.enabled !== false };
        commit(profiles, { legacyToken: replacingLegacy ? token : getSettings().copilotApiToken, activate: true, accountKey, refresh: profiles[id].enabled });
        return { ok: true };
      });
    },
    setEnabled(id, enabled) {
      return serialize(async () => {
        if (typeof enabled !== 'boolean') throw new Error('Invalid account state.');
        const profiles = limits.copilotProfiles(getSettings(), env);
        if (!Object.hasOwn(profiles, id)) throw new Error('Account not found.');
        const profile = profiles[id];
        if (!profile.accountKey) {
          // Resolve before migrating a legacy checkbox; if offline, leave its
          // key unresolved so a later successful lookup keeps the old identity.
          const identity = await limits.fetchGitHubIdentity(profile.token, {
            ...probeDeps(), copilotEnterpriseHost: profile.enterpriseHost
          }).catch(() => null);
          if (identity) {
            profile.accountKey = limits.copilotAccountKey(identity.login || String(identity.id), profile.enterpriseHost);
            profile.accountName = identity.login;
          }
        }
        profile.enabled = enabled;
        commit(profiles, { accountKey: profile.accountKey, refresh: enabled });
        return { ok: true };
      });
    },
    removeAccount(id) {
      return serialize(() => {
        const profiles = limits.copilotProfiles(getSettings(), env);
        if (!Object.hasOwn(profiles, id)) throw new Error('Account not found.');
        const { token, accountKey } = profiles[id];
        delete profiles[id];
        commit(profiles, { legacyToken: limits.copilotToken({}, getSettings()) === token ? '' : getSettings().copilotApiToken, accountKey, refresh: false });
        return { ok: true };
      });
    }
  };
}

module.exports = { createCopilotAccounts };
