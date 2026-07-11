'use strict';

(function exposeProjectRows(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorProjectRows = api;
})(typeof window !== 'undefined' ? window : null, function createProjectRowsApi() {
  function projectName(projectPath) {
    const raw = String(projectPath || '').trim();
    if (raw === '/' || /^[a-z]:[\\/]$/i.test(raw)) return raw === '/' ? '/' : `${raw[0].toUpperCase()}:\\`;
    const clean = raw.replace(/[\\/]+$/, '');
    return clean.split(/[\\/]/).pop() || clean;
  }

  function projectRowsForPeriod(period, options = {}) {
    const projects = new Map();
    for (const session of Object.values(period?.sessions || {})) {
      const key = String(session?.projectId || '').trim();
      const label = String(session?.projectLabel || '').trim();
      if (!key || !label) continue;
      if (!projects.has(key)) projects.set(key, { key, name: label, value: 0, cost: 0, clients: new Set() });
      const project = projects.get(key);
      project.value += Number(session.totalTokens || 0);
      project.cost += Number(session.costUsd || 0);
      if (session.client) project.clients.add(session.client);
    }
    return Array.from(projects.values()).map((project) => ({
      ...project,
      clients: Array.from(project.clients).sort(),
      subtitle: '',
      detail: Array.from(project.clients).map((client) => options.clientLabels?.[client] || client).sort((a, b) => a.localeCompare(b)).join(', '),
      color: options.stableColor ? options.stableColor(project.key, options.fallbackColors || ['#73bdf5']) : '#73bdf5',
      stale: false
    })).sort((a, b) => b.cost - a.cost || b.value - a.value || a.name.localeCompare(b.name));
  }

  return { projectName, projectRowsForPeriod };
});
