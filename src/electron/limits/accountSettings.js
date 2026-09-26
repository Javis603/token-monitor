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

const FORM_INPUTS = new Set(['password', 'text', 'textarea', 'select']);
const FORM_MESSAGE_KEYS = new Set(['rejected', 'invalidFormat', 'required']);

// An account form in its one canonical shape. A single pasted credential may be
// declared with the shorthand `field` + `input` ('input' | 'textarea'), a
// `noteKey` or `steps`, and a `url`; everything else declares `fields`, the
// `top` / `manual` block lists and `openUrl` directly. `custom` forms keep
// their own markup and only borrow the save path, so they carry just `fields`.
function accountForm(entry) {
  const form = entry?.form;
  if (!form) return null;
  if (form.kind === 'custom') {
    return { kind: 'custom', fields: form.fields.map((field) => ({ secret: true, required: false, ...field })) };
  }
  if (form.field) {
    return {
      ...form,
      kind: 'credential',
      fields: [{
        key: form.field,
        input: form.input === 'textarea' ? 'textarea' : 'password',
        placeholderKey: form.placeholderKey,
        ...(form.ariaLabelKey ? { ariaLabelKey: form.ariaLabelKey } : {}),
        required: true,
        secret: true
      }],
      top: [],
      manual: [form.noteKey ? { note: form.noteKey } : { steps: form.steps }, { field: form.field }],
      openUrl: form.openUrl || { url: form.url }
    };
  }
  return {
    ...form,
    kind: 'credential',
    // A select is a setting beside the credential, so Clear leaves it alone.
    fields: form.fields.map((field) => ({ required: false, secret: field.input !== 'select', ...field })),
    top: form.top || [],
    manual: form.manual || []
  };
}

function formUrls(openUrl) {
  if (openUrl?.url) return [openUrl.url];
  return [...Object.values(openUrl?.urls || {}), ...(openUrl?.default ? [openUrl.default] : [])];
}

function assertAccountForm(entry, form) {
  const fail = (reason) => { throw new Error(`limits form: ${reason} for ${entry.id}`); };
  const declared = new Map(entry.fields.map((field) => [field.key, field]));
  if (!form.fields.length) fail('no fields');
  for (const field of form.fields) {
    if (!declared.has(field.key)) fail(`undeclared field ${field.key}`);
    if (form.kind === 'credential' && !FORM_INPUTS.has(field.input)) fail(`invalid input for ${field.key}`);
    if (field.input === 'select' && !field.options?.length) fail(`select ${field.key} without options`);
  }
  if (!form.fields.some((field) => field.secret && declared.get(field.key).kind === 'credential')) {
    fail('no credential field');
  }
  if (!entry.status?.configuredKey || !entry.status?.sourceKey || !entry.status?.pendingKey) fail('incomplete status');
  if (Object.keys(form.messages || {}).some((key) => !FORM_MESSAGE_KEYS.has(key))) fail('unknown message override');
  if (form.kind === 'custom') return;
  const blocks = [...form.top, ...form.manual];
  const placed = blocks.filter((block) => block.field).map((block) => block.field);
  if (placed.length !== form.fields.length || form.fields.some((field) => !placed.includes(field.key))) {
    fail('every field must be placed exactly once');
  }
  if (!blocks.some((block) => block.note || block.steps?.length)) fail('missing setup instructions');
  const urls = formUrls(form.openUrl);
  if (!urls.length) fail('missing openUrl');
  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !limitProviderUrlAllowed(parsed.hostname, parsed.pathname, entry.id)) {
      fail(`URL ${url} is not allowlisted`);
    }
  }
}

// The renderer only needs the form's display and action schema. Never send
// field declarations, store paths, resolvers, or credential values over IPC.
function limitAccountFormsForRenderer() {
  return LIMIT_PROVIDER_REGISTRY.filter((entry) => entry.form).flatMap((entry) => {
    const form = accountForm(entry);
    assertAccountForm(entry, form);
    if (form.kind === 'custom') return [];
    const { configuredKey, sourceKey, pendingKey } = entry.status;
    return [JSON.parse(JSON.stringify({
      id: entry.id,
      kind: form.kind,
      titleKey: form.titleKey,
      openKey: form.openKey,
      clearKey: form.clearKey,
      saveKey: form.saveKey,
      emptyKey: form.emptyKey,
      failedKey: form.failedKey,
      fields: form.fields,
      top: form.top,
      manual: form.manual,
      openUrl: form.openUrl,
      ...(form.messages ? { messages: form.messages } : {}),
      status: { configuredKey, sourceKey, pendingKey }
    }))];
  });
}

module.exports = {
  accountForm,
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
