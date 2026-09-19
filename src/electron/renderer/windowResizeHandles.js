'use strict';

(function installWindowResizeHandles() {
  const api = window.tokenMonitor;
  const shell = document.querySelector('.shell');
  if (!shell || typeof api?.beginWindowResize !== 'function') return;

  let active = null;
  let pendingPoint = null;
  let moveFrame = null;

  function pointFromEvent(event) {
    return { x: Number(event.screenX), y: Number(event.screenY) };
  }

  function flushMove() {
    moveFrame = null;
    if (!active || !pendingPoint) return;
    api.updateWindowResize(pendingPoint);
    pendingPoint = null;
  }

  function finish(event) {
    if (!active || (event?.pointerId != null && event.pointerId !== active.pointerId)) return;
    if (moveFrame != null) cancelAnimationFrame(moveFrame);
    moveFrame = null;
    if (pendingPoint) api.updateWindowResize(pendingPoint);
    pendingPoint = null;
    try { active.handle.releasePointerCapture(active.pointerId); } catch (_) {}
    active = null;
    document.documentElement.classList.remove('is-window-resizing');
    api.endWindowResize();
  }

  for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const handle = document.createElement('div');
    handle.className = `window-resize-handle window-resize-${edge}`;
    handle.dataset.resizeEdge = edge;
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || active) return;
      event.preventDefault();
      active = { edge, handle, pointerId: event.pointerId };
      handle.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('is-window-resizing');
      api.beginWindowResize(edge, pointFromEvent(event));
    });
    handle.addEventListener('pointermove', (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      pendingPoint = pointFromEvent(event);
      if (moveFrame == null) moveFrame = requestAnimationFrame(flushMove);
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    shell.append(handle);
  }

  window.addEventListener('blur', () => finish());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finish();
  });
})();
