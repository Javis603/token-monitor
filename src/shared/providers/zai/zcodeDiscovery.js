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
// The credential a lane ends up querying with — a credential-store entry on
// 3.12.3+, or the provider entry's plaintext mirror on 3.11.x installs — is
// for in-memory use only: never logged, persisted, or handed to the renderer.

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
// migration); both plan kinds resolve to the builtin:* entry whose account the
// credential is resolved for — the store's key where it exists, that entry's
// mirror otherwise. That field's schema accepts exactly three kinds; an
// off-peak account is an access mode on the provider entry
// (config.access.mode), never a selection, and a kind this map does not know
// maps to nothing rather than falling back to a frozen legacy selection.
const SELECTION_KIND_SLOT = Object.freeze({
  'start-plan': 'startPlan',
  'individual-coding-plan': 'codingPlan',
  'team-coding-plan': 'codingPlan'
});

// api.z.ai endpoints imply the global family; anything else is treated as
// BigModel-like. ZCode's own table keys each family on a registered root domain
// (z.ai, bigmodel.cn); this is an independent host test over the entry's
// baseURL that defaults to bigmodel, and it only labels a lane discovery has
// already declined to query.
function familyByBaseUrl(baseUrl) {
  return /api\.z\.ai|api\.chatglm\.site/i.test(String(baseUrl || '')) ? 'zai' : 'bigmodel';
}

// Resolve the selected provider entry. 3.12.3 writes the kind-based selection
// and leaves the legacy key string in place without updating it, so the new
// field wins whenever it exists; the legacy string only serves 3.11.x
// installs. An unrecognised kind yields no lane rather than a stale fallback.
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

// ZCode 3.12.3+ keeps the live session credentials in credentials.json,
// encrypted with AES-256-GCM under a key derived from machine-local values
// (no user secret, no OS keychain — the envelope keeps a synced or backed-up
// file from leaking, it does not gate a same-machine reader). The plaintext
// mirror this lane used to rely on stopped being refreshed with that release
// (the layout, entry naming and secret derivation are verified against 3.12.3
// and 3.14.0), so the billing credential is decrypted from the store on every
// call:
// in memory only, never logged, persisted, or handed to the renderer, and any
// failure falls back to the mirror a 3.11.x install still carries.
const ZCODE_CREDENTIAL_ENVELOPE = 'enc:v1:';

// Same derivation as ZCode's own defaultCredentialSecret: an explicit
// ZCODE_CREDENTIAL_SECRET wins, otherwise machine-local values. The machine
// string is derived once per process — its inputs (platform, home directory,
// account name) cannot change under it — because the first os.userInfo() call
// consults the directory service (measured ~1 ms on macOS, and that service
// can be arbitrarily slow on a managed machine) while the derivation itself
// would otherwise run once per decrypted entry.
let machineCredentialSecret = null;
function credentialSecret(env) {
  const explicit = String(env?.ZCODE_CREDENTIAL_SECRET || '').trim();
  if (explicit) return explicit;
  if (machineCredentialSecret === null) {
    // Only a successful derivation is kept: caching the "unknown" fallback
    // would pin one transient directory-service failure for the whole process,
    // and on a machine with no mirror every later decrypt would keep failing.
    try {
      machineCredentialSecret = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
    } catch (_) {
      return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:unknown`;
    }
  }
  return machineCredentialSecret;
}

// Envelope as ZCode writes it: base64url(iv).base64url(authTag).base64url(cipher).
function decryptZcodeCredential(value, env) {
  if (typeof value !== 'string' || !value.startsWith(ZCODE_CREDENTIAL_ENVELOPE)) return null;
  const [ivPart, tagPart, cipherPart] = value.slice(ZCODE_CREDENTIAL_ENVELOPE.length).split('.');
  if (!ivPart || !tagPart || !cipherPart) return null;
  try {
    // ZCode derives every store entry with sha256, and its store can only be
    // decrypted by reproducing that derivation — a slower KDF would break
    // interop rather than harden anything here.
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

function readCredentialStore(base, readFileSync) {
  return readJson(path.join(base, 'credentials.json'), readFileSync);
}

function storedZcodeJwtCredential(store, env) {
  const token = decryptZcodeCredential(store?.zcodejwttoken, env);
  return token ? { token, source: 'zcode-auto' } : null;
}

// The selected account's own coding key, mirrored by ZCode into the credential
// store under a name built from the provider id and the logged-in identity
// (its accountProviderCredentialKey). That identity is what ZCode's
// loadAccountIdentity hands the key builder — loadUserProfile()?.id — and the
// field carrying it depends on the family, because saveUserProfile unwraps a
// zai profile down to its raw user-info document: zai keeps it in `user_id`,
// every other family stores the normalized profile where it is `id`. Reading
// one spelling and not the other would leave that family's accounts on the
// mirror forever; no third spelling is consulted, so a machine that has held
// several accounts can never surface a previous one's key by accident.
// An unknown identity (no store, unreadable profile, no usable identity field)
// resolves to null and the caller falls back to the mirror. An identity that is
// established while its entry is absent is reported instead, because a mirror
// there may still name a previous account; an entry that is present but cannot
// be decrypted stays a null, which is the decrypt-failure degradation.
function storedAccountKeyCredential(store, env, { family, selectionKind }) {
  if (!store || !family || !selectionKind) return null;
  const profileJson = decryptZcodeCredential(store[`oauth:${family}:user_info`], env);
  if (!profileJson) return null;
  let identity;
  try {
    const profile = JSON.parse(profileJson);
    // Reads the document the way ZCode's own loadUserProfileFromKey does: a
    // stored normalized profile (id, username, displayName) is taken as it
    // stands, and only a zai document is mapped from its raw user-info field.
    // That is where the two spellings come from — a zai profile keeps the
    // identity in `user_id`, every other family in `id` — so this stays a
    // reading of ZCode's own rule rather than a field preference of ours.
    const normalizedProfile = typeof profile?.id === 'string'
      && typeof profile?.username === 'string'
      && typeof profile?.displayName === 'string';
    const identityField = normalizedProfile ? profile.id : (family === 'zai' ? profile?.user_id : '');
    identity = typeof identityField === 'string' ? identityField.trim() : '';
  } catch (_) {
    return null;
  }
  if (!identity) return null;
  // Mirrors ZCode's accountProviderCredentialKey: `account:${providerId}` for
  // the plan kind, then the identity percent-encoded the way it writes it.
  const keyName = `account-provider:coding-plan:account:${family}-${selectionKind}:account:${encodeURIComponent(identity)}:api-key`;
  if (store[keyName] === undefined) return { identityWithoutKey: identity };
  const token = decryptZcodeCredential(store[keyName], env);
  return token ? { token, source: 'zcode-auto' } : null;
}

// Resolve the provider entry's plaintext mirror credential: what 3.11.x
// installations carry, and the fallback wherever the credential store cannot
// be read. A stale mirror answers as a syntax/auth error.
function billingCredential(provider) {
  const providerKey = String(provider?.options?.apiKey || '').trim();
  if (providerKey) return { token: providerKey, source: 'zcode-auto' };
  return null;
}

// ZCode resolves its data base as env ZCODE_DATA_BASE_DIR, then HOME, then
// os.homedir() — join(<base>, '.zcode', 'v2'). Mirrors that chain so an
// env-redirected install is found, the same way CODEX_HOME redirects the Codex
// roots. ZCODE_WINDOWS_APP_INSTALL_DIR is deliberately absent from it: ZCode
// declares that constant and nothing reads it (verified in 3.12.3 and 3.14.0,
// in the app and in the CLI it bundles), and it names the install directory
// rather than the data base — honouring it would look in the wrong place on a
// Windows install that sets it and lose the lane silently.
function zcodeDataBaseDir(env = process.env, homeDir = os.homedir()) {
  const fromEnv = String(env.ZCODE_DATA_BASE_DIR || '').trim();
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
    // The kind as written (individual/team/start-plan…), needed to name the
    // account's own store entry; a 3.11.x install has none and falls through
    // to the mirror.
    const selectionKind = String(settings?.providerFamilyConnectionSelections?.[family]?.kind || '').trim();
    // The credential store is read at most once per discovery call, and only
    // when a lane actually needs it.
    let storeCache;
    const readStore = () => {
      if (storeCache === undefined) storeCache = readCredentialStore(base, readFileSync);
      return storeCache;
    };
    const liveBillingCredential = () => storedZcodeJwtCredential(readStore(), env);
    // Billing is an account-level endpoint: ZCode queries it even while the
    // coding-plan provider is selected, because its family pass validates every
    // plan provider the family has (validateFamilyAccountProviders) and the
    // start-plan leg of that pass is the billing call
    // (validateStartPlanAvailability). So the coding shape carries a billing
    // credential alongside its own quota query — the live store's JWT first,
    // the start entry's mirror as the 3.11.x fallback — and that leg resolves
    // on its own credential, never on the quota half's.
    const codingBillingLeg = () => {
      const startCredential = liveBillingCredential()
        || billingCredential(registry.provider?.[ZCODE_PROVIDER_IDS.startPlan[family]] || null);
      return startCredential ? { credential: startCredential } : null;
    };
    // The account key is looked up only for the quota lane: a start-plan
    // selection needs the account-level JWT alone, so it must not touch the
    // profile entry at all. Where the quota lane does read it, the selection's
    // own key wins over the entry's mirror — on a machine that has switched
    // accounts the mirror still belongs to whoever wrote it last under 3.11.x,
    // while the store entry names the logged-in account. The mirror is the
    // fallback wherever no credential can be established — no store, no
    // identity, a profile or entry that fails to read or decrypt, a 3.11.x
    // install — with one exception: once the identity is known, an absent entry
    // means the lane has no credential, because a mirror there cannot be shown
    // to belong to that account.
    let credential;
    if (kind === 'start-billing') {
      credential = liveBillingCredential() || billingCredential(provider);
    } else {
      const accountKey = storedAccountKeyCredential(readStore(), env, { family, selectionKind });
      if (accountKey?.identityWithoutKey) {
        // The account is known but its own key is absent, so the quota half
        // must not ride a mirror that may belong to the previous account. The
        // billing credential is a different one — the account-level JWT, which
        // ZCode maintains on login — so that leg keeps resolving here: refusing
        // the quota credential must not take Start/Weekend down with it.
        const billing = codingBillingLeg();
        return {
          kind, family, providerId, entitled: false, reason: 'coding_plan_key_missing',
          ...(billing ? { billing } : {})
        };
      }
      credential = accountKey || billingCredential(provider);
    }
    // `entitled` marks a result the lane can actually query. Since 3.12.3
    // stopped writing the entitlement cache, a readable credential is the
    // only local signal; the query itself answers entitlement.
    if (!credential) return { kind, family, providerId, entitled: false, reason: 'coding_plan_not_authenticated' };
    const billing = kind === 'coding-quota' ? codingBillingLeg() : null;
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
