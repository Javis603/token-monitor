'use strict';

(function exposeModelAliases(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorModelAliases = api;
})(typeof window !== 'undefined' ? window : null, function createModelAliasesApi() {
  const MAX_ALIASES = 4096;
  const MAX_DISCOVERED_MODELS = 16384;
  const MAX_MODEL_ID_LENGTH = 256;

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function matchKey(model) {
    return text(model)
      .toLowerCase()
      .replace(/[._\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function modelLeaf(model) {
    const raw = text(model);
    if (!raw) return '';
    const parts = raw.split('/').filter(Boolean);
    return parts.at(-1) || raw;
  }

  function modelIdentityKey(model) {
    return matchKey(modelLeaf(model));
  }

  function validPair(alias, canonical) {
    return alias
      && canonical
      && alias.length <= MAX_MODEL_ID_LENGTH
      && canonical.length <= MAX_MODEL_ID_LENGTH
      && matchKey(alias) !== matchKey(canonical);
  }

  function normalizeModelAliases(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = [];
    const seen = new Set();
    for (const [source, target] of Object.entries(value)) {
      if (typeof target !== 'string') continue;
      const alias = source.trim();
      const canonical = target.trim();
      const aliasKey = matchKey(alias);
      if (!validPair(alias, canonical) || seen.has(aliasKey)) continue;
      seen.add(aliasKey);
      entries.push([alias, canonical]);
      if (entries.length === MAX_ALIASES) break;
    }
    return Object.fromEntries(entries);
  }

  function discoveredModelIds(modelIds) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(modelIds) ? modelIds : []) {
      const model = text(value);
      if (!model || model.length > MAX_MODEL_ID_LENGTH || seen.has(model)) continue;
      seen.add(model);
      result.push(model);
      if (result.length === MAX_DISCOVERED_MODELS) break;
    }
    return result;
  }

  function identityKey(model, observedKeys) {
    const key = modelIdentityKey(model);
    const withoutClaudeCodeSuffix = key.startsWith('claude-') && key.endsWith('-cc')
      ? key.slice(0, -3)
      : '';
    return withoutClaudeCodeSuffix && observedKeys.has(withoutClaudeCodeSuffix)
      ? withoutClaudeCodeSuffix
      : key;
  }

  function compareCanonicalCandidates(left, right, identity) {
    const rank = (model) => {
      const leaf = modelLeaf(model);
      const leafKey = modelIdentityKey(model);
      return [
        leafKey === identity ? 0 : 1,
        model === leaf ? 0 : 1,
        leaf === leaf.toLowerCase() ? 0 : 1,
        /[._\s]/.test(leaf) ? 1 : 0,
        leaf.length,
        leaf.toLowerCase(),
        leaf
      ];
    };
    const a = rank(left);
    const b = rank(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] < b[index]) return -1;
      if (a[index] > b[index]) return 1;
    }
    return 0;
  }

  function inferModelAliases(modelIds) {
    const models = discoveredModelIds(modelIds);
    if (models.length < 2) return {};

    const observedKeys = new Set(models.map(modelIdentityKey).filter(Boolean));
    const groups = new Map();
    for (const model of models) {
      const key = identityKey(model, observedKeys);
      if (!key) continue;
      const group = groups.get(key) || [];
      group.push(model);
      groups.set(key, group);
    }

    const aliases = [];
    for (const [identity, group] of groups) {
      if (group.length < 2) continue;
      const canonical = modelLeaf([...group].sort((a, b) => compareCanonicalCandidates(a, b, identity))[0]);
      for (const model of group) {
        if (model === canonical) continue;
        aliases.push([model, canonical]);
        if (aliases.length === MAX_ALIASES) return Object.fromEntries(aliases);
      }
    }
    return Object.fromEntries(aliases);
  }

  function createModelAliasResolver(value, modelIds = []) {
    const explicit = new Map(
      Object.entries(normalizeModelAliases(value))
        .map(([alias, canonical]) => [matchKey(alias), canonical])
    );
    const automatic = new Map(
      Object.entries(inferModelAliases(modelIds))
        .map(([alias, canonical]) => [matchKey(alias), canonical])
    );

    return (model) => {
      if (typeof model !== 'string') return model;
      const direct = explicit.get(matchKey(model));
      if (direct !== undefined) return direct;
      const inferred = automatic.get(matchKey(model));
      if (inferred === undefined) return model;
      return explicit.get(matchKey(inferred)) ?? inferred;
    };
  }

  function upsertModelAlias(value, source, target, previousSource) {
    if (typeof source !== 'string' || typeof target !== 'string') return null;
    const alias = source.trim();
    const canonical = target.trim();
    if (!validPair(alias, canonical)) return null;

    const aliasKey = matchKey(alias);
    const previousKey = matchKey(previousSource);
    const entries = Object.entries(normalizeModelAliases(value))
      .filter(([key]) => {
        const normalized = matchKey(key);
        return normalized !== aliasKey && (!previousKey || normalized !== previousKey);
      });
    if (entries.length >= MAX_ALIASES) return null;
    return Object.fromEntries([...entries, [alias, canonical]]);
  }

  return {
    normalizeModelAliases,
    inferModelAliases,
    createModelAliasResolver,
    upsertModelAlias
  };
});
