'use strict';

const thirdPartyLimits = require('../../../shared/providers/thirdparty/limits');
const { redactThirdPartyProfilesForRenderer } = require('../../limits/accountSettings');

/**
 * Owns thirdparty account workflows and process-local state.
 * @param {object} deps Provider-scoped persistence and named host IO capabilities.
 */
function createThirdpartyAccountService(deps) {
  const { getThirdPartyProfiles, setThirdPartyProfiles, saveSettings, electronProviderDeps, queueLimitInvalidation, env = process.env } = deps;
  function persistThirdPartyCredentialsRenewal(renewal = {}) {
    const accountName = String(renewal.accountName || '').trim();
    const adapter = thirdPartyLimits.normalizeAdapterId(renewal.adapter);
    const profiles = getThirdPartyProfiles() || {};
    const profile = profiles[accountName];
    if (!accountName || !profile || profile.adapter !== adapter) return false;
    const previousAccessToken = String(renewal.previous?.accessToken || '');
    const previousRefreshToken = String(renewal.previous?.refreshToken || '');
    if (
      String(profile.accessToken || '') !== previousAccessToken
      || String(profile.refreshToken || '') !== previousRefreshToken
    ) return false;
    const normalized = thirdPartyLimits.normalizeThirdPartyProfile({
      ...profile,
      accessToken: renewal.next?.accessToken,
      refreshToken: renewal.next?.refreshToken
    });
    if (!normalized) return false;
    setThirdPartyProfiles({
      ...profiles,
      [accountName]: { ...normalized, enabled: profile.enabled !== false }
    });
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      // Keep the rotated pair in memory so this process can recover on a later
      // settings write, but tell the caller not to present this renewal as durable.
      console.log(`[thirdparty] credential renewal persist failed: ${error?.message || error}`);
      return false;
    }
    return true;
  }

  function persistThirdPartyAccountKey(update = {}) {
    const accountName = String(update.accountName || '').trim();
    const adapter = thirdPartyLimits.normalizeAdapterId(update.adapter);
    const accountKey = thirdPartyLimits.normalizeCanonicalAccountKey(update.accountKey);
    const profiles = getThirdPartyProfiles() || {};
    const profile = profiles[accountName];
    if (
      !accountName
      || adapter !== thirdPartyLimits.SUB2API_ADAPTER
      || !accountKey
      || !profile
      || profile.adapter !== adapter
    ) return false;
    const baseUrl = thirdPartyLimits.normalizeThirdPartyBaseUrl(update.baseUrl);
    if (thirdPartyLimits.normalizeThirdPartyBaseUrl(profile.baseUrl) !== baseUrl) return false;
    if (
      String(profile.accessToken || '') !== String(update.previous?.accessToken || '')
      || String(profile.refreshToken || '') !== String(update.previous?.refreshToken || '')
    ) return false;
    if (thirdPartyLimits.normalizeCanonicalAccountKey(profile.canonicalAccountKey) === accountKey) {
      return true;
    }
    const normalized = thirdPartyLimits.normalizeThirdPartyProfile({
      ...profile,
      canonicalAccountKey: accountKey
    });
    if (!normalized) return false;
    setThirdPartyProfiles({
      ...profiles,
      [accountName]: { ...normalized, enabled: profile.enabled !== false }
    });
    try {
      saveSettings({ throwOnError: true });
    } catch (error) {
      console.log(`[thirdparty] account identity persist failed: ${error?.message || error}`);
      return false;
    }
    return true;
  }

  function thirdPartyProfileWithCanonicalIdentity(profile, provider) {
    return thirdPartyLimits.normalizeThirdPartyProfile({
      ...profile,
      canonicalAccountKey: provider?.accountKey
    });
  }

  function thirdPartySaveErrorCode(error) {
    if (error?.code === 'ACCESS_TOKEN_LEGACY_RETIRED') return 'newApiLegacyTokenRetired';
    if (error?.code === 'ACCESS_TOKEN_SCOPE_DENIED') return 'newApiScopeDenied';
    return error?.status === 'unauthorized' ? 'invalidCredential' : 'unavailable';
  }

  async function getProfiles() {
      const [environment] = thirdPartyLimits.configuredAccounts({}, { env });
      return {
        profiles: redactThirdPartyProfilesForRenderer(getThirdPartyProfiles() || {}),
        hasEnvVar: Boolean(environment),
        environmentAccountKey: environment ? thirdPartyLimits.thirdPartyAccountKey(environment.name, environment) : ''
      };
    }

  async function saveProfile(rawProfile = {}) {
      const name = thirdPartyLimits.thirdPartyProfileName(rawProfile.name);
      const adapter = thirdPartyLimits.normalizeAdapterId(rawProfile.adapter);
      const customAdapter = adapter === thirdPartyLimits.CUSTOM_BALANCE_ADAPTER;
      const baseUrl = thirdPartyLimits.normalizeThirdPartyBaseUrl(rawProfile.baseUrl, {
        stripTerminalV1: !customAdapter
      });
      if (!name) return { ok: false, errorCode: 'invalidName' };
      if (!adapter) return { ok: false, errorCode: 'invalidAdapter' };
      if (!baseUrl) return { ok: false, errorCode: 'invalidBaseUrl' };
      if (
        adapter === thirdPartyLimits.NEWAPI_ACCOUNT_ADAPTER
        && !thirdPartyLimits.newapiAccessToken({}, rawProfile.accessToken)
      ) return { ok: false, errorCode: 'missingAccessToken' };
      if (
        adapter === thirdPartyLimits.SUB2API_ADAPTER
        && !thirdPartyLimits.newapiAccessToken({}, rawProfile.accessToken)
      ) return { ok: false, errorCode: 'missingAccessToken' };
      if (
        [thirdPartyLimits.NEWAPI_TOKEN_ADAPTER, thirdPartyLimits.CUSTOM_BALANCE_ADAPTER].includes(adapter)
        && !thirdPartyLimits.newapiApiKey({}, rawProfile.apiKey)
      ) return { ok: false, errorCode: 'missingApiKey' };
      if (
        customAdapter
        && !thirdPartyLimits.normalizeCustomEndpointPath(rawProfile.endpointPath)
      ) return { ok: false, errorCode: 'invalidEndpointPath' };
      if (
        customAdapter
        && !thirdPartyLimits.normalizeCustomAuthMode(rawProfile.authMode)
      ) return { ok: false, errorCode: 'invalidAuthMode' };
      if (
        customAdapter
        && (
          !thirdPartyLimits.normalizeCustomJsonPath(rawProfile.remainingPath)
          || (
            String(rawProfile.usedPath || '').trim()
            && !thirdPartyLimits.normalizeCustomJsonPath(rawProfile.usedPath)
          )
          || (
            String(rawProfile.totalPath || '').trim()
            && !thirdPartyLimits.normalizeCustomJsonPath(rawProfile.totalPath)
          )
        )
      ) return { ok: false, errorCode: 'invalidJsonPath' };
      if (
        customAdapter
        && !thirdPartyLimits.normalizeCustomCurrency(rawProfile.currency)
      ) return { ok: false, errorCode: 'invalidCurrency' };
      if (
        customAdapter
        && thirdPartyLimits.normalizeCustomDivisor(rawProfile.divisor) === null
      ) return { ok: false, errorCode: 'invalidDivisor' };
      const profile = thirdPartyLimits.normalizeThirdPartyProfile({
        ...rawProfile,
        adapter,
        baseUrl,
        enabled: true
      });
      if (!profile) return { ok: false, errorCode: 'invalidCredential' };
      let enrichmentAccessTokenError = null;
      try {
        const provider = await thirdPartyLimits.fetchThirdPartyAccount({ name, ...profile }, electronProviderDeps({
          env: env,
          signal: AbortSignal.timeout(15_000),
          surfaceAccessTokenErrors: true,
          onEnrichmentAccessTokenError: (error) => {
            enrichmentAccessTokenError ||= error;
          }
        }));
        if (provider?.status !== 'ok') {
          return {
            ok: false,
            errorCode: provider?.status === 'unauthorized' ? 'invalidCredential' : 'unavailable'
          };
        }
        const storedProfile = thirdPartyProfileWithCanonicalIdentity(profile, provider) || profile;
        setThirdPartyProfiles({
          ...(getThirdPartyProfiles() || {}),
          [name]: storedProfile
        });
        saveSettings({ throwOnError: true });
        void queueLimitInvalidation({ provider: 'thirdparty', accountName: name }, 'profile-save');
        return {
          ok: true,
          ...(enrichmentAccessTokenError?.code === 'ACCESS_TOKEN_SCOPE_DENIED'
            ? { warning: 'newApiMissingUsageScope' }
            : {})
        };
      } catch (error) {
        return { ok: false, errorCode: thirdPartySaveErrorCode(error) };
      }
    }

  async function deleteProfile(rawName) {
      const name = String(rawName || '').trim();
      const profiles = { ...(getThirdPartyProfiles() || {}) };
      if (!profiles[name]) return { ok: false, error: 'Profile not found' };
      delete profiles[name];
      setThirdPartyProfiles(profiles);
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist third-party API profile deletion' };
      }
      void queueLimitInvalidation({ provider: 'thirdparty', accountName: name }, 'profile-delete', {
        clear: true,
        refresh: false
      });
      return { ok: true };
    }

  async function renameProfile(rawOldName, rawNewName) {
      const oldName = String(rawOldName || '').trim();
      const newName = thirdPartyLimits.thirdPartyProfileName(rawNewName);
      const profiles = { ...(getThirdPartyProfiles() || {}) };
      if (!newName || oldName === newName) return { ok: false, errorCode: 'invalidName' };
      if (!profiles[oldName]) return { ok: false, error: 'Profile not found' };
      if (profiles[newName]) return { ok: false, error: 'Profile name already exists' };
      profiles[newName] = profiles[oldName];
      delete profiles[oldName];
      setThirdPartyProfiles(profiles);
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist third-party API profile rename' };
      }
      void queueLimitInvalidation({ provider: 'thirdparty', accountName: oldName }, 'profile-rename', {
        clear: true,
        refresh: false
      });
      void queueLimitInvalidation({ provider: 'thirdparty', accountName: newName }, 'profile-rename');
      return { ok: true };
    }

  async function setProfileEnabled(rawName, enabled) {
      const name = String(rawName || '').trim();
      const profiles = { ...(getThirdPartyProfiles() || {}) };
      if (!profiles[name]) return { ok: false, error: 'Profile not found' };
      profiles[name] = { ...profiles[name], enabled: Boolean(enabled) };
      setThirdPartyProfiles(profiles);
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist third-party API profile state' };
      }
      void queueLimitInvalidation({ provider: 'thirdparty', accountName: name }, 'profile-state', {
        clear: !enabled,
        refresh: Boolean(enabled)
      });
      return { ok: true };
    }
  return { persistThirdPartyCredentialsRenewal, persistThirdPartyAccountKey, thirdPartyProfileWithCanonicalIdentity, thirdPartySaveErrorCode, getProfiles, saveProfile, deleteProfile, renameProfile, setProfileEnabled };
}
module.exports = { createThirdpartyAccountService };
