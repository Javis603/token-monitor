'use strict';

(function exposeProjectRows(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorProjectRows = api;
})(typeof window !== 'undefined' ? window : null, function createProjectRowsApi() {
  function projectName(projectPath) {
    const clean = String(projectPath || '').replace(/[\\/]+$/, '');
    return clean.split(/[\\/]/).pop() || clean;
  }

  function projectRowsForPeriod(period, options = {}) {
    const projects = new Map();
    for (const session of Object.values(period?.sessions || {})) {
      const projectPath = String(session?.projectPath || '').trim();
      if (!projectPath) continue;
      const key = projectPath.replace(/[\\/]+$/, '');
      if (!projects.has(key)) projects.set(key, { key, name: projectName(key), projectPath: key, value: 0, cost: 0, clients: new Set() });
      const project = projects.get(key);
      project.value += Number(session.totalTokens || 0);
      project.cost += Number(session.costUsd || 0);
      if (session.client) project.clients.add(session.client);
    }
    return Array.from(projects.values()).map((project) => ({
      ...project,
      clients: Array.from(project.clients),
      subtitle: project.projectPath,
      detail: Array.from(project.clients).map((client) => options.clientLabels?.[client] || client).join(', '),
      color: options.stableColor ? options.stableColor(project.key, options.fallbackColors || ['#73bdf5']) : '#73bdf5',
      stale: false
    })).sort((a, b) => b.cost - a.cost || b.value - a.value || a.name.localeCompare(b.name));
  }

  return { projectName, projectRowsForPeriod };
});
