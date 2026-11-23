// @ts-check
'use strict';

const { normalizeLimitProductId } = require('./products');
const { defaultIdentityKey, accountSlotField, normalizeAmbientAccounts } = require('./accountSlots');

// The limits account registry index: one account declaration per catalog
// provider, in catalog order. Each declaration lives in
// src/shared/providers/<id>/account.js and is a LEAF module — it must not
// require anything, because credentialStore derives its store paths from this
// index and providers/<id>/limits.js is allowed to require credentialStore
// (factory does). Provider behaviour that needs the limits module (resolvers,
// discovery, status) is declared there as data or as functions that receive the
// bound module; src/shared/limits/registry.js does the binding.
//
/**
 * Provider limits modules have heterogeneous exports and legacy value shapes.
 * These dynamic callback boundaries remain explicit; declaration keys and
 * declarative metadata below are closed shapes, with no catch-all index key.
 * @typedef {Record<string, any>} AccountValues
 * @typedef {Record<string, any>} AccountLimits
 *
 * @typedef {object} AccountField
 * @property {string} key Settings key (also the wire/config key).
 * @property {'credential'|'setting'|'profiles'|'managed'} kind
 * @property {string[]} [storePath] Lives in credentials.json, never settings.json or the renderer.
 * @property {string} [resolve] Limits module export; also the default write normalizer.
 * @property {'options'|'explicit'} [resolveStyle] Default: fn(env, {[key]: value}); explicit: fn(env, value).
 * @property {'secret'|'trim'|{fn: string, style: 'value'|'options'|'optionsEnv'}|((value: any) => any)} [normalize] Write-time normalizer; otherwise raw pass-through. Named styles call fn(value), fn({[key]: value}, {}), or fn({[key]: value}, process.env).
 * @property {string[]} [envFallback] Consulted after settings, in order.
 * @property {any} [configDefault] Read-time default when settings and env are absent (otherwise '').
 * @property {(value: any) => any} [configNormalize] Read-time normalization.
 * @property {boolean} [contextOverride] Config uses context[key] ?? settings[key].
 * @property {boolean} [config] False excludes this field from limitsAccountConfig.
 * @property {'default'|'renormalize'|'spread'|'never'} [persist] Default normalizes, keeps old, then ''; renormalize also normalizes the kept value; spread passes through; never deletes from the patch.
 * @property {any} [persistFallback] Value fed to normalize when a renormalize patch omits the key.
 * @property {'set'|'redact'|'value'|((value: any, limits: AccountLimits, env: AccountValues) => any)} [project] Renderer emission; absent keeps the raw spread (or credential redaction).
 * @property {boolean} [rendererOmit] Delete from renderer settings.
 * @property {boolean} [watch] False excludes the key from refresh triggers.
 * @property {string|number|boolean|null|AccountValues|any[]|((env: AccountValues, limits: AccountLimits) => any)} [initial] Absent defaults to '' / {} / [] by kind; null omits the initial key.
 * @property {boolean} [clearWithCredential] Clear this setting alongside credentials.
 *
 * @typedef {object} AccountStatus
 * @property {string} [credential]
 * @property {string} configuredKey
 * @property {string} sourceKey
 * @property {string} [pendingKey]
 *
 * @typedef {object} AccountUrlRule
 * @property {string[]} hosts
 * @property {string[]} [pathPrefixes] Absent both path lists means any path; lists are checked together.
 * @property {string[]} [exactPaths]
 *
 * @typedef {{byField: string, values: Record<string, string>}} AccountFormValue
 * @typedef {string|Array<string|{code: string|AccountFormValue}|{text: string}>} AccountFormStep
 * @typedef {object} AccountFormBlock
 * @property {string} [field]
 * @property {AccountFormStep[]} [steps]
 * @property {string} [note]
 * @property {{field: string, values: string[]}} [when]
 * @property {string} [whenCredential]
 *
 * @typedef {object} AccountFormField
 * @property {string} key
 * @property {'input'|'text'|'password'|'textarea'|'select'} [input]
 * @property {string} [labelKey]
 * @property {string} [ariaLabelKey]
 * @property {string} [placeholderKey]
 * @property {string} [placeholder]
 * @property {string} [configuredKey]
 * @property {{value: string, labelKey: string}[]} [options]
 * @property {boolean} [saveOnChange]
 * @property {string[]} [clears]
 * @property {boolean} [required]
 * @property {boolean} [prefill]
 * @property {boolean} [secret]
 * @property {boolean} [submitWithCredential]
 *
 * @typedef {object} AccountForm
 * @property {'custom'} [kind] Custom panels may borrow only the shared save path.
 * @property {{labelKey: string}} [loginAction]
 * @property {string} [titleKey]
 * @property {string} [openKey]
 * @property {string} [clearKey]
 * @property {string} [saveKey]
 * @property {string} [emptyKey]
 * @property {string} [failedKey]
 * @property {string} [field] Legacy single-field form.
 * @property {'input'|'text'|'password'|'textarea'|'select'} [input]
 * @property {string} [placeholderKey]
 * @property {string} [ariaLabelKey]
 * @property {string} [noteKey]
 * @property {string} [url]
 * @property {AccountFormStep[]} [steps]
 * @property {AccountFormField[]} [fields]
 * @property {AccountFormBlock[]} [manual]
 * @property {AccountFormBlock[]} [top]
 * @property {{url?: string, byField?: string, byStatus?: string, urls?: Record<string, string>, statusUrls?: Record<string, string>, default?: string, pathByField?: AccountFormValue}} [openUrl]
 * @property {{required?: string, invalidFormat?: string, rejected?: string}} [messages]
 * @property {boolean} [multipleAccounts]
 * @property {{fn: string, credential: string, selection: string}} [discover]
 * @property {{key: string, labelKey: string, fields: string[]}} [credentialChoice]
 * @property {{fn: string, field: string}} [rememberProbe]
 *
 * @typedef {object} DiscoveredAccount
 * @property {AccountValues} values In-memory form-shaped credentials, never persisted.
 * @property {string} sourceName Fallback display name and sign-out location.
 * @property {string} [accountKey]
 * @property {string} [accountName]
 * @property {string} [accountEmail]
 * @property {AccountValues} [fetchDeps] Provider-owned isolated dispatch dependencies.
 * @property {boolean} [combineMatchingCredential] Preserve a combined pool fetch for an exact form-value match.
 * @property {AccountValues} [combinedFetchDeps]
 *
 * @typedef {object} AccountSource
 * @property {string} id Stable, provider-local read lane.
 * @property {'cli'|'desktop'|'web'|'apiKey'|'env'|'file'|'oauth'} kind
 * @property {'alternative'|'complement'|'single'} relation Alternative lanes follow fallback order; complements may contribute together.
 * @property {string[]} products Stable provider-local entitlement IDs, independent of source and region.
 * @property {string} labelKey
 * @property {string} descriptionKey
 *
 * @typedef {object} AccountDeclaration
 * @property {string} id
 * @property {AccountSource[]} sources Ordered read sources.
 * @property {boolean} [environmentWhenSaved]
 * @property {boolean} [dedupeAccounts]
 * @property {string} fetch Limits export called by the collector.
 * @property {AccountField[]} fields
 * @property {string[]} [accountCredentialKeys] Ordered independently authenticating credentials; companions are never cleared.
 * @property {(values: Record<string, string>, key: string) => boolean} [accountCredentialReady] Compound credential completeness check.
 * @property {boolean} [accountSlotOwner] Provider owns authentication and collector union; slots persist main-only owner records.
 * @property {boolean} [accountSlots] Requires a form, no managed/profiles fields, credentials only from declared fields, no singleton credential write-back, and an audit of module-level state.
 * @property {(env: AccountValues, limits: AccountLimits, deps: AccountValues) => DiscoveredAccount[]} [discoveredAccounts] Ephemeral main-only credentials; never projected or saved.
 * @property {string} [serverAccountKey] Limits export testing whether a resolved key proves a server identity.
 * @property {boolean} [accountRefresh] Fetch honors account-scoped limitRefreshScope and returns only that row.
 * @property {AccountStatus} [status] Standard settings/env source and configured flag.
 * @property {(input: {settings: AccountValues, env: AccountValues, limits: AccountLimits, discovered?: any}) => AccountValues} [accountStatus] Replaces standard status with a flat projection map.
 * @property {(env: AccountValues, limits: AccountLimits) => any} [discover] Local credential discovery.
 * @property {{key: string, fn: (env: AccountValues, limits: AccountLimits) => boolean}} [envProbe]
 * @property {AccountUrlRule[]} [urlPolicy]
 * @property {string} [fetchDep] Dependency key consulted before fetching.
 * @property {(deps: AccountValues, limits: AccountLimits) => any} [resolveFetch]
 * @property {string[]} [extraSettingKeys] Non-field keys that scope refresh (such as feature toggles).
 * @property {AccountForm} [form]
 */

// A provider registers here and nowhere else: its account leaf, plus a lazy
// loader for its limits module. The loader stays unevaluated until
// src/shared/limits/registry.js binds it, so credentialStore (which reads this
// index) never pulls in provider probes — factory/limits.js requires
// credentialStore, and an eager require here would be a cycle.
/** @param {AccountDeclaration} account @param {() => AccountLimits} loadLimits */
function registerProvider(account, loadLimits) {
  for (const source of account.sources) {
    if (!Array.isArray(source.products) || !source.products.length
      || new Set(source.products).size !== source.products.length
      || source.products.some(id => !id || normalizeLimitProductId(id) !== id)) {
      throw new Error(`limits accounts: invalid source products for ${account.id}:${source.id}`);
    }
  }
  return { ...account, fields: [...(account.accountSlots ? [...account.fields, accountSlotField(account), ...(account.discoveredAccounts ? [{ key: `${account.id}AmbientAccounts`, kind: 'setting', configDefault: {}, configNormalize: (/** @type {any} */ value) => normalizeAmbientAccounts(account, value), storePath: ['providers', account.id, 'ambientAccounts'], rendererOmit: true, persist: 'never', initial: null, watch: false }] : []), { key: defaultIdentityKey(account), kind: 'setting', configDefault: {}, storePath: ['providers', account.id, 'defaultAccountIdentity'], persist: 'never', rendererOmit: true, watch: false, initial: null }] : account.fields)], loadLimits };
}

const LIMIT_PROVIDER_ACCOUNTS = Object.freeze([
  registerProvider(require('../providers/claude/account'), () => require('../providers/claude/limits')),
  registerProvider(require('../providers/codex/account'), () => require('../providers/codex/limits')),
  registerProvider(require('../providers/opencode/account'), () => require('../providers/opencode/limits')),
  registerProvider(require('../providers/cursor/account'), () => require('../providers/cursor/limits')),
  registerProvider(require('../providers/antigravity/account'), () => require('../providers/antigravity/limits')),
  registerProvider(require('../providers/cline/account'), () => require('../providers/cline/limits')),
  registerProvider(require('../providers/factory/account'), () => require('../providers/factory/limits')),
  registerProvider(require('../providers/kimi/account'), () => require('../providers/kimi/limits')),
  registerProvider(require('../providers/grok/account'), () => require('../providers/grok/limits')),
  registerProvider(require('../providers/copilot/account'), () => require('../providers/copilot/limits')),
  registerProvider(require('../providers/zed/account'), () => require('../providers/zed/limits')),
  registerProvider(require('../providers/commandcode/account'), () => require('../providers/commandcode/limits')),
  registerProvider(require('../providers/mimo/account'), () => require('../providers/mimo/limits')),
  registerProvider(require('../providers/muse/account'), () => require('../providers/muse/limits')),
  registerProvider(require('../providers/zai/account'), () => require('../providers/zai/limits')),
  registerProvider(require('../providers/zaiteam/account'), () => require('../providers/zaiteam/limits')),
  registerProvider(require('../providers/kiro/account'), () => require('../providers/kiro/limits')),
  registerProvider(require('../providers/workbuddy/account'), () => require('../providers/workbuddy/limits')),
  registerProvider(require('../providers/qoder/account'), () => require('../providers/qoder/limits')),
  registerProvider(require('../providers/deepseek/account'), () => require('../providers/deepseek/limits')),
  registerProvider(require('../providers/devin/account'), () => require('../providers/devin/limits')),
  registerProvider(require('../providers/minimax/account'), () => require('../providers/minimax/limits')),
  registerProvider(require('../providers/mistral/account'), () => require('../providers/mistral/limits')),
  registerProvider(require('../providers/typesafe/account'), () => require('../providers/typesafe/limits')),
  registerProvider(require('../providers/openrouter/account'), () => require('../providers/openrouter/limits')),
  registerProvider(require('../providers/volcengine/account'), () => require('../providers/volcengine/limits')),
  registerProvider(require('../providers/ollama/account'), () => require('../providers/ollama/limits')),
  registerProvider(require('../providers/trae/account'), () => require('../providers/trae/limits')),
  registerProvider(require('../providers/alibaba/account'), () => require('../providers/alibaba/limits')),
  registerProvider(require('../providers/stepfun/account'), () => require('../providers/stepfun/limits')),
  registerProvider(require('../providers/notion/account'), () => require('../providers/notion/limits')),
  registerProvider(require('../providers/manus/account'), () => require('../providers/manus/limits')),
  registerProvider(require('../providers/hark/account'), () => require('../providers/hark/limits')),
  registerProvider(require('../providers/opendesign/account'), () => require('../providers/opendesign/limits')),
  registerProvider(require('../providers/thirdparty/account'), () => require('../providers/thirdparty/limits'))
].map((decl) => Object.freeze({
  ...decl,
  fields: Object.freeze((decl.fields || []).map((field) => Object.freeze(field)))
})));

/** @param {string} provider */
function limitAccountDeclaration(provider) {
  return LIMIT_PROVIDER_ACCOUNTS.find((decl) => decl.id === provider) || null;
}

/** @param {string} provider @param {string} key */
function limitAccountField(provider, key) {
  const decl = limitAccountDeclaration(provider);
  return decl ? decl.fields.find((field) => field.key === key) || null : null;
}

// The credential store's schema for provider-owned keys, derived here so the
// store stays a leaf consumer and a new provider's storePath is declared once.
// Hub keys are not provider fields; credentialStore prepends them itself.
function providerCredentialSettingPaths() {
  /** @type {Record<string, string[]>} */
  const paths = {};
  for (const decl of LIMIT_PROVIDER_ACCOUNTS) {
    for (const field of decl.fields) {
      if (field.storePath) paths[field.key] = field.storePath;
    }
  }
  return paths;
}

// Settings keys whose change scopes a limits refresh to this provider.
function limitProviderSettingKeys() {
  /** @type {Record<string, string[]>} */
  const keys = {};
  for (const decl of LIMIT_PROVIDER_ACCOUNTS) {
    const watched = decl.fields
      .filter((field) => field.watch !== false)
      .map((field) => field.key)
      .concat(decl.extraSettingKeys || []);
    if (watched.length > 0) keys[decl.id] = watched;
  }
  return keys;
}

// The provider-owned slice of isAllowedExternalUrl: an allowlist of
// host + path rules, one entry per console page a settings panel links to.
// `providerId` narrows the check to that provider's own policy, so a form can
// prove its pages pass its own rules rather than the union of everyone's.
/** @param {string} hostname @param {string} pathname @param {string} [providerId] */
function limitProviderUrlAllowed(hostname, pathname, providerId = '') {
  const decls = providerId
    ? LIMIT_PROVIDER_ACCOUNTS.filter((decl) => decl.id === providerId)
    : LIMIT_PROVIDER_ACCOUNTS;
  for (const decl of decls) {
    for (const rule of decl.urlPolicy || []) {
      if (!rule.hosts.includes(hostname)) continue;
      const noPathRule = !rule.pathPrefixes && !rule.exactPaths;
      if (noPathRule
        || (rule.pathPrefixes || []).some((prefix) => pathname.startsWith(prefix))
        || (rule.exactPaths || []).some((exact) => pathname === exact)) {
        return true;
      }
    }
  }
  return false;
}

// The refresh scope for one rendered limits row. LimitsRuntime files every row
// an account-scoped probe returns under its reported identity, so the scope may
// only name an account when the provider's fetch filters by it, and only by
// its account key: providers' name- or email-only paths can fall back to
// reading every account. Anything else refreshes the whole provider instead.
/** @param {string} provider @param {{accountKey?: string, accountEmail?: string, accountName?: string, accountLabel?: string, sourceDetail?: string, region?: string}} [row] */
function limitAccountRefreshScope(provider, row = {}) {
  /** @param {unknown} value */
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  /** @type {Record<string, string>} */
  const scope = { provider };
  const declaration = limitAccountDeclaration(provider);
  if (!declaration?.accountRefresh && !(declaration?.accountSlots && !declaration.accountSlotOwner)) return scope;
  const account = {
    accountKey: text(row.accountKey),
    accountEmail: text(row.accountEmail).toLowerCase(),
    accountName: text(row.accountName),
    accountLabel: text(row.accountLabel),
    sourceDetail: text(row.sourceDetail)
  };
  if (!account.accountKey) return scope;
  for (const [key, value] of Object.entries(account)) if (value) scope[key] = value;
  if (provider === 'alibaba' && text(row.region)) scope.region = text(row.region).toLowerCase();
  return scope;
}

module.exports = {
  LIMIT_PROVIDER_ACCOUNTS,
  limitAccountDeclaration,
  limitAccountRefreshScope,
  limitAccountField,
  limitProviderSettingKeys,
  limitProviderUrlAllowed,
  providerCredentialSettingPaths
};
