'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginContent = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Same-page factories receive real host elements. This is a lifecycle and
  // conflict convention, not a DOM security boundary.
  function create({ document, host, getViews, selection = () => null }) {
    const outlets = new Map();
    function clear(record) {
      record.native.hidden = record.wasHidden;
      for (const node of record.nodes.values()) { host.unmount(node); node.remove(); }
      record.nodes.clear();
    }
    function render(target, native, context = {}) {
      if (!native?.parentNode) return;
      const key = `${target}:${context.targetInstance || ''}`;
      let record = outlets.get(key);
      if (record?.native !== native) {
        if (record) record.native.hidden = record.wasHidden;
        record = { target, native, wasHidden: native.hidden, nodes: record?.nodes || new Map() };
        outlets.set(key, record);
      }
      const selected = selection(target);
      const views = getViews().filter(view => view.targets?.includes(target)
        && (view.mode !== 'replace' || view.ref === selected));
      const wanted = new Set(views.map(view => view.ref));
      for (const [ref, node] of record.nodes) if (!wanted.has(ref)) { host.unmount(node); node.remove(); record.nodes.delete(ref); }
      let previous = native;
      const generation = record.generation = (record.generation || 0) + 1;
      native.hidden = record.wasHidden;
      for (const view of views) {
        let container = record.nodes.get(view.ref);
        if (!container) {
          container = document.createElement('div'); container.className = 'plugin-content';
          container.dataset.pluginTarget = target; record.nodes.set(view.ref, container);
        }
        native.parentNode.insertBefore(container, previous.nextSibling);
        previous = container;
        void host.mount(container, view, { ...context, target, native, mode: view.mode, descriptor: view,
          onMountStatus(ok) {
            if (outlets.get(key) !== record || generation !== record.generation) return;
            if (view.mode === 'replace') native.hidden = ok || record.wasHidden;
          }
        });
      }
    }
    return { render,
      hasTarget(target) { return getViews().some(view => view.targets?.includes(target) && (view.mode !== 'replace' || selection(target) === view.ref)); },
      retain(targets) { for (const [target, record] of outlets) if (!targets.includes(record.target) || !record.native.isConnected) { clear(record); outlets.delete(target); } },
      dispose() { for (const record of outlets.values()) clear(record); outlets.clear(); }
    };
  }
  return { create };
});
