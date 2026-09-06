'use strict';

// OpenCode limits provider: the remote Zen/Go account view, layered over the
// local Go ledger in ./goLimits.js and the profile store in ./profiles.js.
// Reached through providerFetchers() in src/shared/limitCollector.js.

const crypto = require('node:crypto');
const opencodeGoApi = require('./goApi');
const opencodeLimits = require('./goLimits');
const opencodeProfiles = require('./profiles');
const opencodeWeb = require('./web');
const {
  normalizeLimitProvider,
  openCodeWindowKey
} = require('../../limits');
const { hashKey } = require('../../hashKey');
const { nowIso } = require('../../limits/providerHelpers');

function openCodeWebIdentity(goWeb, zen, cookie) {
  const goWorkspaceId = goWeb?.status === 'ok' ? String(goWeb.workspaceId || '') : '';
  const zenWorkspaceId = zen?.status === 'ok' ? String(zen.workspaceId || '') : '';
  const workspaceConflict = Boolean(
    goWorkspaceId && zenWorkspaceId && goWorkspaceId !== zenWorkspaceId
  );
  const includeZen = zen?.status === 'ok' && !workspaceConflict;
  const hasSuccessfulWebProbe = goWeb?.status === 'ok' || includeZen;
  // Go is the quota authority when two successful probes unexpectedly resolve
  // different workspaces. Exclude the Zen observation instead of attaching its
  // balance/windows to the wrong account identity.
  const workspaceId = goWorkspaceId || (includeZen ? zenWorkspaceId : '');
  if (hasSuccessfulWebProbe && workspaceId) {
    return {
      accountKey: hashKey('opencode', `workspace:${workspaceId}`),
      aliases: [
        hashKey('opencode', `go:${workspaceId}`),
        hashKey('opencode', `zen:${workspaceId}`)
      ],
      includeZen
    };
  }
  if (cookie && hasSuccessfulWebProbe) {
    const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12);
    return { accountKey: hashKey('opencode', `cookie:${cookieHash}`), aliases: [], includeZen };
  }
  return { accountKey: '', aliases: [], includeZen };
}

const OPENCODE_COMPONENT_PROVENANCE_DETAIL = 'managed';

// Statuses that mean "this source failed and the user should see it". Everything
// else, notably `notConfigured`, is a fall-through: the source simply has nothing
// for this account, so a later source may still answer.
const OPENCODE_REMOTE_FAIL_STATUSES = ['unauthorized', 'sourceRateLimited', 'unavailable'];

// Name for the account behind the key OpenCode stores for itself. Parallel to
// the existing 'default (env)' entry: not a user-chosen name, so it cannot be
// mistaken for a saved account, and stable so the row keeps its identity.
// Shown as the account's name until the user gives it one, so it has to survive
// `normalizeAccountName` intact — the previous "default (auto)" lost its
// brackets there and reached the card as "default auto". Canonical English on
// the wire, because a device record is read by devices in other locales; the
// renderer localizes this exact string.
const OPENCODE_AMBIENT_ACCOUNT_NAME = 'Auto-detected';

// Supplemental windows fill kinds the Go source did not answer, and are dropped
// for any kind it did. The comparison is against the windows actually taken
// rather than against one candidate source: Go quota resolves api → web → local,
// so naming a single source there leaves the other two unguarded and the account
// reports one window kind twice, from two sources and with two different numbers.
function openCodeSupplementalZenWindows(takenWindows, zen) {
  const takenKeys = new Set(
    (Array.isArray(takenWindows) ? takenWindows : [])
      .map(openCodeWindowKey)
      .filter(Boolean)
  );
  return (zen?.windows || []).filter((window) => {
    const key = openCodeWindowKey(window);
    return !key || !takenKeys.has(key);
  });
}

async function fetchOpenCodeLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const updatedAt = nowIso(nowMs);
  const collectGo = deps.opencodeCollectGo || ((d) => opencodeLimits.collectGo(d));
  const collectGoApi = deps.opencodeCollectGoApi || ((d) => opencodeGoApi.collectGoApi(d));
  const readGoApiKey = deps.opencodeReadGoApiKey || ((env) => opencodeGoApi.readGoApiKey(env));
  const fetchGoWeb = deps.opencodeFetchGoWeb || ((cookie, d) => opencodeWeb.fetchGoWeb(cookie, d));
  const fetchZen = deps.opencodeFetchZen || ((cookie, d) => opencodeWeb.fetchZen(cookie, d));

  // Determine cookie sources: explicit profiles > legacy single cookie > env var
  const explicitProfiles = options.opencodeProfiles;
  const envCookie = (deps.env || process.env).TOKEN_MONITOR_OPENCODE_COOKIE || '';

  // An account is a name, and credentials belong to a name. A profile may hold
  // any of: a cookie (Go quota plus Zen balance), a stored API key (Go quota),
  // or a reference to the key OpenCode keeps in auth.json. Sharing a name is
  // the user's own assertion that they are one account, which is the only thing
  // that licenses reading quota from one credential while identity and balance
  // come from another. The reference is stored rather than the key itself, so the
  // key is re-read every tick; it resolves only while it is still the key the
  // reference was bound to.
  const ambientKey = readGoApiKey(deps.env || process.env);
  const ambientIdentity = ambientKey ? opencodeGoApi.goApiIdentity(ambientKey) : '';
  const ambientFor = (p) => opencodeProfiles.ambientKeyFor(p, ambientKey, ambientIdentity);
  let cookies = [];
  if (explicitProfiles && Object.keys(explicitProfiles).length > 0) {
    for (const [name, p] of Object.entries(explicitProfiles)) {
      if (!p.enabled) continue;
      const apiKey = p.apiKey || ambientFor(p);
      if (apiKey || p.cookie) cookies.push({ name, apiKey, cookie: p.cookie });
    }
  } else if (options.opencodeCookie) {
    cookies = [{ name: 'default', cookie: options.opencodeCookie }];
  }

  // Env var — show only if its cookie isn't already in a profile
  if (envCookie && !cookies.some((c) => c.cookie === envCookie)) {
    cookies.push({ name: 'default (env)', cookie: envCookie });
  }

  // The auto-detected key is an unnamed credential until someone names it, so it
  // is tracked on its own and the zero-config path never disappears. Ownership is
  // the shared predicate rather than a copy of it here, so the settings panel
  // cannot end up offering a row this scan is not reading.
  const ambientClaimed = opencodeProfiles.ambientKeyClaimed(explicitProfiles, ambientKey, ambientIdentity);
  // Switched off for a machine signed in to an account the user does not want
  // reported. Only the unclaimed row is suppressed: once an account has claimed
  // the key it is that account's credential, and the account's own toggle owns
  // it, exactly as for a cookie.
  if (ambientKey && !ambientClaimed && options.opencodeAmbientEnabled !== false) {
    cookies.push({ name: OPENCODE_AMBIENT_ACCOUNT_NAME, apiKey: ambientKey, ambient: true });
  }

  const multiAccountMode = cookies.length > 1;
  const scope = options.limitRefreshScope?.provider === 'opencode'
    ? options.limitRefreshScope
    : null;
  if (scope && multiAccountMode) {
    const profileName = scope.accountName || scope.accountLabel;
    // Every scope originates from an action on a *stored* account, and the
    // auto-detected entry is by definition not one. Excluding it by that fact
    // rather than by its name keeps a user who happens to name an account the
    // same string from scoping a refresh onto both.
    cookies = profileName
      ? cookies.filter(({ name, ambient }) => !ambient && name === profileName)
      : [];
  }

  // ── Single account (0 or 1 cookie): existing merged behavior ─────────────
  if (!multiAccountMode) {
    // The database is device-wide and has no stable account identity, so every
    // caller must opt in explicitly before this process reads it.
    const goLocal = options.opencodeLocalLimitsEnabled === true
      ? collectGo({ env: deps.env || process.env, now: () => nowMs })
      : { status: 'notConfigured', windows: [] };
    const primary = cookies[0] || {};
    const cookie = primary.cookie;
    // Only this entry's own key, never the ambient one as a stand-in. The
    // ambient key is its own entry above; reaching for it here would pair it
    // with a cookie whose account nothing can prove it shares, and the cookie's
    // workspace identity wins below, so the result would publish one account's
    // quota — and merge it across devices — under the other's identity.
    const primaryApiKey = primary.apiKey || '';
    const [goApi, goWeb, zen] = await Promise.all([
      collectGoApi({
        env: deps.env || process.env,
        now: () => nowMs,
        fetch: deps.fetch,
        signal: deps.signal,
        apiKey: primaryApiKey
      }),
      cookie ? fetchGoWeb(cookie, { now: () => nowMs, fetch: deps.fetch }) : null,
      cookie ? fetchZen(cookie, { now: () => nowMs, workspaceId: '', fetch: deps.fetch }) : null
    ]);
    const webIdentity = openCodeWebIdentity(goWeb, zen, cookie);
    const webAccountKey = webIdentity.accountKey;

    const windows = [];
    let status = 'notConfigured';
    let source = 'local';
    let accountLabel = '';
    let accountKey = '';
    let balanceUsd = null;

    // Go quota resolves api → web → local. The official API needs no user setup
    // and is the only source anchored on the real subscription month, so it
    // outranks the cookie scrape; the local estimate stays last because it sees
    // only this device's rows and under-reports whenever the same account is
    // used elsewhere.
    //
    // API windows are tagged `web`, not `api`: windows[].source is a two-value
    // wire enum ('web' | 'local') that hubs rank on, and a hub that predates
    // this change would strip an unknown value and then rank the window *below*
    // a local estimate. Both values mean the same thing here anyway — server
    // truth from opencode.ai — and the finer provenance rides on the
    // provider-level source below.
    if (goApi.status === 'ok' && goApi.windows.length > 0) {
      windows.push(...goApi.windows.map((window) => ({ ...window, source: 'web' })));
      status = 'ok'; source = 'api'; accountLabel = 'Go';
      accountKey = hashKey('opencode', goApi.identity || 'go-api');
    } else if (goWeb && goWeb.status === 'ok' && goWeb.windows.length > 0) {
      windows.push(...goWeb.windows.map((window) => ({ ...window, source: 'web' })));
      status = 'ok'; source = 'web'; accountLabel = 'Go';
      accountKey = hashKey('opencode', `go:${goWeb.workspaceId || ''}`);
    } else if (goLocal.status === 'ok' && goApi.entitled !== false) {
      // `entitled === false` is the server saying this account has no Go plan,
      // which the local estimate cannot know: it would keep deriving quota from
      // rows a cancelled subscription left behind. Only an absent or failed API
      // answer leaves room for the estimate.
      windows.push(...goLocal.windows.map((window) => ({ ...window, source: 'local' })));
      status = 'ok'; accountLabel = 'Go';
      accountKey = hashKey('opencode', goLocal.identity || 'go');
    } else if (goLocal.status === 'unavailable' && goApi.entitled !== false) {
      status = 'unavailable';
    }

    if (zen && webIdentity.includeZen) {
      const supplemental = openCodeSupplementalZenWindows(windows, zen)
        .map((window) => ({ ...window, source: 'web' }));
      windows.push(...supplemental);
      status = 'ok';
      // The provider-level source is the compatibility envelope used by Hubs
      // that predate windows[].source. It may claim Web only when every quota
      // window is Web; otherwise an old Hub could turn a local estimate into a
      // Web observation when it strips component provenance.
      // 'api' already implies every quota window is server truth, so it keeps
      // that stronger claim instead of being flattened to 'web' by a Zen window.
      if (source !== 'api' && !windows.some((window) => window.source === 'local')) source = 'web';
      if (typeof zen.balanceUsd === 'number' && Number.isFinite(zen.balanceUsd)) balanceUsd = zen.balanceUsd;
      if (!accountLabel) accountLabel = 'Zen';
      if (!accountKey) accountKey = hashKey('opencode', `zen:${zen.workspaceId || ''}`);
    } else if (status !== 'ok') {
      const remoteFail = OPENCODE_REMOTE_FAIL_STATUSES;
      // Only reached when nothing produced windows. A stale API key would
      // otherwise read as "not configured" and leave the user nothing to fix.
      const surfaced = (remoteFail.includes(goApi.status) && { status: goApi.status, source: 'api' })
        || (goWeb && remoteFail.includes(goWeb.status) && { status: goWeb.status, source: 'web' })
        || (zen && remoteFail.includes(zen.status) && { status: zen.status, source: 'web' });
      if (surfaced) { status = surfaced.status; source = surfaced.source; }
    }

    // A failed API probe still names its account: the key identifies it, so a
    // 401 or a rate limit must not leave an empty accountKey that matches
    // nothing already stored on the Hub.
    if (!accountKey && goApi.identity) accountKey = hashKey('opencode', goApi.identity);
    if (webAccountKey) accountKey = webAccountKey;
    // Publish the key's own identity as an alias whenever one was used. The
    // cookie's workspace identity wins above, so without this a device holding
    // only the key would never group with the account it belongs to.
    const apiAlias = goApi.identity ? hashKey('opencode', goApi.identity) : '';
    return normalizeLimitProvider({
      provider: 'opencode',
      // The account this row is for, whether or not more than one exists. Left
      // off, a machine that resolves to exactly one OpenCode account showed it
      // as "Account 1", and enabling a second account did not fix it until a
      // restart: the scoped refresh only rebuilds the account it targets, so
      // this row kept its nameless record while the new one arrived named.
      accountName: primary.name || '',
      accountKey,
      webAccountKey,
      accountKeyAliases: [...webIdentity.aliases, apiAlias].filter(Boolean),
      accountLabel,
      source,
      sourceDetail: OPENCODE_COMPONENT_PROVENANCE_DETAIL,
      status,
      updatedAt,
      windows,
      balanceUsd
    });
  }

  // ── Multi-account (2+ cookies): separate per-profile providers ────────────
  const providers = [];

  // Each enabled profile — query in parallel. One path for every credential
  // combination: an account holding only a key is the same shape with no cookie,
  // and keeping it as a separate function is what let the two drift apart.
  const results = await Promise.all(
    cookies.map((profile) => fetchOpenCodeProfile(
      profile.name,
      profile.cookie,
      fetchGoWeb,
      fetchZen,
      nowMs,
      updatedAt,
      { apiKey: profile.apiKey, collectGoApi, deps }
    ))
  );
  for (const provider of results) {
    if (provider) providers.push(provider);
  }

  if (providers.length === 0) {
    providers.push(normalizeLimitProvider({
      provider: 'opencode', accountKey: '', accountLabel: '',
      source: 'local', status: 'notConfigured', updatedAt, windows: []
    }));
  }

  return providers;
}

// One account, whichever credentials it holds. `cookie` and `api.apiKey` are
// each optional: sharing a name is the user's assertion that they are the same
// account, which is what licenses reading Go quota from the key while Zen
// balance and the workspace identity come from the cookie. An account holding
// only one of them is the same shape with the other absent.
async function fetchOpenCodeProfile(name, cookie, fetchGoWeb, fetchZen, nowMs, updatedAt, api = {}) {
  const PROFILE_TIMEOUT_MS = 15000;
  let timer;

  try {
    const result = await Promise.race([
      (async () => {
        const [goWeb, zen, goApi] = await Promise.all([
          cookie ? fetchGoWeb(cookie, { now: () => nowMs, fetch: api.deps?.fetch }) : null,
          cookie ? fetchZen(cookie, { now: () => nowMs, workspaceId: '', fetch: api.deps?.fetch }) : null,
          api.apiKey
            ? api.collectGoApi({
              env: api.deps?.env || process.env,
              now: () => nowMs,
              fetch: api.deps?.fetch,
              signal: api.deps?.signal,
              apiKey: api.apiKey
            })
            : null
        ]);
        return { goWeb, zen, goApi };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), PROFILE_TIMEOUT_MS);
      })
    ]);
    clearTimeout(timer);

    const { goWeb, zen, goApi } = result;
    const windows = [];
    let status = 'notConfigured';
    let planLabel = '';
    let balanceUsd = null;
    let source = 'web';

    if (goApi && goApi.status === 'ok' && goApi.windows.length > 0) {
      windows.push(...goApi.windows.map((window) => ({ ...window, source: 'web' })));
      status = 'ok';
      planLabel = 'Go';
      source = 'api';
    } else if (goWeb && goWeb.status === 'ok' && goWeb.windows.length > 0) {
      windows.push(...goWeb.windows.map((window) => ({ ...window, source: 'web' })));
      status = 'ok';
      planLabel = 'Go';
    }

    const webIdentity = openCodeWebIdentity(goWeb, zen, cookie);
    if (zen && webIdentity.includeZen) {
      const supplemental = openCodeSupplementalZenWindows(windows, zen)
        .map((window) => ({ ...window, source: 'web' }));
      windows.push(...supplemental);
      status = 'ok';
      if (!planLabel) planLabel = 'Zen';
      if (typeof zen.balanceUsd === 'number' && Number.isFinite(zen.balanceUsd)) balanceUsd = zen.balanceUsd;
    }

    if (status !== 'ok') {
      // `notConfigured` from the API means "this account has no Go subscription",
      // which is a fallback condition rather than a failure. Letting it win here
      // would hide the cookie's own `unauthorized` and tell the user nothing is
      // configured when what actually happened is that their cookie expired.
      // The API's own `notConfigured` is ranked last rather than dropped: it
      // must not outrank an expired cookie, but on an account with no cookie at
      // all it is the true answer, and falling through to the literal would
      // report "sign in again" for a workspace that simply has no Go plan.
      //
      // Provenance travels with the status, as it does on the single-account
      // path and in the timeout branch below. Left behind, the `web` default
      // stood while the status came from the key, so one expired API key read
      // as an `API` failure on a machine with a single account and as a `Web`
      // failure the moment a second account existed. How many accounts are
      // configured cannot change which credential failed.
      const failure = (OPENCODE_REMOTE_FAIL_STATUSES.includes(goApi?.status) && { status: goApi.status, source: 'api' })
        || (goWeb && { status: goWeb.status, source: 'web' })
        || (zen && { status: zen.status, source: 'web' })
        || (goApi && { status: goApi.status, source: 'api' })
        || { status: 'unauthorized', source: api.apiKey && !cookie ? 'api' : 'web' };
      status = failure.status;
      source = failure.source;
    }

    // The key's own identity, published whenever this account holds one. The
    // same key on another device that has no cookie identifies itself by that
    // key alone, so without this the two devices never group into one account.
    const keyIdentity = api.apiKey
      ? hashKey('opencode', opencodeGoApi.goApiIdentity(api.apiKey))
      : '';

    // Stable accountKey derived from workspaceId (preferred), then the key, then
    // the cookie hash — never from the user-editable profile name, so the same
    // account is identified consistently across machines and renames. The key
    // ranks above the cookie hash because it is the same string on every device,
    // while a cookie is per-browser-session.
    let accountKey = webIdentity.accountKey || keyIdentity;
    if (!accountKey && cookie) {
      const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12);
      accountKey = hashKey('opencode', `cookie:${cookieHash}`);
    }
    const boundKeyAlias = accountKey === keyIdentity ? '' : keyIdentity;

    return normalizeLimitProvider({
      provider: 'opencode',
      accountKey,
      // Only a cookie yields this. The Hub picks the canonical identity for a
      // merged account from the webAccountKeys it collects, and it picks by
      // sorting them, so publishing the key's hash here would let an API-only
      // device's identity win over a real workspace id — deciding an account's
      // canonical identity by which devices happen to be online.
      webAccountKey: webIdentity.accountKey,
      accountKeyAliases: [...webIdentity.aliases, boundKeyAlias].filter(Boolean),
      accountName: name,
      // Keep accountLabel as the profile name for pre-accountName renderers.
      // New renderers use planLabel for Go/Zen and accountName for identity.
      accountLabel: name,
      planLabel,
      source,
      sourceDetail: OPENCODE_COMPONENT_PROVENANCE_DETAIL,
      status,
      updatedAt,
      windows,
      balanceUsd
    });
  } catch (error) {
    clearTimeout(timer);
    // Routing the API probe through this helper made it reachable by an abort,
    // which the bare catch would have turned into a stale `unavailable` row and
    // published over whatever superseded it. The lane is latest-wins.
    if (opencodeGoApi.isAbortError(error, api.deps?.signal)) throw error;
    // Same identity ranking as the success path, so a timeout does not hand the
    // account a different accountKey than the one already on the Hub.
    let accountKey = api.apiKey ? hashKey('opencode', opencodeGoApi.goApiIdentity(api.apiKey)) : '';
    if (!accountKey && cookie) {
      const cookieHash = crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12);
      accountKey = hashKey('opencode', `cookie:${cookieHash}`);
    }
    return normalizeLimitProvider({
      // No webAccountKey: this row probed nothing, so it has no workspace
      // identity to offer, and claiming one would let a timed-out device decide
      // the canonical identity of the merged account.
      provider: 'opencode', accountKey,
      accountName: name, accountLabel: name, planLabel: '',
      source: api.apiKey && !cookie ? 'api' : 'web',
      sourceDetail: OPENCODE_COMPONENT_PROVENANCE_DETAIL, status: 'unavailable',
      updatedAt, windows: [], balanceUsd: null
    });
  }
}

module.exports = {
  fetchOpenCodeLimits,
  fetchOpenCodeProfile
};
