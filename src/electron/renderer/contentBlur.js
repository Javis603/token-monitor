'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorContentBlur = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const SURFACES = '.view-switcher-menu, .select-control-popup, .plugin-menu, .settings-help-popover, '
    + '.app-update-popover, .sync-content-dialog, .plugin-catalog-dialog, .custom-pricing-help, '
    + '.tray-composer-popover, .tray-composer-picker-menu, .limit-detail-tooltip';
  const NS = 'http://www.w3.org/2000/svg';
  let nextId = 0;

  // Top-layer surfaces are excluded from ancestor filters. Filter each source
  // once, using the union of the higher surfaces' rectangles as its mask. This
  // also blurs a dialog behind a select without blurring the select's own text.
  function create({ document, window = document.defaultView, root }) {
    const definitions = document.createElementNS(NS, 'svg');
    definitions.setAttribute('class', 'content-blur-definitions');
    definitions.setAttribute('aria-hidden', 'true');
    definitions.setAttribute('focusable', 'false');
    document.body.append(definitions);
    const active = [];
    const sources = new Map();
    let frame = null;
    let disposed = false;
    let observed = [];
    const node = (name, attributes = {}) => {
      const element = document.createElementNS(NS, name);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
      return element;
    };
    // Logical closing happens before display/overlay exit transitions finish.
    // Let the browser's top-layer lifetime decide when its mask can disappear.
    const isVisible = surface => surface.isConnected && (surface.matches(':popover-open, :modal')
      || window.getComputedStyle(surface).overlay === 'auto');
    const enabled = () => !document.hidden
      && !document.documentElement.classList.contains('native-reduced-transparency')
      && !document.documentElement.classList.contains('native-material-opaque');
    const layoutEvents = ['scroll', 'input', 'change', 'load', 'transitionrun', 'transitionend',
      'transitioncancel', 'animationstart', 'animationend', 'animationcancel'];
    const resizeObserver = new window.ResizeObserver(layoutChanged);
    const layoutObserver = new window.MutationObserver(records => {
      // Updating our SVG graph must not wake the controller again.
      if (records.some(record => !definitions.contains(record.target))) layoutChanged();
    });

    function stopObserving() {
      resizeObserver.disconnect();
      layoutObserver.disconnect();
      observed = [];
    }

    function observeLayout() {
      if (observed.length === active.length && observed.every((surface, index) => surface === active[index])) return;
      stopObserving();
      observed = [...active];
      for (const source of [root, ...active]) resizeObserver.observe(source);
      layoutObserver.observe(document.body, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
    }

    function layoutChanged() {
      if (active.length && enabled()) schedule();
    }

    function isAnimating() {
      return document.getAnimations().some(animation => {
        if (animation.playState !== 'running' && !animation.pending) return false;
        const target = animation.effect?.target;
        if (!target) return false;
        // Finite page animations can move CSS anchors. Unrelated infinite
        // spinners must not keep an otherwise stationary menu polling forever.
        return active.some(surface => target.contains(surface))
          || (root.contains(target) && animation.effect.getComputedTiming().endTime !== Infinity);
      });
    }

    function release(source) {
      const record = sources.get(source);
      if (!record) return;
      source.classList.remove('content-blur-source');
      source.style.removeProperty('--content-blur-filter');
      record.filter.remove();
      sources.delete(source);
    }

    function filterSource(source, rectangles) {
      if (!rectangles.length) { release(source); return; }
      let record = sources.get(source);
      if (!record) {
        const id = `content-blur-${++nextId}`;
        const filter = node('filter', { id, x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' });
        definitions.append(filter);
        record = { filter, geometry: '' };
        sources.set(source, record);
        source.style.setProperty('--content-blur-filter', `url(#${id})`);
        source.classList.add('content-blur-source');
      }
      const geometry = JSON.stringify(rectangles);
      if (geometry === record.geometry) return;
      record.geometry = geometry;
      const x = Math.min(...rectangles.map(rect => rect.x)) - 18;
      const y = Math.min(...rectangles.map(rect => rect.y)) - 18;
      const right = Math.max(...rectangles.map(rect => rect.x + rect.width)) + 18;
      const bottom = Math.max(...rectangles.map(rect => rect.y + rect.height)) + 18;
      const blur = node('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 6, result: 'blurred', x, y, width: right - x, height: bottom - y });
      const mask = rectangles.length > 1 ? node('feMerge', { result: 'region', x, y, width: right - x, height: bottom - y }) : null;
      const floods = rectangles.map((rect, index) => {
        mask?.append(node('feMergeNode', { in: `patch${index}` }));
        return node('feFlood', { ...rect, 'flood-color': 'white', result: mask ? `patch${index}` : 'region' });
      });
      const merge = node('feMerge');
      merge.append(node('feMergeNode', { in: 'outside' }), node('feMergeNode', { in: 'inside' }));
      record.filter.replaceChildren(blur, ...floods, ...(mask ? [mask] : []),
        node('feComposite', { in: 'SourceGraphic', in2: 'region', operator: 'out', result: 'outside' }),
        node('feComposite', { in: 'blurred', in2: 'region', operator: 'in', result: 'inside' }), merge);
    }

    function update() {
      frame = null;
      for (let index = active.length - 1; index >= 0; index--) if (!isVisible(active[index])) active.splice(index, 1);
      if (!active.length || !enabled()) {
        stopObserving();
        for (const source of sources.keys()) release(source);
        return;
      }
      observeLayout();
      const boxes = active.map(surface => surface.getBoundingClientRect());
      const wanted = new Set();
      for (const [index, source] of [root, ...active].entries()) {
        const bounds = source.getBoundingClientRect();
        const scaleX = bounds.width / source.offsetWidth;
        const scaleY = bounds.height / source.offsetHeight;
        const rectangles = [];
        if (bounds.width && bounds.height) for (const box of boxes.slice(index)) {
          const left = Math.max(bounds.left, box.left), top = Math.max(bounds.top, box.top);
          const right = Math.min(bounds.right, box.right), bottom = Math.min(bounds.bottom, box.bottom);
          if (right <= left || bottom <= top) continue;
          // Coordinates belong to the source before its opening transform.
          rectangles.push(Object.fromEntries(Object.entries({ x: (left - bounds.left) / scaleX,
            y: (top - bounds.top) / scaleY, width: (right - left) / scaleX, height: (bottom - top) / scaleY })
            .map(([key, value]) => [key, Math.round(value * 100) / 100])));
        }
        filterSource(source, rectangles);
        if (rectangles.length) wanted.add(source);
      }
      for (const source of sources.keys()) if (!wanted.has(source)) release(source);
      if (isAnimating()) schedule();
    }

    function schedule() {
      if (!disposed && frame === null) frame = window.requestAnimationFrame(update);
    }

    function toggle(event) {
      const surface = event.target;
      if (!surface.matches?.(SURFACES)) return;
      if (event.newState === 'open') {
        surface.classList.add('content-blur-surface');
        // Reopening during an exit puts the surface back on top.
        const index = active.indexOf(surface);
        if (index >= 0) active.splice(index, 1);
        active.push(surface);
      }
      schedule();
    }

    document.addEventListener('beforetoggle', toggle, true);
    document.addEventListener('visibilitychange', schedule);
    for (const event of layoutEvents) document.addEventListener(event, layoutChanged, true);
    window.addEventListener('resize', layoutChanged);
    const appearanceObserver = new window.MutationObserver(schedule);
    appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    function dispose() {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      for (const source of sources.keys()) release(source);
      active.length = 0;
      stopObserving();
      appearanceObserver.disconnect();
      document.removeEventListener('beforetoggle', toggle, true);
      document.removeEventListener('visibilitychange', schedule);
      for (const event of layoutEvents) document.removeEventListener(event, layoutChanged, true);
      window.removeEventListener('resize', layoutChanged);
      window.removeEventListener('pagehide', dispose);
      definitions.remove();
    }
    window.addEventListener('pagehide', dispose);
    return { dispose };
  }
  return { create, SURFACES };
});
