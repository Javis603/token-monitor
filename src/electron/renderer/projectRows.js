'use strict';

(function exposeProjectRows(root, factory) {
  const projectKeyApi = typeof module === 'object' && module.exports
    ? require('../../shared/projectKey')
    : root?.TokenMonitorProjectKey;
  const api = factory(projectKeyApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorProjectRows = api;
})(typeof window !== 'undefined' ? window : null, function createProjectRowsApi(projectKeyApi) {
  const { canonicalProjectKey, deterministicProjectLabel } = projectKeyApi;

  function unpricedTokensFor(value, total) {
    const missing = Number(value);
    const tokens = Number(total);
    return Number.isFinite(missing) && Number.isFinite(tokens)
      ? Math.min(Math.max(0, tokens), Math.max(0, Math.round(missing))) : 0;
  }

  function addModelTokens(target, models, tokenLimit) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) return;
    let remaining = Math.max(0, Number(tokenLimit) || 0);
    for (const [model, value] of Object.entries(models).sort(([left], [right]) => left.localeCompare(right))) {
      if (!model || remaining <= 0) continue;
      const rawTokens = Number(value);
      const tokens = Math.min(remaining, Number.isFinite(rawTokens) ? Math.max(0, rawTokens) : 0);
      if (tokens <= 0) continue;
      target[model] = (target[model] || 0) + tokens;
      remaining -= tokens;
    }
  }

  function projectBreakdownIncomplete(stats, period) {
    if (period === 'allTime') return stats?.projectsIncomplete === true;
    return Number(stats?.periodProjectsOmitted?.[period] || 0) > 0;
  }

  function clientGradient(clients, colorFor, fallbackColor = '#73bdf5') {
    const entries = Object.entries(clients || {})
      .map(([client, value]) => ({ client, value: Math.max(0, Number(value || 0)) }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value || a.client.localeCompare(b.client));
    if (entries.length === 0) return fallbackColor;
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const colors = entries.map((entry) => (typeof colorFor === 'function' ? colorFor(entry.client) : '') || fallbackColor);
    if (entries.length === 1) return colors[0];
    const stops = [`${colors[0]} 0%`];
    let cumulative = 0;
    for (let index = 0; index < entries.length - 1; index += 1) {
      const currentShare = entries[index].value / total * 100;
      const nextShare = entries[index + 1].value / total * 100;
      cumulative += currentShare;
      const blend = Math.min(1.5, currentShare / 2, nextShare / 2);
      stops.push(`${colors[index]} ${Math.max(0, cumulative - blend).toFixed(2)}%`);
      stops.push(`${colors[index + 1]} ${Math.min(100, cumulative + blend).toFixed(2)}%`);
    }
    stops.push(`${colors[colors.length - 1]} 100%`);
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  function projectRowsForPeriod(period, options = {}) {
    const projects = new Map();
    const rollupEntries = Object.entries(period?.projects || {});
    if (rollupEntries.length > 0) {
      for (const [rawKey, entry] of rollupEntries) {
        if (!entry || typeof entry !== 'object') continue;
        const name = String(entry.label || rawKey || '').trim().normalize('NFC');
        const key = canonicalProjectKey(name || rawKey);
        if (!key || !name) continue;
        const clientTokens = Object.create(null);
        for (const [client, value] of Object.entries(entry.clients || {})) {
          const tokens = Math.max(0, Number(value || 0));
          if (tokens > 0) clientTokens[client] = tokens;
        }
        if (!projects.has(key)) projects.set(key, { key, name, value: 0, cost: 0, clients: new Set(), clientTokens: Object.create(null), modelTokens: Object.create(null) });
        const project = projects.get(key);
        project.name = deterministicProjectLabel(project.name, name);
        const tokens = Math.max(0, Number(entry.tokens || 0));
        project.value += tokens;
        project.cost += Number(entry.costUsd || 0);
        const unpriced = unpricedTokensFor(entry.unpricedTokens, entry.tokens);
        if (unpriced > 0) project.unpricedTokens = (project.unpricedTokens || 0) + unpriced;
        addModelTokens(project.modelTokens, entry.models, tokens);
        for (const [client, tokens] of Object.entries(clientTokens)) {
          project.clients.add(client);
          project.clientTokens[client] = (Object.prototype.hasOwnProperty.call(project.clientTokens, client) ? project.clientTokens[client] : 0) + tokens;
        }
      }
    } else {
      for (const session of Object.values(period?.sessions || {})) {
        const label = String(session?.projectLabel || '').trim().normalize('NFC');
        const key = canonicalProjectKey(label);
        if (!key || !label) continue;
        if (!projects.has(key)) projects.set(key, { key, name: label, value: 0, cost: 0, clients: new Set(), clientTokens: Object.create(null), modelTokens: Object.create(null) });
        const project = projects.get(key);
        project.name = deterministicProjectLabel(project.name, label);
        const sessionTokens = Math.max(0, Number(session.totalTokens || 0));
        project.value += sessionTokens;
        project.cost += Number(session.costUsd || 0);
        const unpriced = unpricedTokensFor(session.unpricedTokens, sessionTokens);
        if (unpriced > 0) project.unpricedTokens = (project.unpricedTokens || 0) + unpriced;
        if (options.allowSessionModelAttribution !== false) {
          addModelTokens(project.modelTokens, session.models, sessionTokens);
        }
        if (session.client) {
          project.clients.add(session.client);
          project.clientTokens[session.client] = (Object.prototype.hasOwnProperty.call(project.clientTokens, session.client) ? project.clientTokens[session.client] : 0) + sessionTokens;
        }
      }
    }
    for (const [rawKey, entry] of Object.entries(options.nativeProjects || {})) {
      if (!entry || typeof entry !== 'object') continue;
      const name = String(entry.label || rawKey || '').trim().normalize('NFC');
      const key = canonicalProjectKey(name || rawKey);
      if (!key || !name) continue;
      if (!projects.has(key)) projects.set(key, { key, name, value: 0, cost: 0, clients: new Set(), clientTokens: Object.create(null), modelTokens: Object.create(null) });
      const project = projects.get(key);
      project.name = deterministicProjectLabel(project.name, name);
      const tokens = Math.max(0, Number(entry.tokens || 0));
      project.value += tokens;
      // Reasonix native project telemetry is local reference data only. Its
      // reported session cost must never become generic project cost.
      addModelTokens(project.modelTokens, entry.models, tokens);
      for (const [client, value] of Object.entries(entry.clients || {})) {
        const tokens = Math.max(0, Number(value || 0));
        if (tokens <= 0) continue;
        project.clients.add(client);
        project.clientTokens[client] = (project.clientTokens[client] || 0) + tokens;
      }
    }
    // Native project rollups are local-only and may be absent from an older
    // snapshot while the corresponding native sessions are already present.
    // Rebuild only from exact, period-safe native sessions; never infer a
    // project from aggregate Reasonix totals or from an unreliable period.
    if (Object.keys(options.nativeProjects || {}).length === 0) {
      for (const session of Object.values(options.nativeSessions || {})) {
        if (session?.client !== 'reasonix'
          || !session.projectId
          || !session.projectLabel
          || session.tokenDataUnavailable === true
          || session.periodTokenDataUnavailable === true) continue;
        const name = String(session.projectLabel).trim().normalize('NFC');
        const key = canonicalProjectKey(name);
        const tokens = Math.max(0, Number(session.totalTokens || 0));
        if (!key || !name || tokens <= 0) continue;
        if (!projects.has(key)) projects.set(key, { key, name, value: 0, cost: 0, clients: new Set(), clientTokens: Object.create(null), modelTokens: Object.create(null) });
        const project = projects.get(key);
        project.name = deterministicProjectLabel(project.name, name);
        project.value += tokens;
        project.clients.add('reasonix');
        project.clientTokens.reasonix = (project.clientTokens.reasonix || 0) + tokens;
        addModelTokens(project.modelTokens, session.models, tokens);
      }
    }
    return Array.from(projects.values()).map((project) => {
      const color = options.stableColor ? options.stableColor(project.key, options.fallbackColors || ['#73bdf5']) : '#73bdf5';
      const shareBy = options.shareBy === 'model' ? 'model' : 'tool';
      const shares = shareBy === 'model' ? project.modelTokens : project.clientTokens;
      const attributedTokens = Object.values(shares).reduce((sum, value) => sum + Number(value || 0), 0);
      const boundedShares = Object.assign(Object.create(null), shares);
      if (project.value > attributedTokens) boundedShares[''] = project.value - attributedTokens;
      const shareColor = (value) => {
        if (shareBy === 'model') {
          if (!value) return options.unknownModelColor || 'var(--muted)';
          return (typeof options.modelColor === 'function' ? options.modelColor(value) : '') || color;
        }
        const candidate = value && Object.prototype.hasOwnProperty.call(options.clientColors || {}, value)
          ? options.clientColors[value]
          : '';
        return typeof candidate === 'string' && candidate ? candidate : color;
      };
      const accordionRows = Object.entries(boundedShares)
        .filter(([, value]) => Number(value) > 0)
        .map(([share, value]) => ({
          key: share || 'unknown',
          name: share
            ? (shareBy === 'model' ? share : (options.clientLabels?.[share] || share))
            : (shareBy === 'model' ? (options.unknownModelLabel || 'Unknown model') : (options.unknownClientLabel || 'Unknown')),
          value: Number(value),
          percent: project.value > 0 ? Number(value) / project.value * 100 : 0,
          color: shareColor(share)
        }))
        .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
      return {
        ...project,
        ...(shareBy === 'model' ? { modelTokens: boundedShares } : { clientTokens: boundedShares }),
        clients: Array.from(project.clients).sort(),
        subtitle: '',
        detail: '',
        color,
        barBackground: clientGradient(boundedShares, shareColor, color),
        accordionRows,
        stale: false
      };
    }).sort((a, b) => b.cost - a.cost || b.value - a.value || a.name.localeCompare(b.name));
  }

  return { canonicalProjectKey, clientGradient, projectBreakdownIncomplete, projectRowsForPeriod };
});
