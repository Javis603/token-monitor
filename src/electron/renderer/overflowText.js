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
    function animate(motion, distance) {
      motion.from = offsets.get(motion.element) || 0;
      motion.distance = distance;
      motion.startedAt = window.performance.now();
      motion.duration = Math.max(240, Math.min(8000, Math.abs(distance - motion.from) * 22));
      if (!motion.frameId) motion.frameId = window.requestAnimationFrame(motion.step);
    }
    function update(element) {
      element.classList.toggle('is-overflow-enabled', enabled(element));
      if (prefersReducedMotion()) element.title = element.textContent || '';
      else element.removeAttribute('title');
      const distance = distanceFor(element);
      const offset = Math.min(offsets.get(element) || 0, distance);
      move(element, offset);
      element.classList.toggle('has-overflow-fade', enabled(element)
        && distance - offset > 1);
      const motion = motions.get(element);
      if (motion && motion.startedAt !== null && motion.distance !== distance) animate(motion, distance);
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
    function start(element, event) {
      // A replacement card may hand this element an existing hover motion.
      if (motions.has(element)) return;
      stop(element);
      if (!enabled(element) || prefersReducedMotion()) return;
      const distance = distanceFor(element);
      if (distance <= 1) return;
      element.classList.add('is-hover-reading');
      const motion = {
        element, delayId: 0, frameId: 0, startedAt: null,
        point: event ? { x: event.clientX, y: event.clientY } : null
      };
      motion.step = now => {
        motion.frameId = 0;
        const current = motion.element;
        if (!current.isConnected || !enabled(current) || prefersReducedMotion()) { stop(current); return; }
        update(current);
        const progress = Math.max(0, Math.min(1, (now - motion.startedAt) / motion.duration));
        move(current, motion.from + (motion.distance - motion.from) * progress);
        update(current);
        if (progress < 1 && !motion.frameId) motion.frameId = window.requestAnimationFrame(motion.step);
      };
      motions.set(element, motion);
      motion.delayId = window.setTimeout(() => {
        motion.delayId = 0;
        if (!motion.element.isConnected || !enabled(motion.element) || prefersReducedMotion()) {
          stop(motion.element);
          return;
        }
        motion.element.classList.add('is-hover-scrolling');
        animate(motion, distanceFor(motion.element));
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
      update(element);
      element.addEventListener('mouseenter', event => start(element, event));
      element.addEventListener('mousemove', event => {
        const motion = motions.get(element);
        if (motion) motion.point = { x: event.clientX, y: event.clientY };
      });
      element.addEventListener('mouseleave', () => {
        const wasReading = element.classList.contains('is-hover-reading');
        stop(element);
        if (wasReading) onLeave();
      });
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
      update(element);
      refresh();
    }
    function preserveReading(previous, next) {
      const replacements = new Map(Array.from(next.querySelectorAll('.fade-overflow'))
        .filter(element => element.dataset.overflowKey)
        .map(element => [element.dataset.overflowKey, element]));
      for (const element of previous.querySelectorAll('.fade-overflow.is-hover-reading')) {
        const replacement = replacements.get(element.dataset.overflowKey);
        const motion = motions.get(element);
        if (!motion || !replacement || !contents.has(replacement)
          || replacement.textContent !== element.textContent) {
          stop(element);
          continue;
        }
        // A reordered or resized row may no longer contain the stationary pointer.
        const rect = replacement.getBoundingClientRect();
        if (motion.point && (motion.point.x < rect.left || motion.point.x >= rect.right
          || motion.point.y < rect.top || motion.point.y >= rect.bottom)) {
          stop(element);
          continue;
        }
        stop(replacement);
        motions.delete(element);
        motions.set(replacement, motion);
        motion.element = replacement;
        replacement.classList.add('is-hover-reading');
        replacement.classList.toggle('is-hover-scrolling', element.classList.contains('is-hover-scrolling'));
        move(replacement, offsets.get(element) || 0);
        element.classList.remove('is-hover-reading');
        element.classList.remove('is-hover-scrolling');
        update(replacement);
      }
    }
    window.addEventListener('resize', refresh);
    if (typeof window.ResizeObserver === 'function') {
      new window.ResizeObserver(refresh).observe(document.body);
    }
    return { bind, setText, refresh, stop, update, preserveReading };
  }
  return { create };
});
