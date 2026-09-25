'use strict';

// The limits provider registry: binds each provider's account declaration
// (src/shared/providers/<id>/account.js, pure data) to its limits module
// (src/shared/providers/<id>/limits.js, behaviour). Everything that used to be
// hand-wired per provider — the collector's fetcher table, the settings
// normalizer matrix, the credential projection, the external-URL allowlist —
// is derived from these entries instead.
//
// This module is shared/ but Node-side: it loads every provider limits module,
// several of which use Node built-ins. It is deliberately NOT in the Worker
// vendored closure (scripts/hub-build-manifest.js); the Worker only needs
// limitProviders.js and limits/core.js.

const { LIMIT_PROVIDER_ACCOUNTS } = require('./accounts');

// Each accounts.js entry carries a lazy loader for its limits module; binding
// evaluates it here, so the provider id is written once, in accounts.js.
const LIMIT_PROVIDER_MODULES = Object.freeze(Object.fromEntries(
  LIMIT_PROVIDER_ACCOUNTS.map((decl) => [decl.id, decl.loadLimits()])
));

// Trims surrounding whitespace and one layer of surrounding quotes — the
// normalizer for pasted secrets that have no provider-specific shape.
function normalizeSecretSetting(value) {
  let raw = String(value || '').trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

function bindNormalizeSpec(spec, field, limits) {
  if (spec === 'secret') return normalizeSecretSetting;
  if (spec === 'trim') return (value) => String(value || '').trim();
  if (typeof spec === 'function') return spec;
  if (spec && typeof spec === 'object') {
    const fn = limits[spec.fn];
    if (typeof fn !== 'function') {
      throw new Error(`limits registry: ${field.key} normalize references missing export ${spec.fn}`);
    }
    if (spec.style === 'value') return (value) => fn(value);
    if (spec.style === 'optionsEnv') return (value) => fn({ [field.key]: value }, process.env);
    return (value) => fn({ [field.key]: value }, {});
  }
  return null;
}

function bindField(field, limits) {
  const resolver = field.resolve ? limits[field.resolve] : null;
  if (field.resolve && typeof resolver !== 'function') {
    throw new Error(`limits registry: ${field.key} resolve references missing export ${field.resolve}`);
  }
  const bound = { ...field };
  if (resolver) {
    // The env lane is always resolver(env); the settings lane is the stored
    // value itself, so the resolver's option style only matters when the same
    // function doubles as the write-time normalizer.
    bound.resolve = (env = process.env) => resolver(env);
    if (field.resolveStyle === 'explicit') {
      bound.resolverNormalize = (value) => resolver({}, String(value || ''));
    } else {
      bound.resolverNormalize = (value) => resolver({}, { [field.key]: String(value || '') });
    }
  }
  const normalize = bindNormalizeSpec(field.normalize, field, limits);
  bound.normalize = normalize || bound.resolverNormalize || null;
  return Object.freeze(bound);
}

function bindDeclaration(decl) {
  const limits = LIMIT_PROVIDER_MODULES[decl.id];
  if (!limits) throw new Error(`limits registry: no limits module registered for ${decl.id}`);
  const fetchLimits = limits[decl.fetch];
  if (typeof fetchLimits !== 'function') {
    throw new Error(`limits registry: ${decl.id} fetch references missing export ${decl.fetch}`);
  }
  return Object.freeze({
    ...decl,
    limits,
    fetchLimits,
    fields: Object.freeze(decl.fields.map((field) => bindField(field, limits))),
    discover: decl.discover ? (env = process.env) => decl.discover(env, limits) : null,
    envProbe: decl.envProbe
      ? Object.freeze({ key: decl.envProbe.key, probe: (env = process.env) => decl.envProbe.fn(env, limits) })
      : null,
    accountStatus: decl.accountStatus
      ? (input) => decl.accountStatus({ ...input, limits })
      : null,
    resolveFetch: decl.resolveFetch ? (deps) => decl.resolveFetch(deps, limits) : null
  });
}

const LIMIT_PROVIDER_REGISTRY = Object.freeze(LIMIT_PROVIDER_ACCOUNTS.map(bindDeclaration));

const LIMIT_PROVIDER_FETCHERS = Object.freeze(Object.fromEntries(
  LIMIT_PROVIDER_REGISTRY.map((entry) => [
    entry.id,
    (providerOptions, probeDeps) => entry.fetchLimits(providerOptions, probeDeps)
  ])
));

function limitProviderEntry(provider) {
  return LIMIT_PROVIDER_REGISTRY.find((entry) => entry.id === provider) || null;
}

function* limitAccountFields() {
  for (const entry of LIMIT_PROVIDER_REGISTRY) {
    for (const field of entry.fields) yield { provider: entry.id, field };
  }
}

function limitAccountFieldEntry(key) {
  for (const { provider, field } of limitAccountFields()) {
    if (field.key === key) return { provider, field };
  }
  return null;
}

module.exports = {
  LIMIT_PROVIDER_ACCOUNTS,
  LIMIT_PROVIDER_FETCHERS,
  LIMIT_PROVIDER_MODULES,
  LIMIT_PROVIDER_REGISTRY,
  limitAccountFieldEntry,
  limitAccountFields,
  limitProviderEntry,
  normalizeSecretSetting
};
