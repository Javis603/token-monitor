'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginViews = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const ICON_PATHS = Object.freeze({
    cpu: 'M8 4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3',
    memory: 'M3 7h18v10H3zM7 10v4M11 10v4M15 10v4M6 17v3M10 17v3M14 17v3M18 17v3',
    gauge: 'M4 18a8 8 0 1 1 16 0M12 18l4-6M8 18h8',
    bolt: 'M13 2 5 13h6l-1 9 8-11h-6l1-9z',
    clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2',
    pulse: 'M2 12h4l2-6 4 12 3-9 2 3h5',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    alert: 'M12 3 2 20h20L12 3zM12 9v5M12 17v.5',
    check: 'M4 12l5 5L20 6',
    dot: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
    token: 'M12 2l8.5 5v10L12 22l-8.5-5V7L12 2zM12 7v10M8 9.5l8 5M16 9.5l-8 5',
    globe: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
    battery: 'M3 8h15v8H3zM18 11h3v2h-3M6 11v2M9 11v2',
    thermometer: 'M10 4a2 2 0 0 1 4 0v10a4 4 0 1 1-4 0zM12 10v7'
  });


  function actionErrorMessage(error, t) {
    const message = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    return t ? t('settings.plugins.actionFailed', { error: message }) : message;
  }
  function iconNode(document, name, path, size = 16) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: 'pv-icon' })) node.setAttribute(key, String(value));
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key, value] of Object.entries({ d: path || ICON_PATHS[name] || ICON_PATHS.dot, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) shape.setAttribute(key, String(value));
    node.append(shape); return node;
  }
  // Navigation uses validated manifest metadata, without loading author code/CSS.
  function navigationIcon(document, view, size = 16) {
    const node = document.createElement('span');
    node.setAttribute('aria-hidden', 'true');
    Object.assign(node.style, { display: 'inline-flex', width: `${size}px`, height: `${size}px`, flexShrink: '0' });
    const fallback = () => node.replaceChildren(iconNode(document, view?.icon || 'dot', null, size));
    if (view?.identityIcon) {
      const image = document.createElement('img');
      image.alt = ''; image.width = size; image.height = size;
      image.style.objectFit = 'contain';
      image.addEventListener('error', fallback, { once: true });
      image.src = view.identityIcon;
      node.append(image);
    } else fallback();
    return node;
  }
  function drawIcon(ctx, name, { x, y, size, color }) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(ICON_PATHS[name] || ICON_PATHS.dot));
    ctx.restore();
  }


  function applyAppearance(container, value = {}) {
    for (const [key, choices] of Object.entries({ font: ['inherit', 'system', 'mono'], density: ['compact', 'standard', 'comfortable'], corners: ['square', 'rounded', 'soft'], panel: ['plain', 'outline', 'soft'] })) container.dataset[`pv${key[0].toUpperCase()}${key.slice(1)}`] = choices.includes(value[key]) ? value[key] : choices[key === 'density' || key === 'corners' ? 1 : 0];
    for (const [key, property] of Object.entries({ accent: '--plugin-accent', chart: '--plugin-chart', text: '--plugin-default', muted: '--plugin-muted', background: '--pv-background' })) {
      if (/^#[0-9a-f]{6}$/i.test(value.colors?.[key] || '')) container.style.setProperty(property, value.colors[key]);
      else container.style.removeProperty(property);
    }
  }

  function createPluginViewHost({ document, window, t, onDemand = () => {}, isSurfaceActive = () => true, services = {}, getContext = () => ({}), onLoaded = () => {} }) {
    const intersections = new Map();
    const mounts = new Map(), latest = new Map(), explicit = new Map(), lastDemand = new Map();
    const bridge = window.tokenMonitorTrustedPlugins;
    const ui = window.TokenMonitorPluginUi.createHost({ document, window, bridge, services,
      onLoaded, onError: error => console.error('[plugins]', error) });
    const pending = new Map();
    let frame = null, appearance = {}, disposed = false;
    const observer = window.IntersectionObserver ? new window.IntersectionObserver(entries => {
      for (const entry of entries) intersections.set(entry.target, entry.isIntersecting);
      refreshDemand();
    }) : null;
    const state = (surface, ref) => latest.get(surface)?.[ref] || null;
    function paint(mount) {
      applyAppearance(mount.container, appearance);
      const value = state(mount.surface, mount.ref) || (!latest.has(mount.surface) ? mount.options.descriptor : null);
      if (value?.entry) {
        const context = { ...mount.options, ...getContext(mount.surface), surface: mount.surface };
        // A slot can refine the surface's generic variant (e.g. Notch summary).
        if (Object.hasOwn(mount.options, 'surfaceVariant')) context.surfaceVariant = mount.options.surfaceVariant;
        void ui.mount(mount.container, value, context);
      }
      else { mount.options.onMountStatus?.(false); ui.unmount(mount.container); mount.container.textContent = value ? t?.('settings.plugins.status.' + value.status) || value.status : ''; }
    }
    function computeDemand() {
      frame = null; ui.sweep();
      const bySurface = new Map([...explicit].map(([surface, refs]) => [surface, new Set(refs)]));
      for (const [container, mount] of mounts) {
        if (!container.isConnected) { mounts.delete(container); observer?.unobserve(container); intersections.delete(container); continue; }
        if (!bySurface.has(mount.surface)) bySurface.set(mount.surface, new Set());
        const visible = document.visibilityState !== 'hidden' && isSurfaceActive(mount.surface, container) && container.getClientRects().length > 0 && intersections.get(container) !== false;
        ui.setVisibility(container, visible);
        if (visible) bySurface.get(mount.surface).add(mount.ref);
      }
      for (const surface of new Set([...lastDemand.keys(), ...bySurface.keys()])) {
        const refs = [...(bySurface.get(surface) || [])].sort(), key = refs.join(',');
        if (lastDemand.get(surface) !== key) { lastDemand.set(surface, key); onDemand(surface, refs); }
      }
    }
    function refreshDemand() {
      if (document.visibilityState === 'hidden') { if (frame !== null) window.cancelAnimationFrame(frame); computeDemand(); }
      else if (frame === null) frame = window.requestAnimationFrame(computeDemand);
    }
    document.addEventListener('visibilitychange', refreshDemand);
    return {
      state,
      descriptors: surface => Object.values(latest.get(surface) || {}),
      unmount(container) { mounts.delete(container); observer?.unobserve(container); intersections.delete(container); ui.unmount(container); refreshDemand(); },
      renderTray: (descriptor, canvas, context) => ui.renderTray(descriptor, canvas, context),
      mount(container, ref, surface, options = {}) {
        if (disposed) return;
        const current = mounts.get(container);
        if (!current || current.ref !== ref || current.surface !== surface) mounts.set(container, { container, ref, surface, options });
        else current.options = options;
        observer?.observe(container);
        paint(mounts.get(container)); refreshDemand();
        if (!latest.has(surface) && !pending.has(surface)) {
          const request = Promise.resolve().then(() => bridge.views(surface)).then(payload => {
            if (disposed || latest.has(surface)) return;
            latest.set(surface, payload.views || {});
            for (const mount of mounts.values()) if (mount.surface === surface) paint(mount);
          }).catch(error => { if (!disposed) console.error('[plugins]', error); }).finally(() => pending.delete(surface));
          pending.set(surface, request);
        }
      },
      update(payload) { appearance = payload.appearance || {}; latest.set(payload.surface, payload.views || {}); for (const mount of mounts.values()) if (mount.surface === payload.surface) paint(mount); refreshDemand(); },
      setExplicitDemand(surface, refs) {
        explicit.set(surface, refs);
        for (const ref of refs) { const descriptor = state(surface, ref); if (descriptor?.entry) void ui.load(descriptor).catch(error => console.error(error)); }
        refreshDemand();
      },
      refreshContext({ includeContent = true } = {}) {
        for (const mount of mounts.values()) if (includeContent || !mount.options.target) paint(mount);
      },
      refreshDemand, refreshMotion: refreshDemand,
      hasUnsavedChanges: ui.hasUnsavedChanges,
      dispose() { disposed = true; observer?.disconnect(); if (frame !== null) window.cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', refreshDemand); return ui.dispose(); }
    };
  }
  return { iconNode, navigationIcon, drawIcon, actionErrorMessage, createPluginViewHost };
});
