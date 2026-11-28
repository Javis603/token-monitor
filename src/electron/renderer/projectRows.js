'use strict';

(function exposeProjectRows(root, factory) {
  const projectKeyApi = typeof module === 'object' && module.exports
    ? require('../../shared/projectKey')
    : root?.TokenMonitorProjectKey;
  const aliases = typeof module === 'object' && module.exports ? require('./modelAliases') : root?.TokenMonitorModelAliases;
  const api = factory(projectKeyApi, aliases);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorProjectRows = api;
})(typeof window !== 'undefined' ? window : null, function createProjectRowsApi(projectKeyApi, aliases) {
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

  // Unknown client slugs such as `constructor` must not resolve to Object.prototype members.
  function ownLabel(labels, key) {
    return labels && Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : '';
  }

  function projectBreakdownIncomplete(stats, period) {
    if (period === 'allTime') return stats?.projectsIncomplete === true;
    return Number(stats?.periodProjectsOmitted?.[period] || 0) > 0;
  }

  function createPagedProjectReader(read, repaint) {
    const entries = new Map();
    let source;
    let memo;
    return function attach(stats, settings) {
      if (source !== stats?.snapshot?.source || settings?.projectsEnabled === false) {
        entries.clear();
        memo = null;
        source = stats?.snapshot?.source;
      }
      if (!stats?.snapshot || settings?.projectsEnabled === false) return stats;
      const revisions = new Map(Object.entries(stats.allTimeProjectRevisions || {}).filter(([id]) =>
        stats.devices?.some(device => device.deviceId === id && device.allTimeProjectsOmitted && !device.allTimeProjectsIncomplete && device.projectsEnabled !== false)));
      for (const [id, entry] of entries) {
        if (revisions.get(id) !== entry.revision) entries.delete(id);
      }
      const available = new Map();
      for (const [id, revision] of revisions) {
        if (!entries.has(id)) entries.set(id, { revision, attempts: 0 });
        const entry = entries.get(id);
        if (entry.projects) available.set(id, entry.projects);
        if (!entry.projects && !entry.pending && Date.now() >= (entry.retryAt || 0)) {
          if (entry.attempts === 3) entry.attempts = 0;
          entry.pending = true;
          entry.attempts++;
          void Promise.resolve().then(() => read(stats.snapshot, id)).catch(() => null).then(projects => {
            if (entries.get(id) !== entry) return;
            entry.pending = false;
            if (projects) {
              entry.projects = projects;
              memo = null;
              repaint();
            } else {
              const delay = entry.attempts < 3 ? 2000 : 30_000;
              entry.retryAt = Date.now() + delay;
              setTimeout(() => { if (entries.get(id) === entry) repaint(); }, delay);
            }
          });
        }
      }
      if (!available.size || !stats.periods?.allTime) return stats;
      if (memo?.stats === stats && memo.settings === settings) return memo.result;
      const allTime = stats.periods.allTime;
      const modelIds = [...(stats.projectModelIds || [])];
      for (const projects of available.values()) {
        for (const row of Object.values(projects)) modelIds.push(...Object.keys(row.models || {}));
      }
      const resolve = aliases.createModelAliasResolver(settings?.modelAliases, modelIds, settings?.modelAliasGrouping);
      const projectRows = rows => Object.fromEntries(Object.entries(rows || {}).map(([key, row]) => {
        if (!row.models) return [key, row];
        const models = Object.create(null);
        const { rawProjectModels, ...project } = row;
        for (const [model, tokens] of Object.entries(rawProjectModels || row.models)) {
          const name = resolve(model);
          models[name] = (models[name] || 0) + tokens;
        }
        return [key, { ...project, models }];
      }));
      const projects = Object.assign(Object.create(null), projectRows(allTime.projects));
      const devices = stats.devices.map(device => {
        const recovered = available.has(device.deviceId) ? projectRows(available.get(device.deviceId)) : null;
        if (!recovered) {
          const period = device.periods?.allTime;
          return period?.projects ? { ...device, periods: { ...device.periods, allTime: { ...period, projects: projectRows(period.projects) } } } : device;
        }
        for (const [key, value] of Object.entries(recovered)) {
          const previous = projects[key];
          if (!previous) {
            projects[key] = value;
            continue;
          }
          const project = { ...previous, label: deterministicProjectLabel(previous.label, value.label) };
          for (const field of ['tokens', 'costUsd', 'unpricedTokens']) {
            project[field] = (previous[field] || 0) + (value[field] || 0);
          }
          for (const field of ['clients', 'models']) {
            const counts = Object.assign(Object.create(null), previous[field]);
            for (const [key, count] of Object.entries(value[field] || {})) counts[key] = (counts[key] || 0) + count;
            project[field] = counts;
          }
          projects[key] = project;
        }
        return { ...device, allTimeProjectsOmitted: false,
          periods: { ...device.periods, allTime: { ...device.periods?.allTime, projects: recovered } } };
      });
      const projectsIncomplete = devices.some(device => device.allTimeProjectsOmitted || device.allTimeProjectsIncomplete
        || (device.projectsEnabled === false && device.periods?.allTime?.totalTokens > 0));
      const result = { ...stats, devices, projectsIncomplete, periods: { ...stats.periods, allTime: { ...allTime, projects } } };
      memo = { stats, settings, result };
      return result;
    };
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
    // Callers may fold client aliases so the bar, drawer and legend share one attribution.
    const clientKey = typeof options.clientKey === 'function' ? options.clientKey : (client) => client;
    const rollupEntries = Object.entries(period?.projects || {});
    if (rollupEntries.length > 0) {
      for (const [rawKey, entry] of rollupEntries) {
        if (!entry || typeof entry !== 'object') continue;
        const name = String(entry.label || rawKey || '').trim().normalize('NFC');
        const key = canonicalProjectKey(name || rawKey);
        if (!key || !name) continue;
        const clientTokens = Object.create(null);
        for (const [rawClient, value] of Object.entries(entry.clients || {})) {
          const tokens = Math.max(0, Number(value || 0));
          const client = clientKey(rawClient);
          if (tokens > 0) clientTokens[client] = (clientTokens[client] || 0) + tokens;
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
          const client = clientKey(session.client);
          project.clients.add(client);
          project.clientTokens[client] = (Object.prototype.hasOwnProperty.call(project.clientTokens, client) ? project.clientTokens[client] : 0) + sessionTokens;
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
      // Native project telemetry is local reference data only; never promote
      // it to generic project cost.
      addModelTokens(project.modelTokens, entry.models, tokens);
      for (const [rawClient, value] of Object.entries(entry.clients || {})) {
        const tokens = Math.max(0, Number(value || 0));
        if (tokens <= 0) continue;
        const client = clientKey(rawClient);
        project.clients.add(client);
        project.clientTokens[client] = (project.clientTokens[client] || 0) + tokens;
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
            ? (shareBy === 'model' ? share : (ownLabel(options.clientLabels, share) || share))
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
    }).sort((a, b) => b.value - a.value || b.cost - a.cost || a.name.localeCompare(b.name));
  }

  return { canonicalProjectKey, clientGradient, createPagedProjectReader, projectBreakdownIncomplete, projectRowsForPeriod };
});
