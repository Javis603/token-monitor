'use strict';

(function initHubBuildPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorHubBuildPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createHubBuildPresentation() {
  function targetKey(runtime) {
    if (runtime === 'cloudflare-worker') return 'settings.sync.hubBuild.targetWorker';
    if (runtime === 'node-hub') return 'settings.sync.hubBuild.targetNode';
    return 'settings.sync.hubBuild.targetHub';
  }

  function presentation(result) {
    const status = result?.status;
    if (!status || ['notConfigured', 'unavailable'].includes(status)) return null;
    const keyByStatus = {
      current: 'settings.sync.hubBuild.current',
      updateAvailable: 'settings.sync.hubBuild.updateAvailable',
      legacy: 'settings.sync.hubBuild.updateAvailable',
      remoteNewer: 'settings.sync.hubBuild.remoteNewer',
      unknown: 'settings.sync.hubBuild.unknown'
    };
    const key = keyByStatus[status];
    if (!key) return null;
    return {
      key,
      targetKey: targetKey(result.runtime),
      tone: status === 'current' ? 'ok' : ['updateAvailable', 'legacy'].includes(status) ? 'warning' : ''
    };
  }

  return { presentation, targetKey };
});
