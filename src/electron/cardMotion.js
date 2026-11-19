'use strict';

const CARD_FRAME_MS = 16;
const CARD_FRAME_STALE_MS = 64;

// Windows main-process timers can run at ~31ms. Accept the visible renderer's
// paint clock, with main still owning geometry and a bounded timer fallback.
function createCardMotionDriver({ platform = process.platform, now = Date.now, advance, notify,
  setTimer = setInterval, clearTimer = clearInterval }) {
  let current = null, timer = null, lastFrameAt = null, sequence = 0;
  function cancel({ preserveFrameClock = false } = {}) {
    const previous = current;
    current = null;
    clearTimer(timer);
    timer = null;
    if (previous) notify({ motionId: previous.id, active: false });
    if (!preserveFrameClock) lastFrameAt = null;
  }
  function start(motion) {
    cancel({ preserveFrameClock: true });
    motion.id = ++sequence;
    current = motion;
    if (platform === 'win32') notify({ motionId: motion.id, active: true });
    advance(motion);
    if (current !== motion) return;
    timer = setTimer(() => {
      if (current !== motion) return;
      if (platform === 'win32' && lastFrameAt !== null && now() - lastFrameAt < CARD_FRAME_STALE_MS) return;
      advance(motion);
    }, CARD_FRAME_MS);
  }
  function frame(motionId) {
    if (platform !== 'win32' || !current || current.id !== motionId) return;
    lastFrameAt = now();
    advance(current);
  }
  return { start, cancel, frame };
}

module.exports = { createCardMotionDriver };
