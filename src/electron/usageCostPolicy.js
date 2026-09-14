'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorUsageCostPolicy = api;
})(typeof window !== 'undefined' ? window : null, function createUsageCostPolicy() {
  const CODEX_WEB_PREFIX = 'chatgpt-web/';
  const MAX_RULES = 100;
  const MAX_MODELS_PER_RULE = 1000;
  const MAX_KEY_LENGTH = 256;
  const COST_EPSILON = 0.000001;
  const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function key(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  function safeKey(value) {
    const normalized = key(value);
    return normalized.length > 0
      && normalized.length <= MAX_KEY_LENGTH
      && !RESERVED_KEYS.has(normalized);
  }

  function amount(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeModelChoices(value, modelPrefix) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const models = Object.create(null);
    let count = 0;
    for (const [model, included] of Object.entries(value)) {
      const modelKey = key(model);
      if (!safeKey(modelKey) || !modelKey.startsWith(modelPrefix) || typeof included !== 'boolean') continue;
      if (!Object.hasOwn(models, modelKey)) {
        if (count >= MAX_MODELS_PER_RULE) continue;
        count += 1;
      }
      models[modelKey] = included;
    }
    return { ...models };
  }

  function normalizeUsageCostRules(value) {
    if (!Array.isArray(value)) return [];
    const rules = [];
    for (const candidate of value) {
      const client = key(candidate?.client);
      const modelPrefix = key(candidate?.modelPrefix);
      if (!safeKey(client) || !safeKey(modelPrefix)) continue;
      rules.push({
        client,
        modelPrefix,
        included: candidate?.included !== false,
        models: normalizeModelChoices(candidate?.models, modelPrefix)
      });
      if (rules.length === MAX_RULES) break;
    }
    return rules;
  }

  function includes(rules, client, model) {
    const clientKey = key(client);
    const modelKey = key(model);
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index];
      if (rule.client !== clientKey || !modelKey.startsWith(rule.modelPrefix)) continue;
      return rule.included && rule.models[modelKey] !== false;
    }
    return true;
  }

  function costIncluded(rules, client, model) {
    return includes(normalizeUsageCostRules(rules), client, model);
  }

  function activeRules(rules) {
    return rules.some((rule) => !rule.included || Object.values(rule.models).includes(false));
  }

  function codexWebCostRule(rules) {
    const normalized = normalizeUsageCostRules(rules);
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const rule = normalized[index];
      if (rule.client === 'codex' && rule.modelPrefix === CODEX_WEB_PREFIX) return rule;
    }
    return { client: 'codex', modelPrefix: CODEX_WEB_PREFIX, included: true, models: {} };
  }

  function updateCodexWebCostRule(rules, patch) {
    const normalized = normalizeUsageCostRules(rules);
    const previous = codexWebCostRule(normalized);
    const next = normalized.filter((rule) => (
      rule.client !== 'codex' || rule.modelPrefix !== CODEX_WEB_PREFIX
    ));
    next.push({
      ...previous,
      ...patch,
      models: { ...previous.models, ...(patch?.models || {}) }
    });
    return normalizeUsageCostRules(next);
  }

  function excludeMatrixCosts(matrix, rules) {
    const clients = {};
    const models = {};
    let total = 0;
    for (const [client, costs] of Object.entries(matrix || {})) {
      if (!safeKey(client)) continue;
      for (const [model, cost] of Object.entries(costs || {})) {
        if (!safeKey(model) || includes(rules, client, model)) continue;
        const value = amount(cost);
        clients[client] = amount(clients[client]) + value;
        models[model] = amount(models[model]) + value;
        total += value;
        costs[model] = 0;
      }
    }
    return { clients, models, total };
  }

  function subtractCost(target, field, value) {
    if (target && Object.hasOwn(target, field)) {
      target[field] = Math.max(0, amount(target[field]) - value);
    }
  }

  function matrixCost(matrix) {
    let total = 0;
    for (const models of Object.values(matrix || {})) {
      for (const cost of Object.values(models || {})) total += amount(cost);
    }
    return total;
  }

  function ruleCouldAffectPeriod(period, rules) {
    const clients = Object.entries(period?.clientCosts || {}).filter(([, cost]) => amount(cost) > 0);
    const models = Object.entries(period?.modelCosts || {}).filter(([, cost]) => amount(cost) > 0);
    return clients.some(([client]) => models.some(([model]) => !includes(rules, client, model)));
  }

  function projectSession(session, rules) {
    if (!session || typeof session !== 'object') return 0;
    const client = key(session.client);
    const modelIds = new Set([
      ...Object.keys(session.models || {}),
      ...Object.keys(session.modelCosts || {})
    ]);
    const originalCost = amount(session.costUsd);
    const attributedCost = matrixCost(client ? { [client]: session.modelCosts } : null);
    if (
      originalCost - attributedCost > COST_EPSILON
      && client
      && [...modelIds].some((model) => !includes(rules, client, model))
    ) {
      session.costPolicyIncomplete = true;
    }
    const excluded = client
      ? excludeMatrixCosts({ [client]: session.modelCosts }, rules).total
      : 0;
    session.excludedCostUsd = Math.min(originalCost, excluded);
    subtractCost(session, 'costUsd', excluded);
    return excluded;
  }

  function canonicalProjectKey(value) {
    const label = String(value || '').trim().normalize('NFC');
    return label ? label.toLowerCase().normalize('NFC') : '';
  }

  function projectPeriod(period, rules) {
    if (!period || typeof period !== 'object') return period;
    const originalCost = amount(period.costUsd);
    const attributedCost = matrixCost(period.clientModelCosts);
    if (originalCost - attributedCost > COST_EPSILON && ruleCouldAffectPeriod(period, rules)) {
      period.costPolicyIncomplete = true;
    }

    const excluded = excludeMatrixCosts(period.clientModelCosts, rules);
    period.excludedCostUsd = Math.min(originalCost, excluded.total);
    period.excludedModelCosts = excluded.models;
    subtractCost(period, 'costUsd', excluded.total);
    for (const [client, value] of Object.entries(excluded.clients)) {
      subtractCost(period.clientCosts, client, value);
    }
    for (const [model, value] of Object.entries(excluded.models)) {
      subtractCost(period.modelCosts, model, value);
    }

    const projectCoverage = new Map();
    for (const session of Object.values(period.sessions || {})) {
      const sessionCost = amount(session.costUsd);
      const excludedSessionCost = projectSession(session, rules);
      if (session.costPolicyIncomplete) period.costPolicyIncomplete = true;
      const projectKey = canonicalProjectKey(session.projectLabel);
      if (!projectKey) continue;
      projectCoverage.set(projectKey, amount(projectCoverage.get(projectKey)) + sessionCost);
      const project = Object.hasOwn(period.projects || {}, projectKey)
        ? period.projects[projectKey]
        : null;
      if (project) {
        project.excludedCostUsd = amount(project.excludedCostUsd) + excludedSessionCost;
        subtractCost(project, 'costUsd', excludedSessionCost);
      }
    }

    for (const [id, project] of Object.entries(period.projects || {})) {
      const projectKey = canonicalProjectKey(project?.label || id);
      const coveredCost = amount(projectCoverage.get(projectKey));
      const projectCost = amount(project.costUsd) + amount(project.excludedCostUsd);
      if (excluded.total > 0 && projectCost - coveredCost > COST_EPSILON) {
        project.costPolicyIncomplete = true;
        period.costPolicyIncomplete = true;
      }
    }
    return period;
  }

  function historyMatrix(row) {
    if (row.clientModelCosts) return row.clientModelCosts;
    const clients = Object.keys(row.perClient || {});
    if (clients.length !== 1 || !row.perModel) return null;
    return {
      [clients[0]]: Object.fromEntries(
        Object.entries(row.perModel).map(([model, entry]) => [model, amount(entry.cost)])
      )
    };
  }

  function projectHistoryRow(row, rules) {
    const matrix = historyMatrix(row);
    if (!matrix) {
      if (amount(row.cost) > 0) row.costPolicyIncomplete = true;
      return 0;
    }
    const excluded = excludeMatrixCosts(matrix, rules);
    row.excludedCostUsd = Math.min(amount(row.cost), excluded.total);
    subtractCost(row, 'cost', excluded.total);
    for (const [client, value] of Object.entries(excluded.clients)) {
      subtractCost(row.perClient?.[client], 'cost', value);
    }
    for (const [model, value] of Object.entries(excluded.models)) {
      subtractCost(row.perModel?.[model], 'cost', value);
    }
    if (row.clientModelCostsIncomplete) row.costPolicyIncomplete = true;
    return row.excludedCostUsd;
  }

  function projectHistoryCosts(history, inputRules) {
    const rules = normalizeUsageCostRules(inputRules);
    if (!history || !activeRules(rules)) return history;
    const result = clone(history);
    for (const row of result.daily || []) projectHistoryRow(row, rules);

    let excluded = 0;
    for (const row of result.monthly || []) excluded += projectHistoryRow(row, rules);
    if (result.summary) {
      subtractCost(result.summary, 'totalCost', excluded);
      result.summary.excludedCostUsd = excluded;
      if (result.summary.clientModelCosts) {
        const summary = {
          cost: history.summary.totalCost,
          clientModelCosts: result.summary.clientModelCosts,
          clientModelCostsIncomplete: result.summary.clientModelCostsIncomplete
        };
        projectHistoryRow(summary, rules);
        result.summary.totalCost = summary.cost;
        result.summary.excludedCostUsd = summary.excludedCostUsd;
        if (summary.costPolicyIncomplete) result.summary.costPolicyIncomplete = true;
      }
    }

    const maxCost = Math.max(0, ...(result.daily || []).map((row) => amount(row.cost)));
    for (const row of result.daily || []) {
      const ratio = maxCost > 0 ? amount(row.cost) / maxCost : 0;
      row.costIntensity = ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : ratio > 0 ? 1 : 0;
      row.intensity = row.costIntensity;
    }
    result.costPolicyIncomplete = [...(result.daily || []), ...(result.monthly || [])]
      .some((row) => row.costPolicyIncomplete)
      || result.summary?.costPolicyIncomplete === true
      || result.summary?.clientModelCostsIncomplete === true;
    result.costPolicyActive = true;
    return result;
  }

  function projectRecord(record, rules) {
    if (!record || typeof record !== 'object') return record;
    for (const field of ['today', 'month', 'allTime']) projectPeriod(record[field], rules);
    for (const period of Object.values(record.periods || {})) projectPeriod(period, rules);
    if (record.history) record.history = projectHistoryCosts(record.history, rules);
    return record;
  }

  function rulesRevision(rules) {
    const source = JSON.stringify(rules);
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
      hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function projectUsageCosts(stats, inputRules) {
    const rules = normalizeUsageCostRules(inputRules);
    if (!stats || !activeRules(rules)) return stats;
    const result = projectRecord(clone(stats), rules);
    for (const device of result.devices || []) projectRecord(device, rules);
    for (const session of Object.values(result.allTimeSessionsView || {})) projectSession(session, rules);
    if (result.historyPreview) result.historyPreview = projectHistoryCosts(result.historyPreview, rules);

    result.costPolicyActive = true;
    result.costPolicyIncomplete = [result.today, result.month, result.allTime]
      .concat(Object.values(result.periods || {}))
      .some((period) => period?.costPolicyIncomplete)
      || result.history?.costPolicyIncomplete === true
      || result.historyPreview?.costPolicyIncomplete === true;

    const revision = rulesRevision(rules);
    for (const field of ['historyRevision', 'deviceHistoryRevision']) {
      result[field] = `${stats[field] || ''}:costs:${revision}`;
    }
    return result;
  }

  return {
    normalizeUsageCostRules,
    costIncluded,
    codexWebCostRule,
    updateCodexWebCostRule,
    projectUsageCosts,
    projectHistoryCosts
  };
});
