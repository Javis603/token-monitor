'use strict';

// Trusted same-page modules. Disposal is cooperative; a clean renderer reload
// is required when changing executable revisions or disabling loaded code.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginUi = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function createHost({ document, window, bridge, services = {}, importModule = url => import(url), onError = () => {} }) {
    const modules = new Map(), mounts = new Map();
    let disposed = false;
    function report(error, record) {
      onError(error, record?.descriptor);
      if (record && mounts.get(record.container) === record) {
        record.container.replaceChildren();
        const text = document.createElement('p'); text.className = 'plugin-inline-error';
        text.setAttribute('role', 'alert'); text.textContent = String(error?.message || error);
        record.container.append(text);
      }
    }
    function load(descriptor) {
      const key = `${descriptor.pluginId}:${descriptor.revision}`;
      if (!modules.has(key)) modules.set(key, (async () => {
        const cleanup = [], listeners = new Set();
        const ctx = {
          ...services, pluginId: descriptor.pluginId,
          backend: { call: (method, args) => bridge.call(descriptor.pluginId, method, args),
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
          onDispose(fn) { cleanup.push(fn); },
          asset: name => new URL(name, descriptor.entry).href
        };
        const off = bridge.subscribe?.(descriptor.pluginId, value => {
          for (const fn of listeners) { try { fn(value); } catch (error) { onError(error, descriptor); } }
        });
        if (off) cleanup.push(off);
        for (const href of descriptor.css || []) {
          const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href;
          document.head.append(link); cleanup.push(() => link.remove());
        }
        try {
          const module = await importModule(descriptor.entry);
          const instance = module.activate ? await module.activate(ctx) : module;
          if (typeof instance?.mount !== 'function') throw new Error('Plugin UI must implement mount(container, context)');
          cleanup.push(() => instance.dispose?.());
          return { instance, ctx, cleanup };
        } catch (error) { for (const fn of cleanup.reverse()) { try { fn(); } catch {} } throw error; }
      })());
      return modules.get(key);
    }
    function context(record) {
      return { ...record.context, viewId: record.descriptor.id, ref: record.descriptor.ref,
        data: record.descriptor.data, container: record.container };
    }
    function unmount(container) {
      const record = mounts.get(container);
      if (!record) return;
      mounts.delete(container); record.observer?.disconnect();
      try { record.instance?.dispose?.(); } catch (error) { onError(error, record.descriptor); }
      container.replaceChildren();
    }
    async function mount(container, descriptor, value = {}) {
      if (disposed) return;
      const previous = mounts.get(container);
      if (previous && previous.descriptor.ref === descriptor.ref && previous.descriptor.revision === descriptor.revision) {
        previous.descriptor = descriptor; previous.context = { ...previous.context, ...value };
        try { await previous.instance?.update?.(context(previous)); } catch (error) { report(error, previous); }
        return;
      }
      unmount(container);
      const record = { container, descriptor, context: value };
      mounts.set(container, record);
      try {
        const loaded = await load(descriptor);
        if (disposed || mounts.get(container) !== record) return;
        record.instance = await loaded.instance.mount(container, context(record));
        if (disposed || mounts.get(container) !== record) { record.instance?.dispose?.(); return; }
        if (window.ResizeObserver) {
          record.observer = new window.ResizeObserver(entries => {
            const bounds = entries[0]?.contentRect;
            if (!bounds) return;
            record.context = { ...record.context, width: bounds.width, height: bounds.height };
            Promise.resolve(record.instance?.update?.(context(record))).catch(error => report(error, record));
          });
          record.observer.observe(container);
        }
      } catch (error) { report(error, record); }
    }
    return { mount, unmount,
      hasUnsavedChanges() { return [...mounts.values()].some(record => record.instance?.hasUnsavedChanges?.() === true); },
      sweep() { for (const container of mounts.keys()) if (!container.isConnected) unmount(container); },
      async dispose() {
        disposed = true;
        for (const container of [...mounts.keys()]) unmount(container);
        for (const promise of modules.values()) {
          try { const module = await promise; for (const fn of module.cleanup.reverse()) await fn(); } catch (error) { onError(error); }
        }
        modules.clear();
      }
    };
  }
  return { createHost };
});
