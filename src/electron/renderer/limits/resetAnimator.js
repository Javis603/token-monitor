'use strict';

(function exposeLimitResetAnimator(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitResetAnimator = api;
})(typeof window !== 'undefined' ? window : null, function createLimitResetAnimatorApi() {
  // A refill sweeps over roughly a second with a short glow as it lands. The
  // numbers below are one contract: every surface animating a reset paces,
  // eases and flares the same way so two copies cannot drift apart.
  const EASING = 'cubic-bezier(0.333, 0.667, 0.667, 1)';
  const GLOW_MS = 700;
  const GLOW_LEAD_MS = 252;

  // One animator per surface that renders limit-window rows. capture() reads
  // the outgoing DOM before a rebuild, animate() replays real refills — and
  // carries in-flight ones — on the new nodes, and settle() snaps every
  // running effect to its end state (reduced-motion toggles, teardown). The
  // widget's limits panel and the edge dock's bubble card each own one so
  // this DOM stays the only way either surface plays a reset.
  //
  // deps:
  //   document             createElement for the completion glow
  //   motion               resetMotion.js api (shouldAnimateReset, durations)
  //   prefersReducedMotion () => boolean, consulted per frame and per start
  //   formatPercent        (number) => '90%' — the percent text's own format
  //   performance          the clock animations schedule against
  //   requestAnimationFrame, cancelAnimationFrame
  function createLimitResetAnimator(deps) {
    const document = deps.document;
    const motion = deps.motion;
    const prefersReducedMotion = deps.prefersReducedMotion || (() => false);
    const formatPercent = deps.formatPercent;
    const performance = deps.performance || globalThis.performance;
    const requestAnimationFrame = deps.requestAnimationFrame
      || ((frame) => globalThis.requestAnimationFrame(frame));
    const cancelAnimationFrame = deps.cancelAnimationFrame
      || ((handle) => globalThis.cancelAnimationFrame(handle));
    const numberAnimations = new Map();
    const fillMotions = new WeakMap();

    function animateFillBetween(fill, fromScale, toScale, duration, startedAt) {
      if (!fill?.animate) return;
      for (const animation of fill.getAnimations()) animation.cancel();
      if (Math.abs(toScale - fromScale) < 0.001) return;
      const animation = fill.animate([
        { transform: `scaleX(${fromScale})` },
        { transform: `scaleX(${toScale})` }
      ], {
        duration,
        easing: EASING,
        fill: 'backwards'
      });
      if (startedAt !== null) animation.startTime = startedAt;
    }

    function animatePercent(el, from, to, duration, startedAt = performance.now()) {
      if (!el) return;
      const suffix = el.dataset.limitMotionSuffix || '';
      if (prefersReducedMotion() || !Number.isFinite(from) || !Number.isFinite(to) || from === to) {
        el.textContent = `${formatPercent(to)} ${suffix}`;
        return;
      }
      const delta = to - from;
      const entry = { handle: 0, target: to, suffix };
      const initialProgress = Math.max(0, Math.min(1, (performance.now() - startedAt) / duration));
      const initialValue = from + delta * (1 - ((1 - initialProgress) ** 2));
      let renderedText = `${formatPercent(initialValue)} ${suffix}`;
      el.textContent = renderedText;
      function frame(now) {
        if (!el.isConnected) {
          if (numberAnimations.get(el) === entry) numberAnimations.delete(el);
          return;
        }
        if (prefersReducedMotion()) {
          el.textContent = `${formatPercent(to)} ${suffix}`;
          if (numberAnimations.get(el) === entry) numberAnimations.delete(el);
          return;
        }
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - ((1 - progress) * (1 - progress));
        const nextText = `${formatPercent(from + delta * eased)} ${suffix}`;
        // The displayed value is integer-rounded, so several animation frames
        // can resolve to the same string. Avoid invalidating text layout on
        // those frames.
        if (nextText !== renderedText) {
          renderedText = nextText;
          el.textContent = nextText;
        }
        if (progress < 1) {
          entry.handle = requestAnimationFrame(frame);
        } else if (numberAnimations.get(el) === entry) {
          numberAnimations.delete(el);
        }
      }
      entry.handle = requestAnimationFrame(frame);
      numberAnimations.set(el, entry);
    }

    function animateCompletion(fill, duration, startedAt = null) {
      if (!fill?.animate || prefersReducedMotion()) return;
      const highlight = document.createElement('span');
      highlight.className = 'limit-meter-completion';
      fill.append(highlight);
      const animation = highlight.animate([
        { opacity: 0 },
        {
          offset: GLOW_LEAD_MS / GLOW_MS,
          opacity: 0.52
        },
        { opacity: 0 }
      ], {
        duration: GLOW_MS,
        delay: Math.max(0, duration - GLOW_LEAD_MS),
        easing: 'linear'
      });
      if (startedAt !== null) animation.startTime = startedAt;
      const removeHighlight = () => highlight.remove();
      animation.onfinish = removeHighlight;
      animation.oncancel = removeHighlight;
    }

    function capture(scope) {
      const snapshot = new Map();
      for (const row of scope?.querySelectorAll('.limit-row[data-limit-motion-key]') || []) {
        for (const item of row.querySelectorAll('.limit-window[data-limit-motion-key]')) {
          const key = `${row.dataset.limitMotionKey}\0${item.dataset.limitMotionKey}`;
          const entry = {
            remainingPercent: item.dataset.limitRemainingPercent,
            displayPercent: item.dataset.limitDisplayPercent,
            resetsAt: item.dataset.limitResetAt,
            motion: fillMotions.get(item.querySelector('.limit-meter-fill'))
          };
          // Ambiguous identities are safer left static than animated on the
          // wrong row.
          snapshot.set(key, snapshot.has(key) ? null : entry);
        }
      }
      return snapshot;
    }

    function animate(scope, snapshot) {
      if (!snapshot?.size || prefersReducedMotion()) return;
      const motions = [];
      for (const row of scope?.querySelectorAll('.limit-row[data-limit-motion-key]') || []) {
        for (const item of row.querySelectorAll('.limit-window[data-limit-motion-key]')) {
          const key = `${row.dataset.limitMotionKey}\0${item.dataset.limitMotionKey}`;
          const previous = snapshot.get(key);
          const current = {
            remainingPercent: item.dataset.limitRemainingPercent,
            displayPercent: item.dataset.limitDisplayPercent,
            resetsAt: item.dataset.limitResetAt
          };
          if (!previous) continue;
          const fill = item.querySelector('.limit-meter-fill');
          const active = previous.motion;
          // A stats refresh replaces these nodes even when only updatedAt
          // changes. Carry the original timeline across that replacement,
          // including its glow.
          if (
            active
            && fill
            && previous.remainingPercent === current.remainingPercent
            && previous.displayPercent === current.displayPercent
            && previous.resetsAt === current.resetsAt
            && (active.startedAt === null || performance.now() - active.startedAt < active.duration + GLOW_MS - GLOW_LEAD_MS)
          ) {
            motions.push({ fill, item, motion: active });
            continue;
          }
          if (!motion.shouldAnimateReset(previous, current)) continue;
          const from = Number(previous.displayPercent);
          const to = Number(current.displayPercent);
          if (
            previous.displayPercent === ''
            || current.displayPercent === ''
            || !Number.isFinite(from)
            || !Number.isFinite(to)
            || !fill
          ) continue;
          const duration = motion.durationMs(from, to);
          motions.push({
            fill,
            item,
            motion: { from, to, duration, startedAt: null }
          });
        }
      }
      if (!motions.length) return;
      // Refills rendered in one pass land on full together: the batch paces
      // itself by the longest meter rather than each bar's own distance.
      const duration = motion.groupDurationMs(
        motions.filter(({ motion }) => motion.startedAt === null).map(({ motion }) => motion.duration)
      );
      for (const { fill, motion } of motions) {
        if (motion.startedAt === null) motion.duration = duration;
        fillMotions.set(fill, motion);
      }
      function startMotion({ fill, item, motion }, now) {
        if (!fill.isConnected || !item.isConnected || prefersReducedMotion()) return;
        if (motion.startedAt === null) motion.startedAt = now;
        const { from, to, duration, startedAt } = motion;
        animateFillBetween(fill, from / 100, to / 100, duration, startedAt);
        animateCompletion(fill, duration, startedAt);
        animatePercent(
          item.querySelector('[data-limit-motion-value]'),
          from,
          to,
          duration,
          startedAt
        );
      }
      // Resumed effects must cover the replacement DOM before it can paint
      // its static target. Waiting one frame would flash full, then jump
      // backward.
      const pending = [];
      for (const entry of motions) {
        if (entry.motion.startedAt === null) pending.push(entry);
        else startMotion(entry, entry.motion.startedAt);
      }
      // New refills still begin after the rest of the refresh render has
      // finished.
      if (pending.length) requestAnimationFrame((now) => {
        for (const entry of pending) startMotion(entry, now);
      });
    }

    function settle(scope) {
      for (const [el, motion] of numberAnimations) {
        cancelAnimationFrame(motion.handle);
        el.textContent = `${formatPercent(motion.target)} ${motion.suffix}`;
      }
      numberAnimations.clear();
      for (const animation of scope?.getAnimations?.({ subtree: true }) || []) {
        try { animation.finish(); } catch (_) { animation.cancel(); }
      }
    }

    return { capture, animate, settle };
  }

  return { createLimitResetAnimator, EASING, GLOW_MS, GLOW_LEAD_MS };
});
