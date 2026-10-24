'use strict';
(function expose(root) {
  // Native child views do not participate in host DOM clipping or animation.
  // Send only settled, fully visible rectangles, and retain the declarative
  // tree only as the fallback after a bounded load failure. Opening has one
  // presentation, rather than loading text -> declarative tree -> authored UI.
  function create({ document, window, bridge, surface, kind, stateFor, active, reducedMotion, t = key => key, onLayout = () => {}, maxHeight = () => window.innerHeight }) {
    if (!bridge.syncWebSurface || !['rail', 'bubble', 'notch'].includes(kind)) return null;
    const mounts = new Map(), failed = new Map(), openings = new Map(), unknownExpired = new WeakSet();
    let disposed = false;
    let timer = null, pending = false, queued = false, last = '', retries = 0;
    // Main already holds nothing for this host after one empty sync, so
    // mutations, scrolls and dock renders cost nothing until a plugin mounts.
    let idle = false;
    const resize = new window.ResizeObserver(() => refresh());
    function toggle(node, name, value) { if (node.classList.contains(name) !== value) node.classList.toggle(name, value); }
    function show(node, visible) {
      toggle(node, 'pv-web-mounted', visible);
      if (visible) pendingPaint(node, false);
    }
    function pendingPaint(node, value) {
      toggle(node, 'pv-web-pending', value);
      node.setAttribute('aria-busy', String(value));
      if (!value) toggle(node, 'pv-web-waiting', false);
    }
    function forget(node) {
      const opening = openings.get(node);
      clearTimeout(opening?.label); clearTimeout(opening?.deadline);
      openings.delete(node);
    }
    function prepare(mount) {
      const node = mount.container, state = stateFor(mount.ref);
      const doc = state?.status === 'ok' && state.webDocuments?.find(doc => doc.variant === mount.variant);
      if (failed.get(doc?.ref) !== state?.revision) failed.delete(doc?.ref);
      const waiting = (!state && !unknownExpired.has(node)) || Boolean(doc && !failed.has(doc.ref));
      const opening = openings.get(node);
      if (opening?.ref && (opening.ref !== doc?.ref || opening.revision !== state?.revision)) { forget(node); show(node, false); }
      if (!waiting) { forget(node); pendingPaint(node, false); show(node, false); return; }
      if (!openings.has(node)) {
        const opening = { ref: doc?.ref, revision: state?.revision };
        openings.set(node, opening);
        node.dataset.webLoading = t('plugins.view.loading');
        opening.label = setTimeout(() => {
          if (node.classList.contains('pv-web-pending')) node.classList.add('pv-web-waiting');
        }, 200);
        // A failed/never-ready document gets one stable fallback until reopen;
        // late completion must not swap layouts underneath an interacting user.
        opening.deadline = setTimeout(() => {
          const current = stateFor(mount.ref);
          const currentDoc = current?.webDocuments?.find(doc => doc.variant === mount.variant);
          if (node.classList.contains('pv-web-mounted')) return;
          if (currentDoc) failed.set(currentDoc.ref, current.revision); else unknownExpired.add(node);
          forget(node); pendingPaint(node, false); last = ''; refresh();
        }, 5000);
      }
      if (doc) {
        Object.assign(openings.get(node), { ref: doc.ref, revision: state.revision });
        const height = mount.variant === 'compact' ? `${Math.min(doc.height, Math.max(20, node.parentElement?.clientHeight - 8 || doc.height))}px` : `${doc.height}px`;
        if (!node.style.height) node.style.height = height;
      }
      pendingPaint(node, !node.classList.contains('pv-web-mounted'));
    }
    function refresh() { if (!disposed && timer === null && !(idle && !mounts.size)) timer = setTimeout(() => { timer = null; void sync(); }, 16); }
    function theme() {
      const css = window.getComputedStyle(document.documentElement);
      return { colors: { background: '#00000000', text: css.getPropertyValue('--text').trim() || '#eee', muted: css.getPropertyValue('--muted').trim() || '#999', accent: css.getPropertyValue('--accent').trim() || '#8aafff' }, font: window.getComputedStyle(document.body).fontFamily, dark: css.colorScheme !== 'light', reducedMotion: reducedMotion() };
    }
    function surfaceRect(node) {
      let moving = false;
      // Check motion before rejecting transient opacity/bounds. Transition
      // completion may produce no DOM mutation or source update to wake us.
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getKeyframes().some(frame => ['transform', 'opacity', 'filter', 'width', 'height', 'left', 'top', 'zoom', 'clipPath'].some(key => Object.hasOwn(frame, key))))) { refresh(); moving = true; }
      }
      const rect = node.getBoundingClientRect();
      if (rect.width < (kind === 'rail' ? 16 : 40) || rect.height < (kind === 'rail' ? 16 : 40) || rect.x < 0 || rect.y < 0 || rect.right > window.innerWidth + .5 || rect.bottom > window.innerHeight + .5) return null;
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const css = window.getComputedStyle(ancestor);
        if (css.display === 'none' || css.visibility === 'hidden' || (!moving && Number(css.opacity) < .99)) return null;
        if (ancestor !== node && /(hidden|clip|auto|scroll)/.test(`${css.overflowX} ${css.overflowY}`)) {
          const clip = ancestor.getBoundingClientRect();
          if (rect.x < clip.x - .5 || rect.right > clip.right + .5 || rect.y < clip.y - .5 || rect.bottom > clip.bottom + .5) return null;
        }
      }
      return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, present: !moving };
    }
    function fitHeight(node, height) {
      // Dock measures its card before resizing the native window. Clamping to
      // that old window would permanently trap new content at its fallback size.
      if (kind === 'bubble') {
        const parent = node.parentElement, css = window.getComputedStyle(parent);
        const overhead = [...parent.children].filter(child => child !== node).reduce((sum, child) => sum + child.offsetHeight, 0) + (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0) + (parseFloat(css.rowGap) || 0) * Math.max(0, parent.children.length - 1);
        return `${Math.max(40, Math.min(height, maxHeight() - overhead - 12))}px`;
      }
      const rect = node.getBoundingClientRect();
      const scale = rect.width / (node.offsetWidth || rect.width) || 1;
      let bottom = window.innerHeight - 12;
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const css = window.getComputedStyle(ancestor);
        if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) bottom = Math.min(bottom, ancestor.getBoundingClientRect().bottom);
      }
      return `${Math.max(40, Math.min(height, (bottom - rect.y) / scale))}px`;
    }
    async function sync() {
      if (pending) { queued = true; return; }
      const visible = !document.hidden && active() && !document.querySelector('[popover]:popover-open');
      if (!visible) failed.clear();
      const entries = [], offered = new Map();
      for (const [node, mount] of mounts) {
        if (!node.isConnected) { forget(node); resize.unobserve(node); mounts.delete(node); continue; }
        if (!visible) { forget(node); unknownExpired.delete(node); pendingPaint(node, false); } else prepare(mount);
        const state = stateFor(mount.ref);
        const doc = state?.status === 'ok' && state.webDocuments?.find(doc => doc.variant === mount.variant);
        if (failed.get(doc?.ref) !== state?.revision) failed.delete(doc?.ref);
        const authored = doc && !failed.has(doc.ref);
        const compact = Boolean(authored && mount.variant === 'compact');
        const width = compact ? '100%' : '';
        if (node.style.width !== width) node.style.width = width;
        const height = authored ? (compact ? `${Math.min(doc.height, Math.max(20, node.parentElement.clientHeight - 8))}px` : fitHeight(node, doc.height)) : '';
        if (node.style.height !== height) { node.style.height = height; onLayout(); }
        const placement = visible && doc && !failed.has(doc.ref) ? surfaceRect(node) : null;
        if (placement) { const { rect, present } = placement; entries.push({ ref: doc.ref, rect, present, scale: rect.width / (node.offsetWidth || rect.width) || 1 }); offered.set(node, doc.ref); }
        else { show(node, false); if (visible) prepare(mount); }
      }
      const input = { surface, visible, entries, theme: theme() };
      const key = JSON.stringify(input);
      if (key === last) return;
      pending = true;
      try {
        const result = await bridge.syncWebSurface(input);
        last = key;
        idle = !entries.length && !mounts.size;
        for (const [node, mount] of mounts) { show(node, offered.has(node) && result.mounted.includes(offered.get(node))); if (visible) prepare(mount); }
        // Main may defer during native shell movement. A bounded retry stops
        // once the shell settles, the page hides, or a document fails.
        if (entries.length && result.mounted.length !== entries.length && retries++ < 20) { last = ''; setTimeout(refresh, 100); } else retries = 0;
      } catch { last = ''; idle = false; for (const [node, mount] of mounts) { const state = stateFor(mount.ref); for (const doc of state?.webDocuments || []) failed.set(doc.ref, state.revision); forget(node); show(node, false); pendingPaint(node, false); } }
      finally { pending = false; if (queued) { queued = false; refresh(); } }
    }
    bridge.onWebSurfaceReady?.(() => { last = ''; retries = 0; refresh(); });
    bridge.onWebSurfaceFailed?.(({ ref, reason }) => {
      if (['suspended', 'unavailable', 'changed'].includes(reason)) { last = ''; refresh(); return; }
      for (const mount of mounts.values()) if (stateFor(mount.ref)?.webDocuments?.some(doc => doc.ref === ref)) failed.set(ref, stateFor(mount.ref).revision);
      last = ''; refresh();
    });
    document.addEventListener('visibilitychange', () => { last = ''; failed.clear(); refresh(); });
    document.addEventListener('scroll', refresh, true);
    document.addEventListener('toggle', refresh, true);
    window.addEventListener('resize', () => { last = ''; refresh(); });
    const mutation = new window.MutationObserver(refresh);
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    window.addEventListener('pagehide', () => { disposed = true; clearTimeout(timer); for (const node of openings.keys()) forget(node); resize.disconnect(); mutation.disconnect(); void bridge.syncWebSurface({ surface, visible: false }); }, { once: true });
    return { track(mount) { idle = false; for (const doc of stateFor(mount.ref)?.webDocuments || []) failed.delete(doc.ref); const doc = stateFor(mount.ref)?.webDocuments?.find(doc => doc.variant === mount.variant); if (doc && mount.variant === 'full') mount.container.style.height = `${doc.height}px`; mounts.set(mount.container, mount); prepare(mount); resize.observe(mount.container); refresh(); }, prepare, refresh() { last = ''; refresh(); } };
  }
  root.TokenMonitorPluginSurfaceWeb = { create };
})(window);
