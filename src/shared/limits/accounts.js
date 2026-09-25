'use strict';

// The limits account registry index: one account declaration per catalog
// provider, in catalog order. Each declaration lives in
// src/shared/providers/<id>/account.js and is a LEAF module — it must not
// require anything, because credentialStore derives its store paths from this
// index and providers/<id>/limits.js is allowed to require credentialStore
// (factory does). Provider behaviour that needs the limits module (resolvers,
// discovery, status) is declared there as data or as functions that receive the
// bound module; src/shared/limits/registry.js does the binding.
//
// Declaration shape:
//   {
//     id: 'zed',
//     fetch: 'fetchZedLimits',  // limits.js export the collector calls
//     fields: [ ... ],          // settings keys this provider owns
//     status: { ... },          // optional: renderer account-status projection
//     accountStatus(input, limits), // optional: custom status projection
//     discover(env, limits),    // optional: local credential discovery probe
//     envProbe: { key, fn },    // optional: extra env-configured projection key
//     urlPolicy: [ ... ],       // optional: external-URL allowlist rules
//     fetchDep: 'workbuddyFetch',   // optional: deps key consulted before fetch
//     resolveFetch(deps, limits),   // optional: custom transport resolution
//     extraSettingKeys: [ ... ]     // optional: non-field keys that still scope
//                                 // a provider refresh (e.g. feature toggles)
//   }
//
// Field shape:
//   {
//     key: 'zedCookie',         // settings key (also the wire/config key)
//     kind: 'credential' | 'setting' | 'profiles' | 'managed',
//     storePath: ['providers', 'zed', 'cookie'],
//                               // present ⇒ the value lives in credentials.json,
//                               // never settings.json, never the renderer
//     resolve: 'zedCookie',     // limits.js export name of the env resolver
//     resolveStyle: 'options',  // 'options' (default): fn(env, {key: value});
//                               // 'explicit': fn(env, value)
//     normalize: 'secret' | 'trim' | { fn, style } | (value) => value,
//                               // write-time normalizer. Absent ⇒ raw pass-
//                               // through. Default when resolve is set: the
//     // resolver applied to the explicit lane. {fn, style} styles:
//     //   'value'      fn(value)
//     //   'options'    fn({ [key]: value }, {})
//     //   'optionsEnv' fn({ [key]: value }, process.env)
//     envFallback: ['TOKEN_MONITOR_ZED_COOKIE', 'ZED_COOKIE'],
//                               // env names consulted by limitsConfigFromSettings
//                               // after the settings lane, in order
//     configDefault: 'global',  // limitsConfigFromSettings value when neither
//                               // settings nor env produced one (default '')
//     configNormalize: fn,      // limitsConfigFromSettings read-time normalizer
//     contextOverride: true,    // config value is context[key] ?? settings[key]
//     config: false,            // excluded from limitsAccountConfig entirely
//                               // (the provider wires its own config lane)
//     persist: 'default',       // 'default': write normalize + keep old + '';
//                               // 'renormalize': like default but the kept
//                               //   value is re-normalized with persistFallback
//                               // 'spread': patch passes through, no final line
//                               // 'never': deleted from the patch, never stored
//     persistFallback: 'global',// renormalize mode: value fed to normalize when
//                               // the patch does not carry the key
//     project: 'set' | 'redact' | 'value' | (value, limits, env) => projected,
//                               // settingsForRenderer emission. Absent ⇒ the
//                               // raw settings spread carries the key (or ''
//                               // from credential redaction for storePath keys)
//     rendererOmit: true,       // deleted from the renderer settings object
//     watch: false,             // exclude from LIMIT_PROVIDER_SETTING_KEYS
//     initial: value | (env, limits) => value | null
//                               // fresh-install default. Absent ⇒ '' for
//                               // credential/setting, {} for profiles, [] for
//                               // managed. null ⇒ no initial key at all.
//   }
//
// status shape (renderer account-status projection):
//   { credential: 'zedCookie', configuredKey: 'zedCookieConfigured',
//     sourceKey: 'zedCookieSource', pendingKey: 'zedPendingCheckSince' }
// With only `status`, the projection is the standard settings|env two-lane
// source plus a configured flag. `accountStatus` replaces that entirely and
// returns the flat projection map itself.
//
// urlPolicy rule shape:
//   { hosts: ['qoder.com', 'www.qoder.com'],
//     pathPrefixes: ['/settings'],   // optional; absent ⇒ any path
//     exactPaths: ['/x'] }           // optional, checked alongside prefixes

// A provider registers here and nowhere else: its account leaf, plus a lazy
// loader for its limits module. The loader stays unevaluated until
// src/shared/limits/registry.js binds it, so credentialStore (which reads this
// index) never pulls in provider probes — factory/limits.js requires
// credentialStore, and an eager require here would be a cycle.
function registerProvider(account, loadLimits) {
  return { ...account, loadLimits };
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
  registerProvider(require('../providers/zai/account'), () => require('../providers/zai/limits')),
  registerProvider(require('../providers/zaiteam/account'), () => require('../providers/zaiteam/limits')),
  registerProvider(require('../providers/kiro/account'), () => require('../providers/kiro/limits')),
  registerProvider(require('../providers/workbuddy/account'), () => require('../providers/workbuddy/limits')),
  registerProvider(require('../providers/qoder/account'), () => require('../providers/qoder/limits')),
  registerProvider(require('../providers/deepseek/account'), () => require('../providers/deepseek/limits')),
  registerProvider(require('../providers/devin/account'), () => require('../providers/devin/limits')),
  registerProvider(require('../providers/typesafe/account'), () => require('../providers/typesafe/limits')),
  registerProvider(require('../providers/openrouter/account'), () => require('../providers/openrouter/limits')),
  registerProvider(require('../providers/minimax/account'), () => require('../providers/minimax/limits')),
  registerProvider(require('../providers/volcengine/account'), () => require('../providers/volcengine/limits')),
  registerProvider(require('../providers/ollama/account'), () => require('../providers/ollama/limits')),
  registerProvider(require('../providers/trae/account'), () => require('../providers/trae/limits')),
  registerProvider(require('../providers/alibaba/account'), () => require('../providers/alibaba/limits')),
  registerProvider(require('../providers/thirdparty/account'), () => require('../providers/thirdparty/limits'))
].map((decl) => Object.freeze({
  ...decl,
  fields: Object.freeze((decl.fields || []).map((field) => Object.freeze(field)))
})));

function limitAccountDeclaration(provider) {
  return LIMIT_PROVIDER_ACCOUNTS.find((decl) => decl.id === provider) || null;
}

function limitAccountField(provider, key) {
  const decl = limitAccountDeclaration(provider);
  return decl ? decl.fields.find((field) => field.key === key) || null : null;
}

// The credential store's schema for provider-owned keys, derived here so the
// store stays a leaf consumer and a new provider's storePath is declared once.
// Hub keys are not provider fields; credentialStore prepends them itself.
function providerCredentialSettingPaths() {
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
function limitProviderUrlAllowed(hostname, pathname) {
  for (const decl of LIMIT_PROVIDER_ACCOUNTS) {
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

module.exports = {
  LIMIT_PROVIDER_ACCOUNTS,
  limitAccountDeclaration,
  limitAccountField,
  limitProviderSettingKeys,
  limitProviderUrlAllowed,
  providerCredentialSettingPaths
};
