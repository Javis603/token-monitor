'use strict';

// Desktop display projection only. Never pass this result to accounting,
// history, exports or the Hub: plugin records belong to this host, not a device.
function projectPluginLimits(stats, snapshot) {
  if (!stats) return stats;
  const modules = snapshot?.modules || [];
  const byId = new Map(modules.map(module => [module.id, module]));
  const providers = (snapshot?.providers || []).filter(row => byId.has(row.provider)).map(row => {
    const module = byId.get(row.provider);
    return { ...row, pluginQuota: { label: module.label, presentation: module.presentation, identityIcon: module.identityIcon } };
  });
  return { ...stats, limits: { ...stats.limits, providers: [...(stats.limits?.providers || []).filter(row => !String(row.provider).startsWith('plugin:')), ...providers] },
    pluginLimitModules: modules };
}

module.exports = { projectPluginLimits };
