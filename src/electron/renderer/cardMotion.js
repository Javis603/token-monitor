'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCardMotion = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function createCardFrameLoop({ sendFrame, requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id) }) {
    let motionId = null, frame = null;
    function pump() {
      frame = null;
      if (motionId === null) return;
      sendFrame(motionId);
      if (motionId !== null) frame = requestFrame(pump);
    }
    function update(next) {
      if (!next.active) {
        if (motionId === next.motionId) motionId = null;
        return;
      }
      motionId = next.motionId;
      if (frame === null) frame = requestFrame(pump);
    }
    function cancel() {
      motionId = null;
      if (frame !== null) cancelFrame(frame);
      frame = null;
    }
    return { update, cancel };
  }
  return { createCardFrameLoop };
});
