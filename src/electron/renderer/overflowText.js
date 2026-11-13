'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorOverflowText = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function create({ document, window, prefersReducedMotion, enabled = () => true }) {
    const motions = new WeakMap();
    const contents = new WeakMap();
    const offsets = new WeakMap();
    let refreshFrame = 0;
    let pendingUpdates = null;
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
      // Keep a readable 100 px/s pace even for long task briefs. Capping the
      // duration would make the speed increase with the overflow distance.
      motion.duration = Math.max(240, Math.abs(distance - motion.from) * 10);
      if (!motion.frameId) motion.frameId = window.requestAnimationFrame(motion.step);
    }
    function prepare(element) {
      element.classList.toggle('is-overflow-enabled', enabled(element));
      // Reduced motion keeps the full text manually scrollable, without asking
      // Chromium to create an OS tooltip that can outlive a floating window.
      element.classList.toggle('is-overflow-static', prefersReducedMotion());
      element.removeAttribute('title');
    }
    function measure(element) {
      const distance = distanceFor(element);
      const offset = Math.min(offsets.get(element) || 0, distance);
      return { element, distance, offset, scrollLeft: element.scrollLeft };
    }
    function apply({ element, distance, offset, scrollLeft }) {
      move(element, offset);
      element.classList.toggle('has-overflow-fade', enabled(element)
        && distance - offset - scrollLeft > 1);
      const motion = motions.get(element);
      if (motion && motion.startedAt !== null && motion.distance !== distance) animate(motion, distance);
    }
    function update(element) {
      if (pendingUpdates) {
        pendingUpdates.add(element);
        return;
      }
      prepare(element);
      apply(measure(element));
    }
    function batch(callback) {
      if (pendingUpdates) return callback();
      pendingUpdates = new Set();
      try {
        return callback();
      } finally {
        const elements = [...pendingUpdates];
        pendingUpdates = null;
        elements.forEach(prepare);
        elements.map(measure).forEach(apply);
      }
    }
    function refresh() {
      if (refreshFrame) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = 0;
        batch(() => document.querySelectorAll('.fade-overflow').forEach(update));
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
      if (motions.has(element)) return;
      stop(element);
      if (!enabled(element) || prefersReducedMotion()) return;
      const distance = distanceFor(element);
      if (distance <= 1) return;
      element.classList.add('is-hover-reading');
      const motion = {
        element, delayId: 0, frameId: 0, startedAt: null
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
      element.addEventListener('scroll', () => update(element));
      element.addEventListener('mouseenter', () => start(element));
      element.addEventListener('mouseleave', () => {
        stop(element);
      });
      refresh();
    }
    function writeText(element, value) {
      const text = value || '';
      if (element.textContent === text) {
        refresh();
        return;
      }
      stop(element);
      (contents.get(element) || element).textContent = text;
      prepare(element);
      if (pendingUpdates) {
        pendingUpdates.add(element);
      } else {
        apply(measure(element));
      }
      refresh();
    }
    function setText(element, value) {
      return batch(() => writeText(element, value));
    }
    window.addEventListener('resize', refresh);
    if (typeof window.ResizeObserver === 'function') {
      new window.ResizeObserver(refresh).observe(document.body);
    }
    return { bind, setText, refresh, stop, update, batch };
  }
  return { create };
});
