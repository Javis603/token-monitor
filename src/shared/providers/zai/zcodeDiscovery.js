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
// The billing credential (the credential store's zcodejwttoken, or the
// provider entry's mirror on 3.11.x installs) is for in-memory use only —
// never logged, persisted, or handed to the renderer.

const crypto = require('node:crypto');
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

// ZCode 3.12.3 keeps the live session credentials in credentials.json,
// encrypted with AES-256-GCM under a key derived from machine-local values
// (no user secret, no OS keychain — the envelope keeps a synced or backed-up
// file from leaking, it does not gate a same-machine reader). The plaintext
// mirror this lane used to rely on stopped being refreshed with that release,
// so the billing credential is decrypted from the store on every call:
// in memory only, never logged, persisted, or handed to the renderer, and any
// failure falls back to the mirror a 3.11.x install still carries.
const ZCODE_CREDENTIAL_ENVELOPE = 'enc:v1:';

// Same derivation as ZCode's own defaultCredentialSecret: an explicit
// ZCODE_CREDENTIAL_SECRET wins, otherwise machine-local values.
function credentialSecret(env) {
  const explicit = String(env?.ZCODE_CREDENTIAL_SECRET || '').trim();
  if (explicit) return explicit;
  let username = 'unknown';
  try { username = os.userInfo().username; } catch (_) {}
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

// Envelope as ZCode writes it: base64url(iv).base64url(authTag).base64url(cipher).
function decryptZcodeCredential(value, env) {
  if (typeof value !== 'string' || !value.startsWith(ZCODE_CREDENTIAL_ENVELOPE)) return null;
  const [ivPart, tagPart, cipherPart] = value.slice(ZCODE_CREDENTIAL_ENVELOPE.length).split('.');
  if (!ivPart || !tagPart || !cipherPart) return null;
  try {
    const key = crypto.createHash('sha256').update(credentialSecret(env)).digest();
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(cipherPart, 'base64url')), decipher.final()]).toString('utf8');
    return plain || null;
  } catch (_) {
    return null;
  }
}

function storedZcodeJwtCredential(base, readFileSync, env) {
  const store = readJson(path.join(base, 'credentials.json'), readFileSync);
  const token = decryptZcodeCredential(store?.zcodejwttoken, env);
  return token ? { token, source: 'zcode-auto' } : null;
}

// Resolve which credential the billing lane should present. The live store's
// JWT is the ZCode-managed token the server rotates; the provider entry's
// plain mirror is what 3.11.x installations have, and answers as
// syntax/auth errors once stale.
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
    // The credential store is read lazily: a quota-shaped selection only
    // touches it when it needs the billing credential, and at most once per
    // discovery call.
    let storedJwt;
    const liveBillingCredential = () => {
      if (storedJwt === undefined) storedJwt = storedZcodeJwtCredential(base, readFileSync, env);
      return storedJwt;
    };
    const credential = kind === 'start-billing'
      ? liveBillingCredential() || billingCredential(provider)
      : billingCredential(provider);
    // `entitled` marks a result the lane can actually query. Since 3.12.3
    // stopped writing the entitlement cache, a readable credential is the
    // only local signal; the query itself answers entitlement.
    if (!credential) return { kind, family, providerId, entitled: false, reason: 'coding_plan_not_authenticated' };
    // Billing is an account-level endpoint: ZCode queries it even while the
    // coding-plan provider is selected (validateZaiCodingPlanPairAvailability
    // → validateStartPlanAvailability), so the coding shape carries a billing
    // credential alongside its own quota query — the live store's JWT first,
    // the start entry's mirror as the 3.11.x fallback.
    let billing;
    if (kind === 'coding-quota') {
      const startCredential = liveBillingCredential()
        || billingCredential(registry.provider?.[ZCODE_PROVIDER_IDS.startPlan[family]] || null);
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
