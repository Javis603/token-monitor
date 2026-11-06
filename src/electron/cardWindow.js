'use strict';

const CARD_FADE_IN_MS = 150;
const CARD_FADE_OUT_MS = 120;
const CARD_FRAME_MS = 16;

function parkedCardBounds(bounds, displays) {
  const right = Math.max(...displays.map(display => display.bounds.x + display.bounds.width));
  return { x: right + bounds.width, y: bounds.y, width: bounds.width, height: bounds.height };
}

// Keep the native window alive between reveals. Hiding and showing it can
// briefly present its old compositor frame before the new card is painted.
// Material, pointer routing and platform stacking remain with each owner.
function createCardWindowVisibility({ reducedMotion, setOpacity = (win, value) => win.setOpacity(value),
  setTimer = setInterval, clearTimer = clearInterval }) {
  const fades = new Map();
  function cancel(win) {
    const timer = fades.get(win);
    if (timer !== undefined) clearTimer(timer);
    fades.delete(win);
  }
  function fade(win, to, duration, done) {
    if (!win || win.isDestroyed()) return;
    cancel(win);
    if (reducedMotion() || duration <= 0) {
      setOpacity(win, to);
      done?.();
      return;
    }
    const from = win.getOpacity();
    const steps = Math.max(1, Math.round(duration / CARD_FRAME_MS));
    let step = 0;
    const timer = setTimer(() => {
      if (win.isDestroyed()) { cancel(win); return; }
      const t = ++step / steps;
      setOpacity(win, from + (to - from) * (1 - Math.pow(1 - t, 3)));
      if (step >= steps) { cancel(win); done?.(); }
    }, CARD_FRAME_MS);
    fades.set(win, timer);
  }
  function setVisible(win, visible, duration = visible ? CARD_FADE_IN_MS : CARD_FADE_OUT_MS, { beforeFade, afterFade } = {}) {
    if (!win || win.isDestroyed()) return;
    const firstShow = !win.isVisible();
    if (firstShow) {
      setOpacity(win, 0);
      win.showInactive();
    }
    beforeFade?.(firstShow);
    fade(win, visible ? 1 : 0, duration, afterFade);
  }
  return { setVisible, cancel };
}

module.exports = { CARD_FADE_IN_MS, CARD_FADE_OUT_MS, CARD_FRAME_MS, parkedCardBounds, createCardWindowVisibility };
