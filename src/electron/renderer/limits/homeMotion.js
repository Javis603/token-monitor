'use strict';

(function exposeHomeLimitMotion(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorHomeLimitMotion = api;
})(typeof window !== 'undefined' ? window : null, function createHomeLimitMotionApi() {
  // Home's limit meters stay still until a window's data changes. Then the
  // change itself moves: a used chunk lingers as a ghost before it drains,
  // the lit tail flares as the fill settles, and the reading rolls (or
  // counts) by the user's token-number setting. A reset refills at the shared
  // reset pace (resetMotion.js, resetAnimator.js) with a sheen run across it,
  // so a refill never reads like usage.
  const FILL_MS = 500;
  const FILL_EASING = 'cubic-bezier(0.22, 0.9, 0.24, 1)';
  const GHOST_DELAY_MS = 350;
  const GHOST_MS = 700;
  const GHOST_EASING = 'cubic-bezier(0.5, 0, 0.2, 1)';
  const FLARE_MS = 900;

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  // previous: the outgoing row (target and on-screen fill); current: the new
  // row's target. Returns the meter motion to play, or null.
  function planMeterMotion(previous, current, resetMotion) {
    const from = finite(previous?.displayFill) ?? finite(previous?.fill);
    const to = finite(current?.fill);
    if (from === null || to === null) return null;
    if (resetMotion.shouldAnimateReset(previous, current)) {
      return { kind: 'reset', from, to, duration: resetMotion.durationMs(from, to) };
    }
    if (finite(previous.fill) === to || Math.abs(to - from) < 0.05) return null;
    if (to > from) return { kind: 'fill', from, to, duration: FILL_MS };
    // A drain restarted mid-flight keeps its ghost where it already stood.
    const ghostFrom = Math.max(from, finite(previous.displayGhost) ?? 0);
    return { kind: 'drain', from, to, ghostFrom, duration: FILL_MS };
  }

  function motionLength(motion) {
    if (motion.kind === 'reset') return motion.duration;
    if (motion.kind === 'drain') return Math.max(motion.duration, GHOST_DELAY_MS + GHOST_MS, FLARE_MS);
    return Math.max(motion.duration, FLARE_MS);
  }

  // deps:
  //   motion               resetMotion.js api
  //   resetEasing          resetAnimator.js EASING, the shared refill curve
  //   numbers              tokenNumberAnimation.js api
  //   numberMode           () => 'roll' | 'count'
  //   prefersReducedMotion () => boolean
  //   formatPercent        (number) => '42%'
  function createHomeLimitMotion(deps) {
    const { motion: resetMotion, numbers, formatPercent } = deps;
    const numberMode = deps.numberMode || (() => 'roll');
    const prefersReducedMotion = deps.prefersReducedMotion || (() => false);
    // A refresh mid-animation must not restart it: a retained track keeps
    // running, a rebuilt one replays from the original start.
    const meterMotions = new WeakMap();
    const rollSettles = new Set();

    function capture(scope) {
      const snapshot = new Map();
      for (const item of scope?.querySelectorAll('.home-limit-window[data-limit-motion-key]') || []) {
        const key = item.dataset.limitMotionKey;
        const track = item.querySelector('.home-limit-track');
        const ghost = track?.querySelector('.home-limit-ghost');
        const value = item.querySelector('[data-limit-motion-value]');
        let displayFill = null;
        let displayGhost = null;
        if (track?.isConnected) {
          displayFill = parseFloat(getComputedStyle(track).getPropertyValue('--home-limit-fill'));
          if (ghost?.getAnimations().length) {
            const width = track.getBoundingClientRect().width;
            if (width > 0) displayGhost = ghost.getBoundingClientRect().width / width * 100;
          }
        }
        const entry = {
          remainingPercent: item.dataset.limitRemainingPercent,
          resetsAt: item.dataset.limitResetAt,
          fill: track?.dataset.limitFill,
          displayFill: Number.isFinite(displayFill) ? displayFill : null,
          displayGhost,
          motion: track ? meterMotions.get(track) : null,
          text: value?.dataset.limitMotionText,
          percent: value ? numbers.currentCountValue(value) ?? finite(value.dataset.limitMotionValue) : null,
          roll: value ? numbers.capture(value) : null
        };
        // Ambiguous identities are safer left static than animated on the
        // wrong row.
        snapshot.set(key, snapshot.has(key) ? null : entry);
      }
      return snapshot;
    }

    function playMeter(track, motion) {
      const startTime = motion.startedAt;
      const run = (node, frames, options) => {
        const animation = node.animate(frames, { fill: 'backwards', ...options });
        animation.startTime = startTime;
      };
      const reset = motion.kind === 'reset';
      run(track, [{ '--home-limit-fill': `${motion.from}%` }, { '--home-limit-fill': `${motion.to}%` }],
        { duration: motion.duration, easing: reset ? deps.resetEasing : FILL_EASING });
      if (reset) {
        run(track.querySelector('.home-limit-fill'), [{ backgroundPosition: '-100% 0' }, { backgroundPosition: '200% 0' }],
          { duration: motion.duration, easing: 'ease-in-out', pseudoElement: '::before' });
        return;
      }
      if (motion.kind === 'drain') {
        run(track.querySelector('.home-limit-ghost'), [
          { width: `${motion.ghostFrom}%`, opacity: 1 },
          { width: `${motion.to}%`, opacity: 0 }
        ], { duration: GHOST_MS, delay: GHOST_DELAY_MS, easing: GHOST_EASING });
      }
      run(track.querySelector('.home-limit-tip'), [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }],
        { duration: FLARE_MS, easing: 'ease-out', pseudoElement: '::after' });
    }

    function playReading(value, previous) {
      const toText = value.dataset.limitMotionText;
      const to = finite(value.dataset.limitMotionValue);
      if (!toText || to === null || !previous?.text) return;
      if (numberMode() === 'count') {
        const from = finite(previous.percent);
        if (from !== null && Math.round(from) !== Math.round(to)) {
          numbers.beginCount(value, from, to, formatPercent, { toText });
        }
        return;
      }
      // A roll still in flight carries its glyphs over even when the reading
      // has not changed again.
      if (previous.text === toText && !previous.roll) return;
      const settle = numbers.beginRoll(value, previous.text, toText, to > (finite(previous.percent) ?? to),
        null, previous.roll);
      rollSettles.add(settle);
      setTimeout(() => {
        settle();
        rollSettles.delete(settle);
      }, numbers.duration);
    }

    function animate(scope, snapshot) {
      if (!snapshot?.size || prefersReducedMotion()) return;
      const now = scope.ownerDocument.timeline?.currentTime ?? performance.now();
      for (const item of scope.querySelectorAll('.home-limit-window[data-limit-motion-key]')) {
        const previous = snapshot.get(item.dataset.limitMotionKey);
        if (!previous) continue;
        const value = item.querySelector('[data-limit-motion-value]');
        if (value) playReading(value, previous);
        const track = item.querySelector('.home-limit-track');
        if (!track) continue;
        const current = {
          remainingPercent: item.dataset.limitRemainingPercent,
          resetsAt: item.dataset.limitResetAt,
          fill: track.dataset.limitFill
        };
        const active = previous.motion;
        // A retained track keeps its running animations; a replaced one
        // replays the same motion from its original start.
        const running = track.getAnimations({ subtree: true });
        if (active && finite(previous.fill) === finite(current.fill) && now - active.startedAt < motionLength(active)) {
          if (running.length) continue;
          meterMotions.set(track, active);
          playMeter(track, active);
          continue;
        }
        const motion = planMeterMotion(previous, current, resetMotion);
        if (!motion) continue;
        for (const animation of running) animation.cancel();
        motion.startedAt = now;
        meterMotions.set(track, motion);
        playMeter(track, motion);
      }
    }

    function settle() {
      for (const finish of rollSettles) finish();
      rollSettles.clear();
    }

    return { capture, animate, settle };
  }

  return { createHomeLimitMotion, planMeterMotion, FILL_MS, GHOST_DELAY_MS, GHOST_MS, FLARE_MS };
});
