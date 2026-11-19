'use strict';

// Drag-to-reorder for a settings list, factored out of the limit provider list
// so other lists can adopt the same gesture without a second copy of it. A
// caller may use the whole row or require an explicit handle; the pure geometry
// lives in `verticalDragSort.js`. What is here is the pointer/DOM choreography,
// every step of which exists because of a specific failure noted inline.
(function exposeRowDragController(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorRowDragController = api;
})(typeof window !== 'undefined' ? window : null, function createRowDragControllerApi() {
  // The pointer must travel this far along the configured axis before the
  // gesture counts as a drag rather than a click, matching the tray composer.
  const DEFAULT_DRAG_THRESHOLD = 4;

  function createRowDragController(config = {}) {
    const {
      dragSort,
      axis = 'y',
      getList,
      getScrollPanel,
      rowSelector,
      idKey,
      dragExcluded,
      dragStartSelector = '',
      threshold = DEFAULT_DRAG_THRESHOLD,
      getExpanded = () => '',
      setExpanded = () => {},
      applyOrder = () => {},
      preserveScroll = (callback) => callback(),
      mirrorOrder = () => {},
      persistOrder = () => {},
      requestRender = () => {}
    } = config;

    // Project either axis onto the same one-dimensional sort solver. Existing
    // settings lists stay vertical; the Notch provider strip sorts horizontally.
    const wrapped = axis === 'grid';
    const horizontal = axis === 'x';
    const scrollKey = horizontal ? 'scrollLeft' : 'scrollTop';
    const startKey = horizontal ? 'left' : 'top';
    const endKey = horizontal ? 'right' : 'bottom';
    const sizeKey = horizontal ? 'width' : 'height';
    const dragProperty = horizontal ? '--drag-x' : '--drag-y';
    const pointerPosition = event => horizontal ? event.clientX : event.clientY;

    let drag = null;

    // Rows are measured in the scroll panel's content space so edge scrolling
    // never invalidates the snapshot: when the panel scrolls the pointer
    // advances on its own, with no compensation term anywhere else.
    function contentPosition(clientPosition) {
      const panel = getScrollPanel();
      if (!panel) return clientPosition;
      return clientPosition - panel.getBoundingClientRect()[startKey] + panel[scrollKey];
    }

    function gridPoint(clientX, clientY) {
      const list = getList(), rect = list.getBoundingClientRect();
      const scale = list.offsetWidth > 0 ? rect.width / list.offsetWidth : 1;
      return { x: (clientX - rect.left) / scale + list.scrollLeft, y: (clientY - rect.top) / scale + list.scrollTop, scale };
    }

    function rowElements() {
      return Array.from(getList()?.querySelectorAll(rowSelector) || []);
    }

    function panelContentTop() {
      const panel = getScrollPanel();
      return panel ? panel.getBoundingClientRect()[startKey] - panel[scrollKey] : 0;
    }

    function contentTop(el) {
      return el.getBoundingClientRect()[startKey] - panelContentTop();
    }

    function measureRows() {
      if (wrapped) {
        const list = getList(), rect = list.getBoundingClientRect(), { scale } = gridPoint(rect.left, rect.top);
        return rowElements().map(el => { const r = el.getBoundingClientRect(); return {
          el, id: el.dataset[idKey], left: (r.left - rect.left) / scale + list.scrollLeft,
          top: (r.top - rect.top) / scale + list.scrollTop, width: r.width / scale, height: r.height / scale
        }; });
      }
      const panelTop = panelContentTop();
      return rowElements().map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, id: el.dataset[idKey], top: rect[startKey] - panelTop, height: rect[sizeKey] };
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
      if (wrapped) window[method]('resize', onDragAbort);
    }

    function startRowDrag(event, id) {
      if (event.button !== 0) return;
      const rowEl = event.currentTarget;
      // Handle-only lists still listen on the row so `currentTarget` remains the
      // element whose geometry and pointer capture the controller owns. The
      // closest match also lets an icon nested inside the handle start the drag.
      const dragStart = dragStartSelector && event.target?.closest?.(dragStartSelector);
      if (dragStartSelector && (!dragStart || !rowEl.contains(dragStart))) return;
      // Scoped to the row on purpose: `closest` keeps walking past it, and the
      // whole settings section is itself an `.accordion-animated-container`, so an
      // unscoped match excludes every row and no drag ever starts.
      const excluded = event.target?.closest?.(dragExcluded);
      if (excluded && rowEl.contains(excluded)) return;
      if (drag) finishRowDrag(false);
      if (rowElements().length <= 1) return;
      const pressGrid = wrapped ? gridPoint(event.clientX, event.clientY) : null;
      const pressPosition = contentPosition(pointerPosition(event));
      const rowRect = rowEl.getBoundingClientRect();
      drag = {
        id,
        pressGrid,
        lastClientX: event.clientX,
        grabOffsetX: wrapped ? (event.clientX - rowRect.left) / pressGrid.scale : 0,
        grabOffsetY: wrapped ? (event.clientY - rowRect.top) / pressGrid.scale : 0,
        pointerId: event.pointerId,
        // Where in the row the pointer landed. The origin is rebuilt from this once
        // the rows are measured, so a collapse between press and measurement cannot
        // leave the row hanging off the cursor.
        grabOffset: pressPosition - contentTop(rowEl),
        pressPosition,
        lastClientPosition: pointerPosition(event),
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
      const style = wrapped ? window.getComputedStyle(list) : null;
      drag.snapshot = wrapped ? dragSort.createWrappedDragSnapshot(drag.rows, drag.id,
        { x: drag.grabOffsetX, y: drag.grabOffsetY },
        { width: list.clientWidth, columnGap: parseFloat(style.columnGap) || 0, rowGap: parseFloat(style.rowGap) || 0 })
        : dragSort.createVerticalDragSnapshot(
          drag.rows.map(({ id, top, height }) => ({ id, top, height })), drag.id, drag.grabOffset);
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
      const point = wrapped ? gridPoint(drag.lastClientX, drag.lastClientPosition) : null;
      const offset = wrapped ? { x: point.x - drag.snapshot.originX, y: point.y - drag.snapshot.originY }
        : contentPosition(drag.lastClientPosition) - drag.snapshot.originY;
      const resolved = wrapped ? dragSort.resolveWrappedDrag(drag.snapshot, offset) : dragSort.resolveVerticalDrag(drag.snapshot, offset);
      drag.order = resolved.order;
      drag.changed = resolved.targetIndex !== drag.snapshot.sourceIndex;
      for (const [index, { el }] of drag.rows.entries()) {
        if (wrapped) {
          const shift = index === drag.snapshot.sourceIndex ? offset : resolved.shifts[index];
          el.style.setProperty(index === drag.snapshot.sourceIndex ? '--drag-x' : '--drag-shift-x', `${shift.x}px`);
          el.style.setProperty(index === drag.snapshot.sourceIndex ? '--drag-y' : '--drag-shift-y', `${shift.y}px`);
        } else if (index === drag.snapshot.sourceIndex) el.style.setProperty(dragProperty, `${offset}px`);
        else el.style.setProperty('--drag-shift', `${resolved.shifts[index]}px`);
      }
    }

    function startDragScroll() {
      const step = () => {
        const panel = getScrollPanel();
        if (!drag?.started || !panel) return;
        const rect = panel.getBoundingClientRect();
        const delta = dragSort.edgeScrollDelta({
          pointerY: drag.lastClientPosition,
          top: rect[startKey],
          bottom: rect[endKey]
        });
        if (delta) {
          panel[scrollKey] += delta;
          updateDragPositions();
        }
        drag.scrollFrame = requestAnimationFrame(step);
      };
      drag.scrollFrame = requestAnimationFrame(step);
    }

    function onPointerMove(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.lastClientPosition = pointerPosition(event);
      drag.lastClientX = event.clientX;
      if (!drag.started) {
        const point = wrapped ? gridPoint(event.clientX, event.clientY) : null;
        const distance = wrapped ? Math.hypot(point.x - drag.pressGrid.x, point.y - drag.pressGrid.y)
          : Math.abs(contentPosition(pointerPosition(event)) - drag.pressPosition);
        if (distance < threshold) return;
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
            el.style.removeProperty(dragProperty);
            el.style.removeProperty('--drag-shift');
            if (wrapped) for (const key of ['--drag-x', '--drag-y', '--drag-shift-x', '--drag-shift-y']) el.style.removeProperty(key);
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
