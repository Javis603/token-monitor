'use strict';

// Renderer-local polish that cannot be expressed in CSS alone:
// - a cost reading gets one highlight when it changes, only after its first
//   value has been seeded so the startup cache does not flicker;
// - a view that becomes visible gets a short staged entrance;
// - each scroll surface remembers its position across a view switch.
//
// Everything here is passive: one MutationObserver for cost text, one class
// observer per surface, and passive scroll listeners. No interval timers and no
// extra windows or processes.
(function designPolish() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canAnimate = () => !reduceQuery.matches
    && document.documentElement.dataset.reduceMotion !== 'on';
  const seen = new WeakMap();
  let frame = 0;

  function tick(element) {
    if (!element) return;
    const text = (element.textContent || '').trim();
    if (!text) return;
    const previous = seen.get(element);
    seen.set(element, text);
    if (previous === undefined || previous === text || !canAnimate()) return;
    element.classList.remove('is-value-tick');
    // Force a reflow so a quick second change restarts the same keyframes.
    void element.offsetWidth;
    element.classList.add('is-value-tick');
    window.setTimeout(() => element.classList.remove('is-value-tick'), 560);
  }

  function scan() {
    frame = 0;
    tick(document.getElementById('cost'));
    document.querySelectorAll('#breakdown .row-cost').forEach(tick);
  }

  function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(scan);
  }

  const observer = new MutationObserver(schedule);
  const cost = document.getElementById('cost');
  if (cost) observer.observe(cost, { subtree: true, childList: true, characterData: true });
  const breakdown = document.getElementById('breakdown');
  if (breakdown) observer.observe(breakdown, { subtree: true, childList: true, characterData: true });

  // Seed the first reading quietly. Clearing later would only turn an early
  // cache-to-live swap into a highlight, which is not useful on boot.
  schedule();

  // -------------------------------------------------------------------------
  // View entrance and scroll memory
  // -------------------------------------------------------------------------
  const SURFACE_IDS = ['homePanel', 'breakdown', 'limitsPanel', 'trendsPanel', 'serviceStatusPanel'];
  const scrollMemory = new Map();
  const hiddenState = new WeakMap();
  const enterTimers = new Map();
  const pendingRestores = new Map();

  function clampScroll(surface) {
    return Math.max(0, surface.scrollHeight - surface.clientHeight);
  }

  function cancelRestore(id) {
    const pending = pendingRestores.get(id);
    if (!pending) return;
    if (pending.frame) window.cancelAnimationFrame(pending.frame);
    if (pending.timer) window.clearTimeout(pending.timer);
    pendingRestores.delete(id);
  }

  function restoreScroll(surface, id) {
    if (!scrollMemory.has(id)) return;
    const target = scrollMemory.get(id);
    if (!(target > 0)) return;
    cancelRestore(id);
    const pending = { target, attempts: 0, frame: 0, timer: 0 };
    pendingRestores.set(id, pending);

    const apply = () => {
      if (pendingRestores.get(id) !== pending) return;
      if (surface.classList.contains('hidden')) {
        pendingRestores.delete(id);
        return;
      }
      const max = clampScroll(surface);
      // The list can be re-rendered after this visibility flip (the app may
      // swap rows in the same frame). Keep retrying briefly until the measured
      // content can hold the remembered offset, then stop.
      if (max >= target) {
        surface.scrollTop = target;
        if (Math.abs(surface.scrollTop - target) <= 1 || pending.attempts >= 8) {
          pendingRestores.delete(id);
          return;
        }
      } else if (max > 0) {
        surface.scrollTop = max;
      }
      pending.attempts += 1;
      if (pending.attempts >= 8) {
        pendingRestores.delete(id);
        return;
      }
      pending.frame = window.requestAnimationFrame(apply);
    };

    // One paint for the visibility flip, then a short timer in case a push
    // repaints the module list after the first frame.
    pending.frame = window.requestAnimationFrame(() => {
      apply();
      if (!pendingRestores.has(id)) return;
      pending.timer = window.setTimeout(apply, 90);
    });
  }

  function markVisible(surface, id) {
    if (!canAnimate()) return;
    surface.classList.remove('is-surface-entering');
    // Restart the keyframes on a return visit without leaving the class behind
    // for later, unrelated rows that render during a stats push.
    void surface.offsetWidth;
    surface.classList.add('is-surface-entering');
    const previous = enterTimers.get(id);
    if (previous) window.clearTimeout(previous);
    enterTimers.set(id, window.setTimeout(() => {
      enterTimers.delete(id);
      surface.classList.remove('is-surface-entering');
    }, 360));
  }

  function watchSurface(id) {
    const surface = document.getElementById(id);
    if (!surface) return;
    hiddenState.set(surface, surface.classList.contains('hidden'));
    surface.addEventListener('scroll', () => {
      scrollMemory.set(id, surface.scrollTop);
    }, { passive: true });
    // A real wheel/pointer gesture outranks a pending restore; a programmatic
    // scroll cannot be distinguished reliably from a user one.
    for (const type of ['wheel', 'pointerdown', 'touchstart']) {
      surface.addEventListener(type, () => cancelRestore(id), { passive: true });
    }
    const surfaceObserver = new MutationObserver(() => {
      const hidden = surface.classList.contains('hidden');
      const wasHidden = hiddenState.get(surface);
      hiddenState.set(surface, hidden);
      if (hidden) {
        scrollMemory.set(id, surface.scrollTop);
        return;
      }
      if (!wasHidden) return;
      markVisible(surface, id);
      restoreScroll(surface, id);
    });
    surfaceObserver.observe(surface, { attributes: true, attributeFilter: ['class'] });
  }

  SURFACE_IDS.forEach(watchSurface);

  // A new period repaints the list from the top; remembering the old offset
  // would land halfway down unrelated rows. A view switch keeps its memory.
  document.addEventListener('click', (event) => {
    const tab = event.target instanceof Element
      ? event.target.closest('.tab, [data-fixed-period]')
      : null;
    if (!tab) return;
    scrollMemory.delete('breakdown');
    scrollMemory.delete('homePanel');
    cancelRestore('breakdown');
    cancelRestore('homePanel');
  }, true);
})();
