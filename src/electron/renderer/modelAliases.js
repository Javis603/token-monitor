'use strict';

(function exposeModelAliases(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorModelAliases = api;
})(typeof window !== 'undefined' ? window : null, function createModelAliasesApi() {
  const MAX_ALIASES = 4096;
  const MAX_MODEL_ID_LENGTH = 256;

  function matchKey(model) {
    return String(model || '').trim().toLowerCase().replaceAll('.', '-');
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

  function createModelAliasResolver(value) {
    const aliases = new Map(
      Object.entries(normalizeModelAliases(value))
        .map(([alias, canonical]) => [matchKey(alias), canonical])
    );
    return (model) => typeof model === 'string'
      ? aliases.get(matchKey(model)) ?? model
      : model;
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

  return { normalizeModelAliases, createModelAliasResolver, upsertModelAlias };
});
