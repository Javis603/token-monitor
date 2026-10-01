'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorOverflowText = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function create({ document, window, prefersReducedMotion, enabled = () => true, onLeave = () => {} }) {
    const motions = new WeakMap();
    let refreshFrame = 0;
    function update(element) {
      element.classList.toggle('has-overflow-fade', enabled(element)
        && element.scrollWidth - element.clientWidth - element.scrollLeft > 1);
    }
    function refresh() {
      if (refreshFrame) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = 0;
        document.querySelectorAll('.fade-overflow').forEach(update);
      });
    }
    function stop(element) {
      const motion = motions.get(element);
      if (motion?.delayId) window.clearTimeout(motion.delayId);
      if (motion?.frameId) window.cancelAnimationFrame(motion.frameId);
      motions.delete(element);
      element.classList.remove('is-hover-scrolling');
      element.scrollLeft = 0;
      update(element);
    }
    function start(element) {
      stop(element);
      if (!enabled(element) || prefersReducedMotion()) return;
      const distance = Math.ceil(element.scrollWidth - element.clientWidth);
      if (distance <= 1) return;
      const motion = { delayId: 0, frameId: 0 };
      motions.set(element, motion);
      motion.delayId = window.setTimeout(() => {
        motion.delayId = 0;
        const startedAt = window.performance.now();
        const duration = Math.max(1800, Math.min(8000, distance * 22));
        element.classList.add('is-hover-scrolling');
        const step = now => {
          if (!element.isConnected) { stop(element); return; }
          const progress = Math.min(1, (now - startedAt) / duration);
          element.scrollLeft = distance * progress;
          update(element);
          motion.frameId = progress < 1 ? window.requestAnimationFrame(step) : 0;
        };
        motion.frameId = window.requestAnimationFrame(step);
      }, 240);
    }
    function bind(element) {
      element.classList.add('fade-overflow');
      element.title = element.textContent || '';
      element.addEventListener('mouseenter', () => start(element));
      element.addEventListener('mouseleave', () => { stop(element); onLeave(); });
      refresh();
    }
    function setText(element, value) {
      stop(element);
      element.textContent = value || '';
      element.title = element.textContent;
      refresh();
    }
    window.addEventListener('resize', refresh);
    if (typeof window.ResizeObserver === 'function') {
      new window.ResizeObserver(refresh).observe(document.body);
    }
    return { bind, setText, refresh, stop, update };
  }
  return { create };
});
