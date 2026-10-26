'use strict';

// Trusted same-page modules. Disposal is cooperative; a clean renderer reload
// is required when changing executable revisions or disabling loaded code.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginUi = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function createHost({ document, window, bridge, services = {}, importModule = url => import(url), onError = () => {}, onLoaded = () => {} }) {
    const modules = new Map(), mounts = new Map();
    let disposed = false;
    function report(error, record) {
      onError(error, record?.descriptor);
      record?.context.onMountStatus?.(false);
      if (record && mounts.get(record.container) === record) {
        record.container.replaceChildren();
        const text = document.createElement('p'); text.className = 'plugin-inline-error';
        text.setAttribute('role', 'alert'); text.textContent = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
        record.container.append(text);
      }
    }
    function load(descriptor) {
      const key = `${descriptor.pluginId}:${descriptor.revision}`;
      if (!modules.has(key)) modules.set(key, (async () => {
        const cleanup = [], listeners = new Set();
        let latestData = descriptor.data, released = false;
        cleanup.push(() => { released = true; });
        const ctx = {
          ...services, pluginId: descriptor.pluginId,
          host: { call: (method, args) => bridge.host(descriptor.pluginId, method, args) },
          data: {
            query: query => bridge.host(descriptor.pluginId, 'data.query', query),
            async subscribe(query, listener) {
              const waiting = [];
              let subscription, cancelled = false;
              const dispose = () => {
                if (cancelled) return;
                cancelled = true; off();
                if (subscription !== undefined) void bridge.unsubscribeData(subscription).catch(error => onError(error, descriptor));
              };
              const off = bridge.onData(message => {
                if (subscription === undefined) waiting.push(message);
                else if (message.subscription === subscription) listener(message.value);
              });
              cleanup.push(dispose);
              try { subscription = await bridge.subscribeData(descriptor.pluginId, query); }
              catch (error) { dispose(); throw error; }
              if (cancelled || released || disposed) {
                off(); await bridge.unsubscribeData(subscription);
                return () => {};
              }
              for (const message of waiting) if (message.subscription === subscription) listener(message.value);
              return dispose;
            }
          },
          backend: { call: (method, args) => bridge.call(descriptor.pluginId, method, args),
            subscribe(listener) { listeners.add(listener); if (latestData !== undefined) listener(latestData); return () => listeners.delete(listener); } },
          onDispose(fn) { cleanup.push(fn); },
          asset: name => new URL(name, descriptor.entry).href
        };
        const off = bridge.subscribe?.(descriptor.pluginId, value => {
          latestData = value;
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
          if (typeof instance?.mount !== 'function' && typeof instance?.renderTray !== 'function') throw new Error('Plugin UI must implement mount or renderTray');
          cleanup.push(() => instance.dispose?.());
          const loaded = { instance, ctx, cleanup };
          modules.get(key).loaded = loaded;
          onLoaded(descriptor);
          return loaded;
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
        try { await previous.instance?.update?.(context(previous)); } catch (error) { report(error, previous); return; }
        if (mounts.get(container) === previous && previous.instance) previous.context.onMountStatus?.(true);
        return;
      }
      unmount(container);
      const record = { container, descriptor, context: value };
      mounts.set(container, record);
      try {
        const loaded = await load(descriptor);
        if (disposed || mounts.get(container) !== record) return;
        if (typeof loaded.instance.mount !== 'function') throw new Error('This plugin has no content mount');
        const initialContext = record.context;
        record.instance = (await loaded.instance.mount(container, context(record))) || {};
        if (disposed || mounts.get(container) !== record) { record.instance?.dispose?.(); return; }
        if (record.context !== initialContext) await record.instance.update?.(context(record));
        record.context.onMountStatus?.(true);
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
      setVisibility(container, visible) {
        const record = mounts.get(container);
        if (!record || record.context.visible === visible) return;
        record.context = { ...record.context, visible };
        Promise.resolve(record.instance?.update?.(context(record))).catch(error => report(error, record));
      },
      load,
      renderTray(descriptor, canvas, context) {
        const key = `${descriptor.pluginId}:${descriptor.revision}`;
        const loaded = modules.get(key)?.loaded;
        if (!loaded) { void load(descriptor).catch(onError); return false; }
        if (loaded.trayFailed || typeof loaded.instance.renderTray !== 'function') return false;
        try {
          loaded.instance.renderTray(canvas, { ...context, data: descriptor.data, viewId: descriptor.id });
          return true;
        } catch (error) { loaded.trayFailed = true; onError(error, descriptor); return false; }
      },
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
