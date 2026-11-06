'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginLimitSettings = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Retain author controls across native row rebuilds; the existing view host
  // owns async mount/update/disposal, unsaved-work inspection and UI failures.
  function create({ document, host, getModules, getView, isVisible }) {
    const mounts = new Map();
    function node(module) {
      if (!module.settingsView) return null;
      let held = mounts.get(module.id);
      if (!held) {
        const container = document.createElement('div');
        container.className = 'plugin-author-settings';
        container.dataset.limitModule = module.id;
        held = { container, mounted: false }; mounts.set(module.id, held);
      }
      return held.container;
    }
    function reconcile() {
      const modules = new Map(getModules().map(module => [module.id, module]));
      for (const [id, held] of mounts) {
        const module = modules.get(id), view = module?.settingsView && getView(module);
        if (!view) {
          host.unmount(held.container); held.container.remove(); mounts.delete(id); continue;
        }
        const visible = isVisible(module, held.container);
        if (!held.mounted && !visible) continue;
        if (!held.container.isConnected) continue;
        host.mount(held.container, view.ref, 'settings', { descriptor: view, visible, isVisible: () => isVisible(module, held.container),
          surfaceVariant: 'limits-settings', moduleId: module.moduleId, moduleRef: module.id });
        held.mounted = true;
      }
      host.refreshDemand();
    }
    return { node, reconcile, dispose() {
      for (const held of mounts.values()) host.unmount(held.container);
      mounts.clear();
    } };
  }
  return { create };
});
