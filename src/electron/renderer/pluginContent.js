'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginContent = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Same-page factories receive real host elements. This is a lifecycle and
  // conflict convention, not a DOM security boundary.
  function create({ document, host, getViews, selection = () => null }) {
    const outlets = new Map(), watchers = new Map();
    const MutationObserver = document.defaultView?.MutationObserver;
    const findAnchors = (native, selector) => [...native.querySelectorAll(selector)].filter(node => !node.closest('.plugin-content'));
    function unwatch(scope) { watchers.get(scope)?.observer.disconnect(); watchers.delete(scope); }
    function watch(scope, target, native, context, selectors) {
      if (!MutationObserver || !selectors.length) { unwatch(scope); return; }
      let watcher = watchers.get(scope);
      if (watcher?.native !== native) { unwatch(scope); watcher = null; }
      if (!watcher) {
        watcher = { target, native };
        watcher.observer = new MutationObserver(() => {
          if (!native.isConnected) { unwatch(scope); return; }
          // Native partial renderers can replace rows without the App render
          // wrapper. Reconcile only changed anchors/detached mounts; author
          // DOM updates must not recursively invoke author update callbacks.
          const changed = watcher.anchors.some(([selector, previous]) => {
            const current = findAnchors(native, selector);
            return current.length !== previous.length || current.some((node, index) => node !== previous[index]);
          });
          const detached = [...outlets.values()].some(record => record.scope === scope && [...record.nodes.values()].some(node => !node.isConnected));
          if (changed || detached) render(target, native, watcher.context);
        });
        watcher.observer.observe(native, { childList: true, subtree: true });
        watchers.set(scope, watcher);
      }
      watcher.context = context;
      watcher.anchors = selectors.map(selector => [selector, findAnchors(native, selector)]);
    }
    function clear(record) {
      if (record.replaces) record.native.hidden = record.wasHidden;
      for (const node of record.nodes.values()) { host.unmount(node); node.remove(); }
      record.nodes.clear();
    }
    function renderOne(target, native, context, key, scope, views, pendingMounts) {
      if (!native?.parentNode) return;
      let record = outlets.get(key);
      if (record?.native !== native) {
        if (record?.replaces) record.native.hidden = record.wasHidden;
        record = { target, scope, native, wasHidden: native.hidden, nodes: record?.nodes || new Map() };
        outlets.set(key, record);
      }
      const wanted = new Set(views.map(view => view.ref));
      for (const [ref, node] of record.nodes) if (!wanted.has(ref)) { host.unmount(node); node.remove(); record.nodes.delete(ref); }
      const generation = record.generation = (record.generation || 0) + 1;
      if (record.replaces) native.hidden = record.wasHidden;
      record.replaces = views.some(view => view.mode === 'replace');
      for (const view of views) {
        let container = record.nodes.get(view.ref);
        if (!container) {
          container = document.createElement('div'); container.className = 'plugin-content';
          container.dataset.pluginTarget = target; record.nodes.set(view.ref, container);
        }
        pendingMounts.push(() => host.mount(container, view, { ...context, target, native, mode: view.mode, descriptor: view,
          onMountStatus(ok) {
            if (outlets.get(key) !== record || generation !== record.generation) return;
            if (view.mode === 'replace') native.hidden = ok || record.wasHidden;
          }
        }));
      }
    }
    function render(target, native, context = {}) {
      if (!native?.parentNode) return;
      const scope = JSON.stringify([target, context.targetInstance || '']);
      const groups = new Map(), wanted = new Set(), selectors = [], pendingMounts = [];
      const ordered = [...getViews()].sort((a, b) => (a.contentOrder?.[target] ?? Number.MAX_SAFE_INTEGER) - (b.contentOrder?.[target] ?? Number.MAX_SAFE_INTEGER));
      for (const view of ordered) {
        if (!view.targets?.includes(target) || (view.mode === 'replace' && view.ref !== selection(target))) continue;
        const selector = view.selector || '';
        if (!groups.has(selector)) groups.set(selector, []);
        groups.get(selector).push(view);
      }
      for (const [selector, views] of groups) {
        let anchors;
        try { anchors = selector ? findAnchors(native, selector) : [native]; }
        catch (error) { console.error('[plugins] Invalid content selector:', selector, error.message); continue; }
        if (selector) selectors.push(selector);
        anchors.forEach((anchor, index) => {
          const key = JSON.stringify([scope, selector, anchor.dataset?.key || anchor.id || '', index]);
          wanted.add(key);
          renderOne(target, anchor, { ...context, root: native, anchorIndex: index }, key, scope, views, pendingMounts);
        });
      }
      for (const [key, record] of outlets) if (record.scope === scope && !wanted.has(key)) { clear(record); outlets.delete(key); }
      // Different selectors may resolve to the same native element. Preserve
      // the user's order across those groups as well as within each group.
      const anchors = new Map(), ranks = new Map(ordered.map((view, index) => [view.ref, index]));
      for (const record of outlets.values()) if (record.scope === scope) {
        if (!anchors.has(record.native)) anchors.set(record.native, []);
        anchors.get(record.native).push(...record.nodes);
      }
      for (const [anchor, nodes] of anchors) {
        let previous = anchor;
        for (const [, node] of nodes.sort((a, b) => ranks.get(a[0]) - ranks.get(b[0]))) {
          if (node !== previous.nextSibling) anchor.parentNode.insertBefore(node, previous.nextSibling);
          previous = node;
        }
      }
      for (const mount of pendingMounts) void mount();
      watch(scope, target, native, context, selectors);
    }
    return { render,
      hasTarget(target) { return getViews().some(view => view.targets?.includes(target) && (view.mode !== 'replace' || selection(target) === view.ref)); },
      retain(targets) {
        for (const [scope, watcher] of watchers) if (!targets.includes(watcher.target) || !watcher.native.isConnected) unwatch(scope);
        for (const [target, record] of outlets) if (!targets.includes(record.target) || !record.native.isConnected) { clear(record); outlets.delete(target); }
      },
      dispose() { for (const scope of watchers.keys()) unwatch(scope); for (const record of outlets.values()) clear(record); outlets.clear(); }
    };
  }
  return { create };
});
