'use strict';

// Read-only discovery of the locally installed ZCode desktop app's connection
// state. ZCode persists its provider registry and current selection under
// ~/.zcode/v2/ as plain JSON; this module reads those files on every call (no
// caching — the on-disk state is the source of truth for account switches,
// mirroring how codexAuth re-reads auth.json each refresh).
//
// 3.12.3 migration notes: the family selection moved to
// providerFamilyConnectionSelections[family].kind (the legacy selected-key
// string is retained but no longer written), the per-plan entitlement cache
// (coding-plan-cache.json) stopped being written, and provider entries keep a
// persistent systemDisabledReason instead of a transient enabled flag.
//
// Missing files are normal (ZCode not installed) and resolve to kind 'none';
// malformed JSON is treated the same way rather than surfacing as an error.
// The credential returned for the billing lane is ZCode's own on-disk mirror
// key, for in-memory use only — never logged or persisted by the caller.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ZCODE_DIR = path.join('.zcode', 'v2');

// builtin: provider ids as named by ZCode itself (its config.json keys).
const ZCODE_PROVIDER_IDS = Object.freeze({
  apiKey: Object.freeze({ zai: 'builtin:zai', bigmodel: 'builtin:bigmodel' }),
  startPlan: Object.freeze({ zai: 'builtin:zai-start-plan', bigmodel: 'builtin:bigmodel-start-plan' }),
  codingPlan: Object.freeze({ zai: 'builtin:zai-coding-plan', bigmodel: 'builtin:bigmodel-coding-plan' })
});

// ZCode 3.12.3 moved the family selection to a kind-based field
// (providerFamilyConnectionSelections[family].kind, its own one-way
// migration); both plan kinds resolve to the builtin:* entry that carries
// the mirror credential. An off-peak selection has no GLM plan lane here and
// maps to nothing — it must not fall back to a frozen legacy selection.
const SELECTION_KIND_SLOT = Object.freeze({
  'start-plan': 'startPlan',
  'individual-coding-plan': 'codingPlan',
  'team-coding-plan': 'codingPlan'
});

// api.z.ai endpoints imply the global family; anything else ZCode treats as
// BigModel-like. Mirrors ZCode's own resolveModelProviderFamilyIdByBaseURL.
function familyByBaseUrl(baseUrl) {
  return /api\.z\.ai|api\.chatglm\.site/i.test(String(baseUrl || '')) ? 'zai' : 'bigmodel';
}

// Resolve the selected provider entry. 3.12.3 writes the kind-based selection
// and leaves the legacy key string in place without updating it, so the new
// field wins whenever it exists; the legacy string only serves 3.11.x
// installs. An unrecognised kind (off-peak) yields no lane rather than a
// stale fallback.
function selectedProviderId(settings, family) {
  const kind = String(settings?.providerFamilyConnectionSelections?.[family]?.kind || '').trim();
  if (kind) {
    const slot = SELECTION_KIND_SLOT[kind];
    return slot ? ZCODE_PROVIDER_IDS[slot][family] : '';
  }
  const selected = String(settings?.modelProviderFamilySelectedKeys?.[family] || '').trim();
  const match = /^(?:coding-plan|preset):(.+)$/.exec(selected);
  return match ? match[1].trim() : '';
}

function readJson(filePath, readFileSync) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function isStartPlanProviderId(providerId) {
  return providerId === ZCODE_PROVIDER_IDS.startPlan.zai || providerId === ZCODE_PROVIDER_IDS.startPlan.bigmodel;
}

function isCodingPlanProviderId(providerId) {
  return providerId === ZCODE_PROVIDER_IDS.codingPlan.zai || providerId === ZCODE_PROVIDER_IDS.codingPlan.bigmodel;
}

// Resolve which credential the billing lane should present. ZCode stores its
// login token encrypted in credentials.json (unreadable to us) and mirrors a
// plain JWT into the provider entry; the mirror is the only readable key, and
// ZCode rotated it on each login up to 3.11.x, so a stale mirror is answered
// by the server as a parameter/auth error and surfaces as unavailable.
function billingCredential(provider) {
  const providerKey = String(provider?.options?.apiKey || '').trim();
  if (providerKey) return { token: providerKey, source: 'zcode-auto' };
  return null;
}

// ZCode resolves its data base as env ZCODE_DATA_BASE_DIR (Windows installs
// may also set ZCODE_WINDOWS_APP_INSTALL_DIR), then HOME, then os.homedir()
// — join(<base>, '.zcode', 'v2'). Mirrors that chain so an env-redirected
// install is found, the same way CODEX_HOME redirects the Codex roots.
function zcodeDataBaseDir(env = process.env, homeDir = os.homedir()) {
  const fromEnv = String(env.ZCODE_DATA_BASE_DIR || env.ZCODE_WINDOWS_APP_INSTALL_DIR || '').trim();
  if (fromEnv) return fromEnv;
  return String(env.HOME || '').trim() || homeDir;
}

function discoverZcodeConnection(options = {}, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const env = deps.env || process.env;
  const homeDir = deps.homeDir || options.homeDir || os.homedir();
  const base = deps.zcodeDir || path.join(zcodeDataBaseDir(env, homeDir), ZCODE_DIR);

  const settings = readJson(path.join(base, 'setting.json'), readFileSync);
  const registry = readJson(path.join(base, 'config.json'), readFileSync);
  if (!settings || !registry) return { kind: 'none' };

  const domain = String(settings.providerFamilyDomain || '').trim();
  const family = domain === 'zai' || domain === 'bigmodel' ? domain : null;
  if (!family) return { kind: 'none' };

  const providerId = selectedProviderId(settings, family);
  if (!providerId) return { kind: 'none' };
  const provider = registry.provider?.[providerId] || null;
  if (!provider) return { kind: 'none' };
  // 3.12.3 keeps a disabled entry as a persistent state (systemDisabledReason
  // enumerates five causes); only oauth_provider_inactive means the account
  // context is gone, and the torn two-write switch 3.11.x produced left a
  // disabled entry with no reason at all. Both are skipped — every other
  // reason is a state the lane's own query and error classification answers,
  // instead of being swallowed here as "not settled".
  if (provider.enabled === false) {
    const reason = String(provider.systemDisabledReason || '').trim();
    if (!reason || reason === 'oauth_provider_inactive') return { kind: 'none' };
  }

  if (isStartPlanProviderId(providerId) || isCodingPlanProviderId(providerId)) {
    const kind = isStartPlanProviderId(providerId) ? 'start-billing' : 'coding-quota';
    const credential = billingCredential(provider);
    // `entitled` marks a result the lane can actually query. Since 3.12.3
    // stopped writing the entitlement cache, the mirror key's presence is the
    // only local signal; the query itself answers entitlement.
    if (!credential) return { kind, family, providerId, entitled: false, reason: 'coding_plan_not_authenticated' };
    // Billing is an account-level endpoint: ZCode queries it even while the
    // coding-plan provider is selected (validateZaiCodingPlanPairAvailability
    // → validateStartPlanAvailability), so the coding shape carries the
    // start-plan entry's mirror key alongside its own quota query.
    let billing;
    if (kind === 'coding-quota') {
      const startCredential = billingCredential(registry.provider?.[ZCODE_PROVIDER_IDS.startPlan[family]] || null);
      if (startCredential) billing = { credential: startCredential };
    }
    return { kind, family, providerId, entitled: true, credential, ...(billing ? { billing } : {}) };
  }

  const baseUrl = String(provider?.options?.baseURL || '').trim();
  return {
    kind: 'api-unsupported',
    family: provider && baseUrl ? familyByBaseUrl(baseUrl) : family,
    providerId,
    entitled: false,
    reason: 'api_balance_not_supported'
  };
}

module.exports = {
  ZCODE_PROVIDER_IDS,
  zcodeDataBaseDir,
  discoverZcodeConnection
};
