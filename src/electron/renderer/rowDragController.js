'use strict';

// Whole-row drag-to-reorder for a settings list, factored out of the limit
// provider list so a second list can adopt the same gesture without a second
// copy of it. The pure geometry lives in `verticalDragSort.js`; what is here is
// the pointer/DOM choreography around it, every step of which exists because of
// a specific failure noted inline.
(function exposeRowDragController(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorRowDragController = api;
})(typeof window !== 'undefined' ? window : null, function createRowDragControllerApi() {
  // The list drags from the whole row instead of a handle: the pointer must
  // travel this far vertically before the gesture counts as a drag rather than
  // a click. Same threshold the tray composer uses horizontally.
  const DEFAULT_DRAG_THRESHOLD = 4;

  function createRowDragController(config = {}) {
    const {
      dragSort,
      getList,
      getScrollPanel,
      rowSelector,
      idKey,
      dragExcluded,
      threshold = DEFAULT_DRAG_THRESHOLD,
      getExpanded = () => '',
      setExpanded = () => {},
      applyOrder = () => {},
      preserveScroll = (callback) => callback(),
      mirrorOrder = () => {},
      persistOrder = () => {},
      requestRender = () => {}
    } = config;

    let drag = null;

    // Rows are measured in the scroll panel's content space (client Y plus its
    // scrollTop) so edge auto-scrolling never invalidates the snapshot: when the
    // panel scrolls the pointer's content Y advances on its own, with no
    // compensation term anywhere else.
    function contentY(clientY) {
      const panel = getScrollPanel();
      if (!panel) return clientY;
      return clientY - panel.getBoundingClientRect().top + panel.scrollTop;
    }

    function rowElements() {
      return Array.from(getList()?.querySelectorAll(rowSelector) || []);
    }

    function panelContentTop() {
      const panel = getScrollPanel();
      return panel ? panel.getBoundingClientRect().top - panel.scrollTop : 0;
    }

    function contentTop(el) {
      return el.getBoundingClientRect().top - panelContentTop();
    }

    function measureRows() {
      const panelTop = panelContentTop();
      return rowElements().map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, id: el.dataset[idKey], top: rect.top - panelTop, height: rect.height };
      });
    }

    function setDragListeners(active) {
      const method = active ? 'addEventListener' : 'removeEventListener';
      window[method]('pointermove', onPointerMove, true);
      window[method]('pointerup', onPointerUp, true);
      window[method]('pointercancel', onDragAbort, true);
      window[method]('keydown', onDragKeydown, true);
      // Deliberately not capture. `blur` does not bubble, so a capture listener on
      // `window` is the standard way to observe *every* element's blur — including
      // the one the press itself causes when focus leaves whatever the user last
      // clicked. That cancelled the drag before it could start. Without capture only
      // the window's own blur arrives, which is the case worth aborting on.
      window[method]('blur', onDragAbort);
    }

    function startRowDrag(event, id) {
      if (event.button !== 0) return;
      const rowEl = event.currentTarget;
      // Scoped to the row on purpose: `closest` keeps walking past it, and the
      // whole settings section is itself an `.accordion-animated-container`, so an
      // unscoped match excludes every row and no drag ever starts.
      const excluded = event.target?.closest?.(dragExcluded);
      if (excluded && rowEl.contains(excluded)) return;
      if (drag) finishRowDrag(false);
      if (rowElements().length <= 1) return;
      const pressY = contentY(event.clientY);
      drag = {
        id,
        pointerId: event.pointerId,
        // Where in the row the pointer landed. The origin is rebuilt from this once
        // the rows are measured, so a collapse between press and measurement cannot
        // leave the row hanging off the cursor.
        grabOffset: pressY - contentTop(rowEl),
        pressY,
        lastClientY: event.clientY,
        started: false,
        changed: false,
        expandedBefore: getExpanded(),
        captureEl: rowEl,
        rows: [],
        snapshot: null,
        order: null,
        scrollFrame: 0,
        renderPending: false
      };
      setDragListeners(true);
    }

    // Order matters: freeze the accordion, collapse, and only then measure. With
    // the transition disabled the collapse lands synchronously, so the snapshot
    // sees settled geometry instead of a mid-animation height.
    function beginRowDrag() {
      const list = getList();
      drag.started = true;
      list?.classList.add('is-reordering');
      if (drag.expandedBefore) setExpanded('');
      drag.rows = measureRows();
      drag.snapshot = dragSort.createVerticalDragSnapshot(
        drag.rows.map(({ id, top, height }) => ({ id, top, height })),
        drag.id,
        drag.grabOffset
      );
      if (drag.snapshot.sourceIndex < 0) {
        finishRowDrag(false);
        return false;
      }
      drag.rows[drag.snapshot.sourceIndex].el.classList.add('dragging');
      list?.classList.add('drag-active');
      startDragScroll();
      return true;
    }

    function updateDragPositions() {
      if (!drag?.started) return;
      const offsetY = contentY(drag.lastClientY) - drag.snapshot.originY;
      const resolved = dragSort.resolveVerticalDrag(drag.snapshot, offsetY);
      drag.order = resolved.order;
      drag.changed = resolved.targetIndex !== drag.snapshot.sourceIndex;
      for (const [index, { el }] of drag.rows.entries()) {
        if (index === drag.snapshot.sourceIndex) el.style.setProperty('--drag-y', `${offsetY}px`);
        else el.style.setProperty('--drag-shift', `${resolved.shifts[index]}px`);
      }
    }

    function startDragScroll() {
      const step = () => {
        const panel = getScrollPanel();
        if (!drag?.started || !panel) return;
        const rect = panel.getBoundingClientRect();
        const delta = dragSort.edgeScrollDelta({
          pointerY: drag.lastClientY,
          top: rect.top,
          bottom: rect.bottom
        });
        if (delta) {
          panel.scrollTop += delta;
          updateDragPositions();
        }
        drag.scrollFrame = requestAnimationFrame(step);
      };
      drag.scrollFrame = requestAnimationFrame(step);
    }

    function onPointerMove(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.lastClientY = event.clientY;
      if (!drag.started) {
        if (Math.abs(contentY(event.clientY) - drag.pressY) < threshold) return;
        // Capture only after the gesture crosses the drag threshold. Capturing on
        // pointerdown retargets the eventual click from the nested disclosure
        // button to the outer row, so an ordinary press can no longer expand it.
        // Once dragging, capture still guarantees that an outside-window release
        // reaches cleanup instead of leaving the repaint gate stuck.
        drag.captureEl?.addEventListener('lostpointercapture', onDragAbort);
        try { drag.captureEl?.setPointerCapture?.(event.pointerId); } catch (_) {}
        if (!beginRowDrag()) return;
      }
      event.preventDefault();
      updateDragPositions();
    }

    function onPointerUp(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const { id, started, changed, order } = drag;
      if (!started || !changed || !order?.length) {
        finishRowDrag(true);
        return;
      }
      // Mirror the new order locally before anything can repaint. A stats update
      // held back during the drag is flushed on drop, and every repaint sorts from
      // the caller's settings — which the deferred save has not written yet, so
      // without this the list rebuilds into the old order and flips a frame later.
      // The order is handed over as ids; how a list serializes them is its own.
      // Whatever the mirror returns comes back to the save untouched, so a list
      // whose setting depends on the state the mirror overwrites decides once
      // instead of asking the same question of two different worlds.
      const mirrored = mirrorOrder(order, id);
      finishRowDrag(true);
      // The drop itself is already in the DOM. Persisting re-renders the whole
      // settings form, which on a populated install is a long task — run it only
      // once the browser has painted the landed row, or that paint gets swallowed
      // and the drop reads as a freeze. rAF fires before paint, so the timeout
      // inside it is what lands after.
      requestAnimationFrame(() => {
        setTimeout(() => persistOrder(order, id, mirrored), 0);
      });
    }

    function onDragAbort(event) {
      if (!drag) return;
      if (event?.pointerId != null && event.pointerId !== drag.pointerId) return;
      finishRowDrag(false);
    }

    function onDragKeydown(event) {
      if (event.key !== 'Escape' || !drag) return;
      event.preventDefault();
      finishRowDrag(false);
    }

    function releaseLandingStyleAfterPaint(list) {
      requestAnimationFrame(() => {
        setTimeout(() => list?.classList.remove('is-landing'), 0);
      });
    }

    // The final DOM positions and the drag transforms both encode the same move.
    // Keep transform transitions disabled through the first landed paint so rows
    // do not briefly apply both offsets and animate back from a double displacement.
    function finishRowDrag(commit) {
      const current = drag;
      if (!current) return;
      // The DOM reorder itself runs before the asynchronous settings save. Moving
      // the focused row (and every sibling via appendChild) can trigger browser
      // scroll anchoring immediately, so the save-time scroll guard is already too
      // late. Preserve the panel around the whole landing transaction, including a
      // deferred repaint that was held while dragging.
      preserveScroll(() => {
        if (current.scrollFrame) cancelAnimationFrame(current.scrollFrame);
        setDragListeners(false);
        // Released before the reorder moves the node: relocating a captured element
        // fires `lostpointercapture`, which would re-enter this as an abort.
        const captureEl = current.captureEl;
        captureEl?.removeEventListener('lostpointercapture', onDragAbort);
        try {
          if (captureEl?.hasPointerCapture?.(current.pointerId)) captureEl.releasePointerCapture(current.pointerId);
        } catch (_) {}
        const list = getList();
        if (current.started) {
          const landing = Boolean(commit && current.changed && current.order?.length);
          if (landing) list?.classList.add('is-landing');
          if (landing) applyOrder(current.order);
          for (const { el } of current.rows) {
            el.style.removeProperty('--drag-y');
            el.style.removeProperty('--drag-shift');
            el.classList.remove('dragging');
          }
          list?.classList.remove('drag-active');
          list?.classList.remove('is-reordering');
          if (current.expandedBefore) setExpanded(current.expandedBefore);
          suppressNextClick();
          if (landing) releaseLandingStyleAfterPaint(list);
        }
        const renderPending = current.renderPending;
        drag = null;
        if (renderPending) requestRender();
      });
    }

    // The same main-row button owns click-to-expand and drag-to-reorder. Cancelling
    // its click after a completed drag prevents the drop from also toggling details.
    function suppressNextClick() {
      const swallow = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    }

    // A repaint mid-drag would replace the rows under the pointer and kill the
    // gesture silently. The caller skips its repaint when this answers true, and
    // the held repaint is flushed from `finishRowDrag`.
    function deferRender() {
      if (!drag) return false;
      drag.renderPending = true;
      return true;
    }

    return { startRowDrag, deferRender, isDragging: () => Boolean(drag) };
  }

  return { createRowDragController, DEFAULT_DRAG_THRESHOLD };
});
