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

  function projectBreakdownIncomplete(stats, period) {
    return period === 'allTime' && stats?.projectsIncomplete === true;
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
        if (!projects.has(key)) projects.set(key, { key, name, value: 0, cost: 0, clients: new Set(), clientTokens: Object.create(null) });
        const project = projects.get(key);
        project.name = deterministicProjectLabel(project.name, name);
        project.value += Math.max(0, Number(entry.tokens || 0));
        project.cost += Number(entry.costUsd || 0);
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
        if (!projects.has(key)) projects.set(key, { key, name: label, value: 0, cost: 0, clients: new Set(), clientTokens: Object.create(null) });
        const project = projects.get(key);
        project.name = deterministicProjectLabel(project.name, label);
        const sessionTokens = Math.max(0, Number(session.totalTokens || 0));
        project.value += sessionTokens;
        project.cost += Number(session.costUsd || 0);
        if (session.client) {
          project.clients.add(session.client);
          project.clientTokens[session.client] = (Object.prototype.hasOwnProperty.call(project.clientTokens, session.client) ? project.clientTokens[session.client] : 0) + sessionTokens;
        }
      }
    }
    return Array.from(projects.values()).map((project) => {
      const color = options.stableColor ? options.stableColor(project.key, options.fallbackColors || ['#73bdf5']) : '#73bdf5';
      const clientColor = (client) => {
        const candidate = client && Object.prototype.hasOwnProperty.call(options.clientColors || {}, client)
          ? options.clientColors[client]
          : '';
        return typeof candidate === 'string' && candidate ? candidate : color;
      };
      const attributedTokens = Object.values(project.clientTokens).reduce((sum, value) => sum + Number(value || 0), 0);
      if (project.value > attributedTokens) project.clientTokens[''] = project.value - attributedTokens;
      const accordionRows = Object.entries(project.clientTokens)
        .filter(([, value]) => Number(value) > 0)
        .map(([client, value]) => ({
          key: client || 'unknown',
          name: client ? (options.clientLabels?.[client] || client) : (options.unknownClientLabel || 'Unknown'),
          value: Number(value),
          percent: project.value > 0 ? Number(value) / project.value * 100 : 0,
          color: clientColor(client)
        }))
        .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
      return {
        ...project,
        clients: Array.from(project.clients).sort(),
        subtitle: '',
        detail: '',
        color,
        barBackground: clientGradient(project.clientTokens, clientColor, color),
        accordionRows,
        stale: false
      };
    }).sort((a, b) => b.cost - a.cost || b.value - a.value || a.name.localeCompare(b.name));
  }

  return { canonicalProjectKey, clientGradient, projectBreakdownIncomplete, projectRowsForPeriod };
});
