'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorOverflowText = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function create({ document, window, prefersReducedMotion, enabled = () => true, onLeave = () => {} }) {
    const motions = new WeakMap();
    const contents = new WeakMap();
    const offsets = new WeakMap();
    let refreshFrame = 0;
    function distanceFor(element) {
      const content = contents.get(element);
      return Math.max(0, (content ? content.getBoundingClientRect().width : element.scrollWidth) - element.clientWidth);
    }
    function move(element, offset) {
      offsets.set(element, offset);
      const content = contents.get(element);
      if (content) content.style.transform = `translate3d(${-offset}px, 0, 0)`;
    }
    function update(element) {
      element.classList.toggle('is-overflow-enabled', enabled(element));
      const distance = distanceFor(element);
      const offset = Math.min(offsets.get(element) || 0, distance);
      move(element, offset);
      element.classList.toggle('has-overflow-fade', enabled(element)
        && distance - offset > 1);
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
      element.classList.remove('is-hover-reading');
      move(element, 0);
      element.scrollLeft = 0;
      update(element);
    }
    function start(element) {
      stop(element);
      if (!enabled(element) || prefersReducedMotion()) return;
      const distance = distanceFor(element);
      if (distance <= 1) return;
      element.classList.add('is-hover-reading');
      const motion = { delayId: 0, frameId: 0 };
      motions.set(element, motion);
      motion.delayId = window.setTimeout(() => {
        motion.delayId = 0;
        const startedAt = window.performance.now();
        const duration = Math.max(240, Math.min(8000, distance * 22));
        element.classList.add('is-hover-scrolling');
        const step = now => {
          if (!element.isConnected || !enabled(element) || prefersReducedMotion()) { stop(element); return; }
          const progress = Math.min(1, (now - startedAt) / duration);
          move(element, distance * progress);
          update(element);
          motion.frameId = progress < 1 ? window.requestAnimationFrame(step) : 0;
        };
        motion.frameId = window.requestAnimationFrame(step);
      }, 240);
    }
    function bind(element) {
      if (contents.has(element)) return;
      const content = document.createElement('span');
      content.className = 'overflow-text-content';
      content.append(...element.childNodes);
      element.append(content);
      contents.set(element, content);
      element.classList.add('fade-overflow');
      element.title = element.textContent || '';
      element.addEventListener('mouseenter', () => start(element));
      element.addEventListener('mouseleave', () => { stop(element); onLeave(); });
      refresh();
    }
    function setText(element, value) {
      const text = value || '';
      if (element.textContent === text) {
        refresh();
        return;
      }
      stop(element);
      (contents.get(element) || element).textContent = text;
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
