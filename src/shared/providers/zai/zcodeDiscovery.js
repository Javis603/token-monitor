'use strict';

// Read-only discovery of the locally installed ZCode desktop app's connection
// state. ZCode persists its provider registry and current selection under
// ~/.zcode/v2/ as plain JSON; this module reads those files on every call (no
// caching — the on-disk state is the source of truth for account switches,
// mirroring how codexAuth re-reads auth.json each refresh) and derives which
// GLM quota lane applies: the Coding Plan subscription quota endpoint, the
// ZCode Start/Weekend plan billing endpoint, or neither.
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

// api.z.ai endpoints imply the global family; anything else ZCode treats as
// BigModel-like. Mirrors ZCode's own resolveModelProviderFamilyIdByBaseURL.
function familyByBaseUrl(baseUrl) {
  return /api\.z\.ai|api\.chatglm\.site/i.test(String(baseUrl || '')) ? 'zai' : 'bigmodel';
}

function selectedProviderId(settings, family) {
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

function entryStatusFor(cache, providerId) {
  return cache?.entryStatus?.items?.[providerId] || null;
}

// Resolve which credential the billing lane should present. ZCode stores its
// login token encrypted in credentials.json (unreadable to us) and mirrors a
// plain JWT into the provider entry; the mirror is the only readable key, and
// ZCode rotates it on each login, so a stale mirror is answered by the server
// as a parameter/auth error and surfaces as unavailable until ZCode refreshes.
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
  // ZCode persists a family switch across two writes: setting.json flips
  // first, the provider entry (key mirror, enabled flag) lands after. A
  // disabled entry means the switch has not settled — skip this round and let
  // the next refresh read the completed state instead of showing a torn one.
  if (!provider || provider.enabled === false) return { kind: 'none' };

  if (isStartPlanProviderId(providerId) || isCodingPlanProviderId(providerId)) {
    const entry = entryStatusFor(readJson(path.join(base, 'coding-plan-cache.json'), readFileSync), providerId);
    const entitled = entry?.status === 'available';
    const reason = entitled ? '' : String(entry?.reason || 'coding_plan_not_entitled');
    const kind = isStartPlanProviderId(providerId) ? 'start-billing' : 'coding-quota';
    // credential is present whenever an entitled plan has a readable mirror
    // key; coding-quota consumers use it against the quota endpoint the same
    // way start-billing consumers use it against the billing endpoint.
    const credential = entitled ? billingCredential(provider) : null;
    if (entitled && !credential) {
      return { kind, family, providerId, entitled: false, reason: 'coding_plan_not_authenticated' };
    }
    return { kind, family, providerId, entitled, reason, ...(credential ? { credential } : {}) };
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
