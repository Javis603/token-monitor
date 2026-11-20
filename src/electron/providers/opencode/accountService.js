'use strict';

const opencodeGoApi = require('../../../shared/providers/opencode/goApi');
const opencodeProfiles = require('../../../shared/providers/opencode/profiles');
const opencodeWeb = require('../../../shared/providers/opencode/web');
const { openCodeCookieAccountKey } = require('../../../shared/providers/opencode/identity');
const { hashKey } = require('../../../shared/hashKey');

/**
 * Owns opencode account workflows and process-local state.
 * @param {object} deps Provider-scoped persistence and named host IO capabilities.
 */
function createOpencodeAccountService(deps) {
  const { getOpencodeProfiles, queueLimitInvalidation, electronLimitsFetch, setOpencodeProfiles, setOpencodeCookie, saveSettings, electronProviderDeps, getOpencodeAmbientEnabled, getOpencodeCookie, setOpencodeAmbientEnabled, env = process.env, web = opencodeWeb, goApi = opencodeGoApi } = deps;
  let opencodeStatusCache = { value: null, at: 0 };
  const CURSOR_STATUS_TTL_MS = 30 * 1000;
  const OPENCODE_API_PROBE_TIMEOUT_MS = 15_000;
  function refreshOpencodeAmbientOwnership(wasActive) {
    if (opencodeAmbientKeyActive(getOpencodeProfiles() || {}) === wasActive) return;
    void queueLimitInvalidation({ provider: 'opencode' }, 'ambient-ownership', { clear: true });
  }

  function opencodeAmbientKeyActive(profiles) {
    const ambientKey = goApi.readGoApiKey(env);
    if (!ambientKey) return false;
    const ambientIdentity = goApi.goApiIdentity(ambientKey);
    return !opencodeProfiles.ambientKeyClaimed(profiles, ambientKey, ambientIdentity);
  }

  async function probeOpenCodeApiKey(apiKey) {
    try {
      return await goApi.fetchGoApi(apiKey, {
        fetch: electronLimitsFetch(),
        signal: AbortSignal.timeout(OPENCODE_API_PROBE_TIMEOUT_MS)
      });
    } catch (_) {
      return { status: 'unavailable', windows: [] };
    }
  }

  async function saveCookie(raw) {
      const cookie = web.sanitizeCookieHeader(raw, '__Host-console_session');
      if (!cookie) {
        setOpencodeProfiles({});
        setOpencodeCookie('');
        try {
          saveSettings({ throwOnError: true });
        } catch (error) {
          return { ok: false, error: error?.message || 'Could not persist OpenCode credentials' };
        }
        opencodeStatusCache = { value: null, at: 0 };
        void queueLimitInvalidation({ provider: 'opencode' }, 'logout', { clear: true });
        return { ok: true, cleared: true };
      }
      try {
        const [go, zen] = await web.fetchWeb(cookie, electronProviderDeps());
        if (web.summarizeLink(go, zen).expired) {
          return { ok: false, error: 'OpenCode rejected the cookie (it may be expired)' };
        }
        const profiles = getOpencodeProfiles() || {};
        profiles.default = { cookie, enabled: true };
        setOpencodeProfiles(profiles);
        setOpencodeCookie(cookie);
        saveSettings({ throwOnError: true });
        opencodeStatusCache = { value: null, at: 0 };
        void queueLimitInvalidation({ provider: 'opencode' }, 'credential-save', { clear: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

  async function logout() {
      try {
        setOpencodeProfiles({});
        setOpencodeCookie('');
        saveSettings({ throwOnError: true });
        opencodeStatusCache = { value: null, at: 0 };
        void queueLimitInvalidation({ provider: 'opencode' }, 'logout', { clear: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

  async function status() {
      const now = Date.now();
      if (opencodeStatusCache.value && now - opencodeStatusCache.at < CURSOR_STATUS_TTL_MS) {
        return opencodeStatusCache.value;
      }
      const profiles = getOpencodeProfiles() || {};
      // A profile that only names the auto-detected key stores no credential of
      // its own, so filtering on `cookie || apiKey` alone would skip it and leave
      // its row stuck on the placeholder while the collector reads live quota
      // from that very key. Resolve the key the same way the collector does.
      const ambientKey = goApi.readGoApiKey(env);
      const ambientIdentity = ambientKey ? goApi.goApiIdentity(ambientKey) : '';
      const profileKey = (p) => p.apiKey || opencodeProfiles.ambientKeyFor(p, ambientKey, ambientIdentity);
      // A reference that no longer resolves still has to answer for its row. It
      // has a credential the user stored, so filtering it out here would leave the
      // row on its placeholder forever with nothing saying what to do about it.
      const needsRebind = (p) => Boolean(p.useAmbientKey) && !profileKey(p) && !p.cookie;
      const entries = Object.entries(profiles)
        .filter(([, p]) => (p.cookie || profileKey(p) || needsRebind(p)) && p.enabled);

      // Query all profiles in parallel
      const results = await Promise.all(
        entries.map(async ([name, profile]) => {
          const apiKey = profileKey(profile);
          if (needsRebind(profile)) {
            return [name, {
              linked: false,
              expired: false,
              go: false,
              zen: false,
              hasBalance: false,
              balanceUsd: null,
              needsRebind: true
            }];
          }
          // An API key reaches Go quota and nothing else, so it reports the same
          // shape as a cookie with the Zen half permanently absent. Without this
          // branch an API account is never probed and the panel sits at "0/1".
          // Only a cookie account can be probed for Zen, so a profile holding both
          // falls through to the cookie path and its key is used by the collector.
          if (apiKey && !profile.cookie) {
            const probe = await probeOpenCodeApiKey(apiKey);
            // The renderer checks `linked` before `error`, so anything short of a
            // working key must not claim linked or it renders a bare "✓" with no
            // plan behind it.
            if (probe.status === 'ok') {
              return [name, { linked: true, expired: false, go: true, zen: false, hasBalance: false, balanceUsd: null }];
            }
            if (probe.status === 'unauthorized') {
              return [name, { linked: true, expired: true, go: false, zen: false, hasBalance: false, balanceUsd: null }];
            }
            return [name, {
              linked: false,
              expired: false,
              go: false,
              zen: false,
              hasBalance: false,
              balanceUsd: null,
              error: probe.status
            }];
          }
          const [[go, zen], apiProbe] = await Promise.all([
            web.fetchWeb(profile.cookie, electronProviderDeps(), { isolateErrors: true }),
            apiKey ? probeOpenCodeApiKey(apiKey) : null
          ]);
          const summary = { ...web.summarizeLink(go, zen), balanceUsd: zen.balanceUsd };
          // A bound key answers for Go on its own, so the row must not read as
          // expired just because the cookie half died: the collector still has
          // quota, and only the Zen balance is actually missing.
          if (apiProbe?.status === 'ok') {
            summary.go = true;
            summary.linked = true;
            summary.expired = false;
            delete summary.error;
          }
          return [name, summary];
        })
      );

      const result = Object.fromEntries(results);

      // Legacy env cookie. Skip it when it matches an enabled profile so the
      // panel doesn't report an extra "connected" account that the collector
      // dedupes away (otherwise it shows 2/2 while only one account is tracked).
      const envCookie = env.TOKEN_MONITOR_OPENCODE_COOKIE || '';
      if (envCookie && !entries.some(([, p]) => p.cookie === envCookie)) {
        const [go, zen] = await web.fetchWeb(envCookie, electronProviderDeps(), { isolateErrors: true });
        let envKey = 'env';
        for (let i = 1; Object.prototype.hasOwnProperty.call(profiles, envKey); i += 1) {
          envKey = `env:${i}`;
        }
        result[envKey] = { ...web.summarizeLink(go, zen), balanceUsd: zen.balanceUsd, env: true };
      }
      // Zero configuration still has an account behind it. Without probing the key
      // OpenCode stored for itself, the panel reports "not set up" while the limits
      // card is showing live quota read from that very key.
      //
      // It rides in its own field rather than under a reserved name inside
      // `profiles`: account names are user-chosen, so any sentinel key is one a
      // user can also type, and the synthetic entry would then overwrite their
      // account's real status (and collide with its DOM id in the renderer).
      let ambient = null;
      if (opencodeAmbientKeyActive(profiles) && getOpencodeAmbientEnabled() === false) {
        ambient = { linked: false, expired: false, go: false, zen: false, hasBalance: false, balanceUsd: null, ambient: true, disabled: true };
      } else if (opencodeAmbientKeyActive(profiles)) {
        const probe = await probeOpenCodeApiKey(goApi.readGoApiKey(env));
        ambient = {
          linked: probe.status === 'ok',
          expired: probe.status === 'unauthorized',
          go: probe.status === 'ok',
          zen: false,
          hasBalance: false,
          balanceUsd: null,
          ambient: true,
          ...(probe.status === 'ok' || probe.status === 'unauthorized' ? {} : { error: probe.status })
        };
      }
      const value = {
        profiles: result,
        ambient,
        linked: Object.values(result).some(s => s.linked) || Boolean(ambient?.linked)
      };
      opencodeStatusCache = { value, at: now };
      return value;
    }

  async function getProfiles() {
      const profiles = getOpencodeProfiles() || {};
      // The Go quota also arrives with no configuration at all, from the key
      // OpenCode itself stores. Without counting that, the panel reports "not set
      // up" while the limits card is showing live API data from the same account.
      const hasEnvVar = Boolean(env.TOKEN_MONITOR_OPENCODE_COOKIE);
      // Kept as its own field rather than folded into hasEnvVar: an environment
      // cookie and a key OpenCode stored for itself are different sources, and a
      // later reader seeing hasEnvVar would reasonably assume the former.
      // Credential values never cross to the renderer; which kinds exist does, so
      // the list can show what a profile actually holds.
      const ambientKey = goApi.readGoApiKey(env);
      const ambientIdentity = ambientKey ? goApi.goApiIdentity(ambientKey) : '';
      const hasAmbientKey = Boolean(ambientKey)
        && !opencodeProfiles.ambientKeyClaimed(profiles, ambientKey, ambientIdentity);
      // Keyed on user-typed names, so it must not inherit one. Structured clone
      // hands the renderer a plain object either way.
      const safe = Object.create(null);
      for (const [name, p] of Object.entries(profiles)) {
        // Use the same key identity as quota collection. A pinned ambient
        // reference must not adopt a newly rotated machine key. Cookie-only
        // profiles use the collector's credential fallback; a verified reading
        // can resolve that alias to its workspace without guessing from names.
        const key = p.apiKey || opencodeProfiles.ambientKeyFor(p, ambientKey, ambientIdentity);
        safe[name] = {
          accountKey: key ? hashKey('opencode', goApi.goApiIdentity(key)) : openCodeCookieAccountKey(p.cookie || ''),
          enabled: p.enabled,
          hasApiKey: Boolean(p.apiKey),
          hasCookie: Boolean(p.cookie),
          usesAmbientKey: Boolean(p.useAmbientKey),
          // Held but not resolving, because the key it was bound to is no longer
          // the one on this machine. Without saying so the list shows the
          // credential as present while the collector ignores it, and on an
          // account that also has a cookie nothing else would reveal it.
          ambientStale: Boolean(p.useAmbientKey)
            && !opencodeProfiles.ambientKeyFor(p, ambientKey, ambientIdentity)
        };
      }
      // The collector reads the legacy environment cookie as its own account
      // unless an enabled profile already holds it, so the list shows it the same way.
      const envCookie = env.TOKEN_MONITOR_OPENCODE_COOKIE || '';
      const environmentAccountKey = envCookie && !Object.values(profiles).some(p => p.enabled && p.cookie === envCookie)
        ? openCodeCookieAccountKey(envCookie) : '';
      return {
        profiles: safe,
        hasEnvVar,
        environmentAccountKey,
        hasAmbientKey,
        ambientAccountKey: hasAmbientKey ? hashKey('opencode', ambientIdentity) : '',
        ambientEnabled: getOpencodeAmbientEnabled() !== false
      };
    }

  async function saveProfile(name, raw, kind = 'cookie', options = {}) {
      // Trimmed, so whitespace cannot create an account name that renders blank
      // and that nobody could ever type again to attach a second credential.
      name = String(name || '').trim();
      if (!name) return { ok: false, error: 'Empty name' };
      // Reject anything else rather than treating it as a cookie: an unrecognized
      // kind would store the value in the wrong field and read as a credential it
      // is not.
      if (!['api', 'cookie', 'ambient'].includes(kind)) {
        return { ok: false, error: `Unknown credential kind: ${kind}` };
      }
      try {
        let credential;
        if (kind === 'ambient') {
          // Naming the auto-detected credential. A reference is stored, never the
          // key itself, so the key is re-read every tick rather than going stale
          // at 401 behind a snapshot.
          const ambientKey = goApi.readGoApiKey(env);
          if (!ambientKey) {
            return { ok: false, error: 'No OpenCode credential found on this machine' };
          }
          // Records which account the reference was bound to, so a key that later
          // changes stops resolving here instead of quietly pairing whoever is
          // signed in next with this account's cookie. It is a digest, not the
          // key: the value itself is never stored for this credential kind.
          credential = {
            useAmbientKey: true,
            ambientKeyIdentity: goApi.goApiIdentity(ambientKey)
          };
        } else if (kind === 'api') {
          const apiKey = String(raw || '').trim();
          if (!apiKey) return { ok: false, error: 'Empty API key' };
          const probe = await probeOpenCodeApiKey(apiKey);
          if (probe.status === 'unauthorized') {
            return { ok: false, error: 'OpenCode rejected the API key' };
          }
          // The key authenticates but the workspace has no Go plan, so this
          // profile would render permanently empty. Say so instead of saving it.
          if (probe.status === 'notConfigured') {
            return { ok: false, error: 'That account has no OpenCode Go subscription' };
          }
          if (probe.status !== 'ok') {
            return { ok: false, error: 'Could not reach the OpenCode usage API' };
          }
          credential = { apiKey };
        } else {
          const cookie = web.sanitizeCookieHeader(raw, '__Host-console_session');
          if (!cookie) return { ok: false, error: 'Empty cookie' };
          const [go, zen] = await web.fetchWeb(cookie, electronProviderDeps());
          if (web.summarizeLink(go, zen).expired) {
            return { ok: false, error: 'OpenCode rejected the cookie (it may be expired)' };
          }
          credential = { cookie };
        }
        // Saving one credential replaces only that kind and keeps the others. Two
        // kinds under one profile name is how a user says "these are the same
        // account", which is the only thing that licenses reading Go quota from
        // the key while Zen balance comes from the cookie. Nothing associates them
        // automatically — same machine is not evidence of same account — so the
        // binding is refused here until the caller confirms it, whichever UI path
        // asked. A blur that happens to land on an existing name must not be able
        // to make that claim on the user's behalf.
        const ambientWasActive = opencodeAmbientKeyActive(getOpencodeProfiles() || {});
        const result = opencodeProfiles.saveCredential(
          getOpencodeProfiles() || {},
          name,
          credential,
          { merge: options.merge === true }
        );
        if (!result.ok) return result;
        setOpencodeProfiles(result.profiles);
        saveSettings({ throwOnError: true });
        opencodeStatusCache = { value: null, at: 0 };
        void queueLimitInvalidation({ provider: 'opencode', accountName: name }, 'profile-save');
        refreshOpencodeAmbientOwnership(ambientWasActive);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

  async function deleteProfile(name) {
      const profiles = getOpencodeProfiles() || {};
      const ambientWasActive = opencodeAmbientKeyActive(profiles);
      const deletedProfile = opencodeProfiles.readProfile(profiles, name);
      delete profiles[name];
      if (deletedProfile?.cookie && getOpencodeCookie() === deletedProfile.cookie) {
        setOpencodeCookie('');
      }
      setOpencodeProfiles(profiles);
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist OpenCode profile deletion' };
      }
      opencodeStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'opencode', accountName: name }, 'profile-delete', {
        clear: true,
        refresh: false
      });
      refreshOpencodeAmbientOwnership(ambientWasActive);
      return { ok: true };
    }

  async function removeCredential(name, kind) {
      const ambientWasActive = opencodeAmbientKeyActive(getOpencodeProfiles() || {});
      const result = opencodeProfiles.removeCredential(getOpencodeProfiles() || {}, name, kind);
      if (!result.ok) return result;
      if (result.removedCookie && getOpencodeCookie() === result.removedCookie) {
        setOpencodeCookie('');
      }
      setOpencodeProfiles(result.profiles);
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist OpenCode credential removal' };
      }
      opencodeStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'opencode', accountName: name }, 'credential-remove', {
        clear: true
      });
      refreshOpencodeAmbientOwnership(ambientWasActive);
      return { ok: true };
    }

  async function moveCredential(name, kind, targetName, options = {}) {
      const ambientWasActive = opencodeAmbientKeyActive(getOpencodeProfiles() || {});
      const result = opencodeProfiles.moveCredential(
        getOpencodeProfiles() || {},
        name,
        kind,
        targetName,
        { merge: options.merge === true }
      );
      if (!result.ok) return result;
      if (result.unchanged) return { ok: true };
      const target = String(targetName || '').trim();
      setOpencodeProfiles(result.profiles);
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist OpenCode credential move' };
      }
      opencodeStatusCache = { value: null, at: 0 };
      for (const account of [name, target]) {
        void queueLimitInvalidation({ provider: 'opencode', accountName: account }, 'credential-move', {
          clear: true
        });
      }
      refreshOpencodeAmbientOwnership(ambientWasActive);
      return { ok: true };
    }

  async function renameProfile(oldName, newName, options = {}) {
      const ambientWasActive = opencodeAmbientKeyActive(getOpencodeProfiles() || {});
      const result = opencodeProfiles.renameProfile(
        getOpencodeProfiles() || {},
        oldName,
        newName,
        { merge: options.merge === true }
      );
      if (!result.ok) return result;
      setOpencodeProfiles(result.profiles);
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist OpenCode profile rename' };
      }
      opencodeStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'opencode', accountName: oldName }, 'profile-rename', {
        clear: true,
        refresh: false
      });
      void queueLimitInvalidation({ provider: 'opencode', accountName: newName }, 'profile-rename');
      refreshOpencodeAmbientOwnership(ambientWasActive);
      return { ok: true };
    }

  async function setProfileEnabled(name, enabled) {
      const profiles = getOpencodeProfiles() || {};
      // Own properties only. An inherited key resolves to an object that is not an
      // account, and writing `enabled` onto it would reach whatever else shares
      // that prototype.
      const profile = opencodeProfiles.readProfile(profiles, name);
      if (!profile) return { ok: false, error: 'Profile not found' };
      profile.enabled = Boolean(enabled);
      setOpencodeProfiles(profiles);
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist OpenCode profile state' };
      }
      opencodeStatusCache = { value: null, at: 0 };
      void queueLimitInvalidation({ provider: 'opencode', accountName: name }, 'profile-state', {
        clear: !enabled,
        refresh: Boolean(enabled)
      });
      return { ok: true };
    }

  async function setAmbientEnabled(enabled) {
      setOpencodeAmbientEnabled(enabled !== false);
      try {
        saveSettings({ throwOnError: true });
      } catch (error) {
        return { ok: false, error: error?.message || 'Could not persist the OpenCode detection setting' };
      }
      opencodeStatusCache = { value: null, at: 0 };
      // Provider-wide, for the same reason every ownership change is: this row has
      // no account name for a scoped refresh to address. It must still refresh
      // afterwards. Clearing without one wipes every OpenCode account and rebuilds
      // none of them, so switching off the detected key read as switching off the
      // whole provider — the rest of the accounts are unaffected by this setting
      // and have to come straight back.
      void queueLimitInvalidation({ provider: 'opencode' }, 'ambient-toggle', { clear: true });
      return { ok: true };
    }
  return { refreshOpencodeAmbientOwnership, opencodeAmbientKeyActive, probeOpenCodeApiKey, saveCookie, logout, status, getProfiles, saveProfile, deleteProfile, removeCredential, moveCredential, renameProfile, setProfileEnabled, setAmbientEnabled };
}
module.exports = { createOpencodeAccountService };
