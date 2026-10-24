'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginPresentationWeb = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Native children cannot inherit DOM clips. Admit only a fully unobstructed
  // rectangle; scrolling, overlays and motion restore the lightweight tree.
  function rectangle(node, document, window) {
    if (!node.isConnected || document.hidden) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40 || rect.x < 0 || rect.y < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) return null;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const css = window.getComputedStyle(ancestor);
      if (css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) < .99 || css.clipPath && css.clipPath !== 'none') return null;
      if (ancestor.getAnimations?.().some(a => a.playState === 'running')) return null;
      if (ancestor !== node && /(hidden|clip|auto|scroll)/.test(`${css.overflowX} ${css.overflowY}`)) {
        const clip = ancestor.getBoundingClientRect();
        const left = clip.x + ancestor.clientLeft, top = clip.y + ancestor.clientTop;
        if (rect.x < left || rect.y < top || rect.right > left + ancestor.clientWidth || rect.bottom > top + ancestor.clientHeight) return null;
      }
    }
    // Check the full region for host overlays, not just one center hit.
    for (const overlay of document.querySelectorAll('[popover]:popover-open, dialog[open], [role="dialog"], [role="tooltip"], .select-control-menu, .context-menu')) {
      const css = window.getComputedStyle(overlay), box = overlay.getBoundingClientRect();
      if (css.display !== 'none' && css.visibility !== 'hidden' && box.width && box.height && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top) return null;
    }
    for (const x of [rect.left + 1, rect.left + rect.width / 2, rect.right - 1]) for (const y of [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1]) {
      const top = document.elementFromPoint(x, y);
      if (!top || !(top === node || node.contains(top))) return null;
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  function create({ document, window, bridge, surface, stateFor, active = () => true, reducedMotion = () => false }) {
    if (!bridge?.syncWebPresentation) return null;
    const mounts = new Map(), removers = [];
    let serial = 0, disposed = false, pending = false, queued = false, timer = null, settle = null, blocked = false, last = '', generation = 0, advertised = false;
    const resize = new window.ResizeObserver(() => invalidate());
    const show = (node, value) => {
      if (node.classList.contains('pv-web-mounted') !== value) node.classList.toggle('pv-web-mounted', value);
      // opacity keeps the fallback in hit testing while preventing duplicate paint.
      for (const child of node.children) child.style.visibility = value ? 'hidden' : '';
    };
    function schedule() { if (!disposed && timer === null) timer = setTimeout(() => { timer = null; void sync(); }, 16); }
    function eligible() {
      return [...mounts].some(([node, mount]) => {
        const state = stateFor(mount.ref);
        return node.isConnected && (!mount.failed || mount.revision !== state?.revision) && state?.status === 'ok' && state.webDocuments?.some(doc => !doc.variant || doc.variant === 'full');
      });
    }
    function refresh() { generation++; if (mounts.size || advertised) schedule(); }
    function invalidate() { if (advertised || eligible()) refresh(); }
    function retry() { last = ''; invalidate(); }
    function hide() {
      if (!advertised) return;
      advertised = false; last = '';
      void bridge.syncWebPresentation({ surface, visible: false }).catch(() => {});
    }
    function suspend() {
      if (disposed || (!advertised && !eligible())) return;
      generation++;
      if (!blocked) for (const node of mounts.keys()) show(node, false);
      blocked = true;
      // Fence a pending visible response and park once per visible transition.
      hide();
      clearTimeout(settle); settle = null;
      if (!document.hidden && eligible()) settle = setTimeout(() => { blocked = false; invalidate(); }, 120);
      else blocked = false;
    }
    function theme() {
      const css = window.getComputedStyle(document.documentElement);
      return { colors: { background: '#00000000', text: css.getPropertyValue('--text').trim() || '#eee', muted: css.getPropertyValue('--muted').trim() || '#999', accent: css.getPropertyValue('--accent').trim() || '#8aafff' }, font: window.getComputedStyle(document.body).fontFamily, dark: css.colorScheme !== 'light', reducedMotion: reducedMotion() };
    }
    async function sync() {
      if (disposed) return;
      if (pending) { queued = true; return; }
      const version = generation, visible = !blocked && !document.hidden && active(), entries = [];
      for (const [node, mount] of mounts) {
        if (!node.isConnected) { resize.unobserve(node); mounts.delete(node); continue; }
        const state = stateFor(mount.ref), doc = state?.status === 'ok' && state.webDocuments?.find(doc => !doc.variant || doc.variant === 'full');
        if (mount.revision !== state?.revision || mount.document !== doc?.ref) { last = ''; mount.failed = false; mount.revision = state?.revision; mount.document = doc?.ref; mount.started = 0; }
        const height = doc ? `${doc.height}px` : '';
        if (node.style.height !== height) node.style.height = height;
        // Temporarily remove the fallback-hiding class for DOM hit testing.
        const shown = node.classList.contains('pv-web-mounted');
        if (shown) show(node, false);
        const rect = visible && doc && !mount.failed ? rectangle(node, document, window) : null;
        if (shown && rect) show(node, true);
        if (rect && entries.length < 4) {
          if (!mount.started) mount.started = Date.now();
          if (!shown && Date.now() - mount.started > 5000) mount.failed = true;
          else entries.push({ instance: mount.instance, viewRef: mount.ref, ref: doc.ref, rect });
        } else { mount.started = 0; show(node, false); }
      }
      if (!entries.length) { hide(); return; }
      const input = { surface, visible, entries, theme: theme() }, key = JSON.stringify(input);
      if (key === last) return;
      pending = true; advertised = true;
      try {
        const result = await bridge.syncWebPresentation(input);
        if (disposed || version !== generation) { queued = true; return; }
        last = key;
        for (const [node, mount] of mounts) {
          const entry = entries.find(entry => entry.instance === mount.instance);
          const mounted = Boolean(entry && result.mounted.includes(mount.instance));
          mount.rect = mounted ? entry.rect : null;
          show(node, mounted);
        }
        if (entries.some(entry => !result.mounted.includes(entry.instance))) { clearTimeout(settle); settle = setTimeout(retry, 100); }
      } catch { if (!disposed && version === generation) for (const [node, mount] of mounts) { mount.failed = true; show(node, false); } }
      finally { pending = false; if (queued) { queued = false; schedule(); } }
    }
    function listen(target, name, fn, options) { target.addEventListener(name, fn, options); removers.push(() => target.removeEventListener(name, fn, options)); }
    removers.push(bridge.onWebPresentationReady?.(retry), bridge.onWebPresentationFailed?.(({ instance }) => { for (const mount of mounts.values()) if (mount.instance === instance) mount.failed = true; invalidate(); }));
    // Document-wide observation starts with the first mount: a window that
    // never shows a plugin keeps no subtree observer or capture listeners.
    let armed = false;
    function arm() {
      if (armed || disposed) return;
      armed = true;
      listen(document, 'scroll', suspend, true); listen(window, 'resize', suspend);
      listen(document, 'visibilitychange', suspend); listen(document, 'toggle', suspend, true);
      listen(document, 'transitionrun', suspend, true); listen(document, 'transitionend', invalidate, true);
      listen(document, 'animationend', invalidate, true);
      mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
    }
    const mutation = new window.MutationObserver(records => {
      if (!advertised && !eligible()) return;
      // Ignore our own class/height writes; they would create an idle loop.
      if (!records.some(record => !mounts.has(record.target) && ![...mounts.keys()].some(node => node.contains(record.target)))) return;
      // Host counters and sibling controls can repaint without moving a native
      // child. Only park if its admitted rectangle is now unsafe or has moved;
      // otherwise refresh context without flashing the lightweight fallback.
      for (const [node, mount] of mounts) {
        if (!node.classList.contains('pv-web-mounted')) continue;
        const rect = rectangle(node, document, window);
        if (!rect || !mount.rect || ['x', 'y', 'width', 'height'].some(key => rect[key] !== mount.rect[key])) { suspend(); return; }
      }
      invalidate();
    });
    function dispose() {
      if (disposed) return; disposed = true; generation++;
      clearTimeout(timer); clearTimeout(settle); resize.disconnect(); mutation.disconnect(); removers.forEach(off => off?.());
      for (const node of mounts.keys()) show(node, false);
      mounts.clear(); hide();
    }
    listen(window, 'pagehide', dispose, { once: true });
    return { track(mount) { arm(); mounts.set(mount.container, { ...mount, instance: `presentation-${++serial}` }); resize.observe(mount.container); refresh(); }, refresh, suspend, dispose };
  }
  return { create, rectangle };
});
