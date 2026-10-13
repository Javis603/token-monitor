(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TokenMonitorScrollFade = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // Fade only the content that is actually clipped. The first/last row remains
  // fully visible at either end; the native glass is visible through the mask.
  function observe(element, { size = 18 } = {}) {
    if (!element) return { dispose() {} };
    const view = element.ownerDocument.defaultView;
    const edge = Math.max(0, Number(size) || 0);
    let frame = 0;
    let disposed = false;
    let previousTop = -1;
    let previousBottom = -1;
    const observedChildren = new Set();
    function update() {
      frame = 0;
      if (disposed) return;
      const height = element.clientHeight;
      const extent = Math.max(0, element.scrollHeight - height);
      const position = Math.max(0, Math.min(extent, element.scrollTop));
      const top = height > 0 ? Math.min(edge, position) : 0;
      const bottom = height > 0 ? Math.min(edge, Math.max(0, extent - position)) : 0;
      if (top !== previousTop) element.style.setProperty('--scroll-fade-top', `${top}px`);
      if (bottom !== previousBottom) element.style.setProperty('--scroll-fade-bottom', `${bottom}px`);
      previousTop = top;
      previousBottom = bottom;
    }
    function schedule() {
      if (!disposed && !frame) frame = view.requestAnimationFrame(update);
    }
    const resizeObserver = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : null;
    function observeChildren() {
      if (!resizeObserver) return;
      const children = new Set(element.children);
      for (const child of observedChildren) {
        if (!children.has(child)) { resizeObserver.unobserve(child); observedChildren.delete(child); }
      }
      for (const child of children) {
        if (!observedChildren.has(child)) { resizeObserver.observe(child); observedChildren.add(child); }
      }
    }
    const mutationObserver = typeof view.MutationObserver === 'function'
      ? new view.MutationObserver(() => { observeChildren(); schedule(); }) : null;
    element.classList.add('scroll-edge-fade');
    element.addEventListener('scroll', schedule, { passive: true });
    view.addEventListener('resize', schedule, { passive: true });
    resizeObserver?.observe(element);
    observeChildren();
    mutationObserver?.observe(element, { childList: true, subtree: true, characterData: true });
    schedule();
    return { dispose() {
      disposed = true;
      if (frame) view.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      observedChildren.clear();
      element.removeEventListener('scroll', schedule);
      view.removeEventListener('resize', schedule);
      element.classList.remove('scroll-edge-fade');
      element.style.removeProperty('--scroll-fade-top');
      element.style.removeProperty('--scroll-fade-bottom');
    } };
  }
  return { observe };
});
