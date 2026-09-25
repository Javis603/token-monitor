'use strict';

// The Electron-side read of the limits account registry: every per-provider
// credential behaviour main.js used to hand-wire is derived here from the
// bound declarations in src/shared/limits/registry.js —
//   settings:update      → normalizeAccountPatch + finalAccountSettings
//   settingsForRenderer  → accountFieldProjection + accountStatusProjection
//   fresh-install config → initialAccountSettings
//   limits config        → limitsAccountConfig
// Adding a provider with a simple cookie/API-key account touches none of this
// file; its account.js declaration is the whole change.

const { limitProviderUrlAllowed } = require('../../shared/limits/accounts');
const {
  LIMIT_PROVIDER_REGISTRY,
  limitAccountFieldEntry,
  limitProviderEntry
} = require('../../shared/limits/registry');

function* accountFields() {
  for (const entry of LIMIT_PROVIDER_REGISTRY) {
    for (const field of entry.fields) yield { entry, field };
  }
}

// settings:update — write path. 'never' fields are stripped from the patch
// (they arrive through their own IPC, never the generic settings write);
// everything else is normalized when the patch carries the key. 'spread'
// fields get the same normalization — the mode only means the final literal
// has no explicit line for them, so the normalizedPatch spread is what lands.
function normalizeAccountPatch(patch, normalizedPatch) {
  for (const { field } of accountFields()) {
    if (field.persist === 'never') {
      delete normalizedPatch[field.key];
      continue;
    }
    if (patch?.[field.key] !== undefined) {
      normalizedPatch[field.key] = field.normalize ? field.normalize(patch[field.key]) : patch[field.key];
    }
  }
}

// settings:update — the explicit final-assignments inside the settings literal.
// 'default' fields keep the stored value (or ''), 'renormalize' fields
// re-normalize the stored value against their fallback so a stored default
// stays canonical.
function finalAccountSettings(patch, settings) {
  const out = {};
  for (const { field } of accountFields()) {
    if (field.persist === 'never' || field.persist === 'spread') continue;
    if (patch?.[field.key] !== undefined) {
      out[field.key] = field.normalize ? field.normalize(patch[field.key]) : patch[field.key];
    } else if (field.persist === 'renormalize') {
      out[field.key] = field.normalize(settings?.[field.key] || field.persistFallback);
    } else {
      out[field.key] = settings?.[field.key] || '';
    }
  }
  return out;
}

function redactOpencodeProfilesForRenderer(profiles) {
  if (!profiles || typeof profiles !== 'object') return profiles;
  const out = Object.create(null);
  for (const [name, profile] of Object.entries(profiles)) {
    out[name] = {
      enabled: profile?.enabled !== false,
      cookie: profile?.cookie ? 'set' : '',
      apiKey: profile?.apiKey ? 'set' : ''
    };
  }
  return out;
}

function redactOpenRouterProfilesForRenderer(profiles) {
  if (!profiles || typeof profiles !== 'object') return profiles;
  const out = Object.create(null);
  for (const [name, profile] of Object.entries(profiles)) {
    out[name] = { enabled: profile?.enabled !== false, apiKey: profile?.apiKey ? 'set' : '' };
  }
  return out;
}

function redactThirdPartyProfilesForRenderer(profiles) {
  const thirdPartyLimits = limitProviderEntry('thirdparty').limits;
  if (!profiles || typeof profiles !== 'object') return profiles;
  const out = Object.create(null);
  for (const [name, profile] of Object.entries(profiles)) {
    const adapter = thirdPartyLimits.normalizeAdapterId(profile?.adapter);
    out[name] = {
      enabled: profile?.enabled !== false,
      adapter,
      baseUrl: thirdPartyLimits.normalizeThirdPartyBaseUrl(profile?.baseUrl, {
        stripTerminalV1: adapter !== thirdPartyLimits.CUSTOM_BALANCE_ADAPTER
      }),
      userId: String(profile?.userId || '').trim(),
      ...(adapter === thirdPartyLimits.CUSTOM_BALANCE_ADAPTER
        ? {
            endpointPath: thirdPartyLimits.normalizeCustomEndpointPath(profile?.endpointPath),
            authMode: thirdPartyLimits.normalizeCustomAuthMode(profile?.authMode),
            remainingPath: thirdPartyLimits.normalizeCustomJsonPath(profile?.remainingPath),
            usedPath: thirdPartyLimits.normalizeCustomJsonPath(profile?.usedPath),
            totalPath: thirdPartyLimits.normalizeCustomJsonPath(profile?.totalPath),
            currency: thirdPartyLimits.normalizeCustomCurrency(profile?.currency),
            divisor: thirdPartyLimits.normalizeCustomDivisor(profile?.divisor)
          }
        : {}),
      accessToken: profile?.accessToken ? 'set' : '',
      apiKey: profile?.apiKey ? 'set' : '',
      refreshToken: profile?.refreshToken ? 'set' : ''
    };
  }
  return out;
}

const PROFILE_REDACTORS = Object.freeze({
  opencode: redactOpencodeProfilesForRenderer,
  openrouter: redactOpenRouterProfilesForRenderer,
  thirdparty: redactThirdPartyProfilesForRenderer
});

// settingsForRenderer — per-field value projection. Credential fields emit
// 'set'/'' so the raw secret never crosses; 'redact' profile maps emit a
// field-by-field redacted copy only when present; function projects run the
// declaration's own projector.
function accountFieldProjection(settings, env = process.env) {
  const out = {};
  for (const { entry, field } of accountFields()) {
    const project = field.project;
    if (!project) continue;
    if (project === 'set') {
      out[field.key] = settings?.[field.key] ? 'set' : '';
    } else if (project === 'value') {
      out[field.key] = settings?.[field.key] || '';
    } else if (project === 'redact') {
      if (settings?.[field.key]) out[field.key] = PROFILE_REDACTORS[entry.id](settings[field.key]);
    } else {
      out[field.key] = project(settings?.[field.key], entry.limits, env);
    }
  }
  return out;
}

function defaultAccountStatus(entry, settings, env) {
  const field = entry.fields.find((candidate) => candidate.key === entry.status.credential);
  const stored = settings?.[field.key];
  const resolved = field.resolve ? field.resolve(env) : '';
  return {
    [entry.status.configuredKey]: Boolean(stored || resolved),
    [entry.status.sourceKey]: stored ? 'settings' : resolved ? 'env' : ''
  };
}

// settingsForRenderer — the *Configured/*Source key pairs plus provider extras
// (env probes, discovery-driven lanes like zcode-auto and cline-signin).
function accountStatusProjection(settings, env = process.env) {
  const out = {};
  for (const entry of LIMIT_PROVIDER_REGISTRY) {
    const discovered = entry.discover ? entry.discover(env) : null;
    if (entry.accountStatus) {
      Object.assign(out, entry.accountStatus({ settings, env, discovered }));
    } else if (entry.status) {
      Object.assign(out, defaultAccountStatus(entry, settings, env));
    }
    if (entry.envProbe) out[entry.envProbe.key] = entry.envProbe.probe(env);
  }
  return out;
}

// The effective credential value for IPC handlers: stored setting, else the
// resolver's env lane — the shape every currentXxx() helper used to hand-write.
function currentAccountField(key, settings, env = process.env) {
  const found = limitAccountFieldEntry(key);
  return settings?.[key] || (found?.field.resolve ? found.field.resolve(env) : '');
}

// The write-time normalizer for one settings key, or identity for keys the
// registry does not own.
function normalizeAccountField(key, value) {
  const found = limitAccountFieldEntry(key);
  return found?.field.normalize ? found.field.normalize(value) : value;
}

// The account slice of limitsConfigFromSettings: settings lane, then the
// declared env fallbacks, then the declared default. contextOverride fields
// (managed account lists) prefer the runtime-supplied context value.
function limitsAccountConfig(settings = {}, context = {}) {
  const env = context.env || process.env;
  const out = {};
  for (const { field } of accountFields()) {
    if (field.config === false) continue;
    if (field.contextOverride) {
      out[field.key] = context[field.key] ?? settings[field.key] ?? field.configDefault ?? [];
      continue;
    }
    let value = settings[field.key];
    if (!value) {
      for (const name of field.envFallback || []) {
        value = env[name];
        if (value) break;
      }
    }
    out[field.key] = field.configNormalize
      ? field.configNormalize(value)
      : (value || field.configDefault || '');
  }
  return out;
}

// Fresh-install defaults: the account-owned keys of the initial settings
// literal. null initial ⇒ the key is omitted entirely.
function initialAccountSettings(env = process.env) {
  const out = {};
  for (const { entry, field } of accountFields()) {
    if (field.initial === null) continue;
    if (field.initial !== undefined) {
      out[field.key] = typeof field.initial === 'function' ? field.initial(env, entry.limits) : field.initial;
    } else if (field.kind === 'profiles') {
      out[field.key] = {};
    } else if (field.kind === 'managed') {
      out[field.key] = [];
    } else {
      out[field.key] = '';
    }
  }
  return out;
}

// Keys deleted from the renderer settings object before projection — values
// that must not cross even as 'set' markers.
function rendererOmittedAccountKeys() {
  const keys = [];
  for (const { field } of accountFields()) {
    if (field.rendererOmit) keys.push(field.key);
  }
  return keys;
}

// The renderer only needs the form's display and action schema. Never send
// field declarations, store paths, resolvers, or credential values over IPC.
function limitAccountFormsForRenderer() {
  return LIMIT_PROVIDER_REGISTRY.filter((entry) => entry.form).map((entry) => {
    const { kind, field, input, titleKey, openKey, clearKey, placeholderKey,
      ariaLabelKey, saveKey, emptyKey, failedKey, steps, noteKey, validation, url } = entry.form;
    if (kind !== 'singleCredential' || !['input', 'textarea'].includes(input)
      || !entry.fields.some((candidate) => candidate.key === field && candidate.kind === 'credential')
      || !entry.status?.configuredKey || !entry.status?.sourceKey || !entry.status?.pendingKey) {
      throw new Error(`limits form: invalid single-credential declaration for ${entry.id}`);
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !limitProviderUrlAllowed(parsed.hostname, parsed.pathname)) {
      throw new Error(`limits form: ${entry.id} URL is not allowlisted`);
    }
    if ((!Array.isArray(steps) || !steps.length) && !noteKey) {
      throw new Error(`limits form: missing setup instructions for ${entry.id}`);
    }
    // Every form's credential is probed before it is saved; `validation` only
    // overrides the shared "rejected" message with provider-specific guidance.
    if (validation && (!validation.invalidKey || Object.keys(validation).length !== 1)) {
      throw new Error(`limits form: invalid validation messages for ${entry.id}`);
    }
    const { configuredKey, sourceKey, pendingKey } = entry.status;
    return {
      id: entry.id, kind, field, input, titleKey, openKey, clearKey,
      placeholderKey, ...(ariaLabelKey ? { ariaLabelKey } : {}),
      saveKey, emptyKey, failedKey,
      ...(steps ? { steps: [...steps] } : {}),
      ...(noteKey ? { noteKey } : {}),
      ...(validation ? { validation: { ...validation } } : {}),
      url, status: { configuredKey, sourceKey, pendingKey }
    };
  });
}

module.exports = {
  accountFieldProjection,
  accountStatusProjection,
  currentAccountField,
  finalAccountSettings,
  initialAccountSettings,
  limitAccountFormsForRenderer,
  limitsAccountConfig,
  normalizeAccountField,
  normalizeAccountPatch,
  redactOpencodeProfilesForRenderer,
  redactOpenRouterProfilesForRenderer,
  redactThirdPartyProfilesForRenderer,
  rendererOmittedAccountKeys
};
