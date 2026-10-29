'use strict';

// Trusted same-page modules. Disposal is cooperative; a clean renderer reload
// remains the recovery path for changed code or failed/unresponsive cleanup.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginUi = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function createHost({ document, window, bridge, services = {}, importModule = url => import(url), onError = () => {}, onLoaded = () => {} }) {
    const owners = new WeakMap();
    const modules = new Map(), mounts = new Map(), blocked = new Set(), jobs = new Map(), failures = new Map();
    let disposed = false;
    function report(error, record) {
      if (record && (disposed || mounts.get(record.container) !== record || record.failed)) return;
      if (record) { record.failed = true; record.observer?.disconnect(); }
      onError(error, record?.descriptor);
      record?.context.onMountStatus?.(false);
      if (record && mounts.get(record.container) === record) {
        record.container.replaceChildren(); record.headerActions?.remove();
        const text = document.createElement('p'); text.className = 'plugin-inline-error';
        text.setAttribute('role', 'alert'); text.textContent = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
        record.container.append(text);
      }
    }
    function track(id, operation) {
      const pending = Promise.resolve(operation).catch(error => {
        failures.set(id, String(error?.message || error)); onError(error);
      });
      if (!jobs.has(id)) jobs.set(id, new Set());
      jobs.get(id).add(pending);
      void pending.finally(() => { jobs.get(id)?.delete(pending); if (!jobs.get(id)?.size) jobs.delete(id); });
      return pending;
    }
    function cleanup(id, fn) {
      try { return track(id, fn()); }
      catch (error) { return track(id, Promise.reject(error)); }
    }
    function load(descriptor) {
      if (disposed || blocked.has(descriptor.pluginId)) return Promise.reject(new Error('Plugin UI is disabled'));
      const key = `${descriptor.pluginId}:${descriptor.revision}`;
      if (!modules.has(key)) modules.set(key, (async () => {
        // Register ownership before importing author code, including pending activation.
        bridge.uiLoading?.(descriptor.pluginId);
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
                const index = cleanup.indexOf(dispose);
                if (index >= 0) cleanup.splice(index, 1);
                waiting.length = 0;
                if (subscription !== undefined) return track(descriptor.pluginId, bridge.unsubscribeData(subscription));
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
              waiting.length = 0;
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
          const loaded = { instance, ctx, cleanup, release() { released = true; } };
          modules.get(key).loaded = loaded;
          if (!disposed && !blocked.has(descriptor.pluginId)) onLoaded(descriptor);
          return loaded;
        } catch (error) { for (const fn of cleanup.splice(0).reverse()) { try { await fn(); } catch (cause) { failures.set(descriptor.pluginId, String(cause)); onError(cause); } } throw error; }
      })());
      return modules.get(key);
    }
    function context(record) {
      return { ...record.context, viewId: record.descriptor.id, ref: record.descriptor.ref,
        data: record.descriptor.data, container: record.container, headerActions: record.headerActions };
    }
    function update(record) {
      if (record.failed || disposed || blocked.has(record.descriptor.pluginId) || mounts.get(record.container) !== record || !record.instance) return;
      record.needsUpdate = true;
      if (record.updating) return record.updating;
      let settle;
      const pending = track(record.descriptor.pluginId, new Promise(resolve => { settle = resolve; }));
      // Register before entering author code, including a synchronous reentrant
      // update. While busy, retain only the latest context rather than invoking
      // overlapping callbacks which can paint stale data after a newer result.
      record.updating = pending;
      (record.updates ||= new Set()).add(pending);
      void (async () => {
        try {
          while (record.needsUpdate && !record.failed && !disposed
            && !blocked.has(record.descriptor.pluginId) && mounts.get(record.container) === record) {
            record.needsUpdate = false;
            try { await record.instance.update?.(context(record)); }
            catch (error) { report(error, record); }
          }
        } finally {
          record.updating = null; record.updates.delete(pending); settle();
        }
      })();
      return pending;
    }
    function unmount(container) {
      const record = mounts.get(container);
      if (!record) return;
      mounts.delete(container); record.observer?.disconnect();
      record.headerActions?.remove();
      record.context.onMountStatus?.(false);
      if (record.instance) cleanup(record.descriptor.pluginId, async () => {
        try {
          if (record.updates?.size) await Promise.all([...record.updates]);
          await record.instance.dispose?.();
        } finally {
          // A settled redraw may have repopulated this now-unmounted container.
          // Never clear a newer mount that has since taken ownership.
          if (owners.get(container) === record) container.replaceChildren();
        }
      });
      container.replaceChildren();
    }
    function syncHeaderActions(record, parent) {
      if (!parent) { record.headerActions?.remove(); record.headerActions = undefined; return; }
      if (!record.headerActions) {
        record.headerActions = document.createElement('div');
        record.headerActions.className = 'plugin-header-actions-mount';
      }
      if (record.headerActions.parentNode !== parent) parent.append(record.headerActions);
    }
    async function mountRecord(container, descriptor, value = {}) {
      if (disposed || blocked.has(descriptor.pluginId)) return;
      const previous = mounts.get(container);
      if (previous && previous.descriptor.ref === descriptor.ref && previous.descriptor.revision === descriptor.revision) {
        previous.descriptor = descriptor; previous.context = { ...previous.context, ...value, headerActions: value.headerActions };
        if (previous.failed) { previous.context.onMountStatus?.(false); return; }
        syncHeaderActions(previous, value.headerActions);
        await update(previous);
        if (mounts.get(container) === previous && previous.instance && !previous.failed) previous.context.onMountStatus?.(true);
        return;
      }
      unmount(container);
      const record = { container, descriptor, context: value };
      syncHeaderActions(record, value.headerActions);
      mounts.set(container, record); owners.set(container, record);
      try {
        const loaded = await load(descriptor);
        if (disposed || blocked.has(descriptor.pluginId) || mounts.get(container) !== record) return;
        if (typeof loaded.instance.mount !== 'function') throw new Error('This plugin has no content mount');
        const initialContext = record.context;
        record.instance = (await loaded.instance.mount(container, context(record))) || {};
        if (disposed || mounts.get(container) !== record) { await cleanup(descriptor.pluginId, () => record.instance?.dispose?.()); return; }
        if (blocked.has(descriptor.pluginId)) return;
        if (record.context !== initialContext) await update(record);
        if (disposed || blocked.has(descriptor.pluginId) || mounts.get(container) !== record || record.failed) return;
        record.context.onMountStatus?.(true);
        if (window.ResizeObserver) {
          record.observer = new window.ResizeObserver(entries => {
            const bounds = entries[0]?.contentRect;
            if (!bounds) return;
            record.context = { ...record.context, width: bounds.width, height: bounds.height };
            void update(record);
          });
          record.observer.observe(container);
        }
      } catch (error) { report(error, record); }
      finally {
        // A pending mount can append after unmount, even before rejecting.
        // Its cleanup must not clear a newer mount in the same container.
        if (mounts.get(container) !== record && owners.get(container) === record) container.replaceChildren();
      }
    }
    function mount(container, descriptor, value) {
      return track(descriptor.pluginId, mountRecord(container, descriptor, value));
    }
    function hasUnsavedChanges(ids) {
      return [...mounts.values()].some(record => (!ids || ids.includes(record.descriptor.pluginId)) && record.instance?.hasUnsavedChanges?.() === true);
    }
    async function release(ids) {
      for (const id of ids) blocked.add(id);
      // Let in-flight activation/mount/update settle before disposal, so an
      // asynchronous update cannot recreate resources after its cleanup ran.
      // Main bounds this wait; hung author code requires renderer recovery.
      for (const id of ids) while (jobs.has(id)) await Promise.all([...jobs.get(id)]);
      for (const [container, record] of mounts) if (ids.includes(record.descriptor.pluginId)) unmount(container);
      for (const id of ids) while (jobs.has(id)) await Promise.all([...jobs.get(id)]);
      for (const [key, promise] of modules) {
        const id = key.slice(0, key.indexOf(':'));
        if (!ids.includes(id)) continue;
        try {
          const loaded = await promise; loaded.release();
          for (const fn of loaded.cleanup.splice(0).reverse()) await cleanup(id, fn);
        } catch { /* failed activation already drained its owned resources */ }
        modules.delete(key);
      }
      for (const id of ids) while (jobs.has(id)) await Promise.all([...jobs.get(id)]);
      const errors = ids.flatMap(id => failures.has(id) ? [`${id}: ${failures.get(id)}`] : []);
      if (errors.length) throw new Error(errors.join('; '));
    }
    const offLifecycle = bridge.onLifecycle?.(async ({ action, ids }) => {
      if (action === 'inspect') return { loaded: [...modules.keys()].some(key => ids.some(id => key.startsWith(id + ':'))), unsaved: hasUnsavedChanges(ids) };
      if (action === 'release') { await release(ids); return {}; }
      if (action === 'resume') { for (const id of ids) if (!failures.has(id)) blocked.delete(id); return {}; }
      throw new Error('Unknown plugin lifecycle operation');
    });
    return { mount, unmount, release,
      setVisibility(container, visible) {
        const record = mounts.get(container);
        if (!record || record.context.visible === visible) return;
        record.context = { ...record.context, visible };
        void update(record);
      },
      load,
      renderTray(descriptor, canvas, context) {
        if (blocked.has(descriptor.pluginId) || disposed) return false;
        const key = `${descriptor.pluginId}:${descriptor.revision}`;
        const loaded = modules.get(key)?.loaded;
        if (!loaded) { void load(descriptor).catch(onError); return false; }
        if (loaded.trayFailed || typeof loaded.instance.renderTray !== 'function') return false;
        try {
          loaded.instance.renderTray(canvas, { ...context, data: descriptor.data, viewId: descriptor.id });
          return true;
        } catch (error) { loaded.trayFailed = true; onError(error, descriptor); return false; }
      },
      hasUnsavedChanges,
      sweep() { for (const container of mounts.keys()) if (!container.isConnected) unmount(container); },
      async dispose() {
        disposed = true; offLifecycle?.();
        const ids = [...new Set([...modules.keys()].map(key => key.slice(0, key.indexOf(':'))))];
        try { await release(ids); } catch (error) { onError(error); }
      }
    };
  }
  return { createHost };
});
