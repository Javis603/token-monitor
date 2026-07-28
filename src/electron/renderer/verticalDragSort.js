'use strict';

(function exposeVerticalDragSort(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorVerticalDragSort = api;
})(typeof window !== 'undefined' ? window : null, function createVerticalDragSortApi() {
  function normalizeId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function numberOr(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeRows(rows) {
    return (rows || [])
      .map((row) => ({
        id: normalizeId(row?.id),
        top: numberOr(row?.top, 0),
        height: numberOr(row?.height, 0)
      }))
      .filter((row) => row.id);
  }

  // The space a row frees when it leaves its slot: its own height plus the gap
  // to its neighbour. Derived from neighbouring tops rather than a computed
  // `row-gap`, because the list's spacing comes from grid gap, row padding and
  // negative margins combined, which no single computed value reports.
  function slotHeightFor(rows, index) {
    const row = rows[index];
    const next = rows[index + 1];
    if (next) return next.top - row.top;
    const previous = rows[index - 1];
    if (previous) return row.height + (row.top - (previous.top + previous.height));
    return row.height;
  }

  // `grabOffset` is how far into the row the pointer landed. Keeping it here
  // rather than anchoring to the press position is what survives the layout
  // moving between the press and the measurement: collapsing an expanded row
  // above the dragged one lifts it by that row's height, and an origin pinned
  // to the old press position would leave the row that far off the cursor.
  function createVerticalDragSnapshot(rows, draggedId, grabOffset) {
    const normalized = normalizeRows(rows);
    const dragged = normalizeId(draggedId);
    const sourceIndex = normalized.findIndex((row) => row.id === dragged);
    return {
      rows: normalized,
      sourceIndex,
      slotHeight: sourceIndex < 0 ? 0 : slotHeightFor(normalized, sourceIndex),
      originY: sourceIndex < 0 ? 0 : normalized[sourceIndex].top + numberOr(grabOffset, 0)
    };
  }

  function centerOf(row) {
    return row.top + row.height / 2;
  }

  function dropIndexFor(snapshot, offsetY) {
    const { rows, sourceIndex } = snapshot;
    const draggedCenter = centerOf(rows[sourceIndex]) + numberOr(offsetY, 0);
    let index = 0;
    for (const [rowIndex, row] of rows.entries()) {
      if (rowIndex === sourceIndex) continue;
      if (draggedCenter > centerOf(row)) index += 1;
    }
    return Math.max(0, Math.min(rows.length - 1, index));
  }

  // Removing a row of `slotHeight` lifts everything below it by exactly that
  // much; inserting it at `targetIndex` pushes everything from there down by
  // the same amount. Only the rows between the two positions move, and they
  // always move one whole slot — independent of their own heights.
  function shiftFor(sourceIndex, targetIndex, index, slotHeight) {
    if (sourceIndex < targetIndex && index > sourceIndex && index <= targetIndex) return -slotHeight;
    if (targetIndex < sourceIndex && index >= targetIndex && index < sourceIndex) return slotHeight;
    return 0;
  }

  function reorderIds(ids, sourceIndex, targetIndex) {
    const order = ids.slice();
    const [moved] = order.splice(sourceIndex, 1);
    order.splice(targetIndex, 0, moved);
    return order;
  }

  function resolveVerticalDrag(snapshot, offsetY) {
    const rows = snapshot?.rows;
    const sourceIndex = snapshot?.sourceIndex;
    if (!rows || !rows.length || !Number.isInteger(sourceIndex) || sourceIndex < 0) {
      return { targetIndex: -1, shifts: [], order: [] };
    }
    const targetIndex = dropIndexFor(snapshot, offsetY);
    const slotHeight = numberOr(snapshot.slotHeight, 0);
    return {
      targetIndex,
      shifts: rows.map((_row, index) => shiftFor(sourceIndex, targetIndex, index, slotHeight)),
      order: reorderIds(rows.map((row) => row.id), sourceIndex, targetIndex)
    };
  }

  // Auto-scroll while the pointer sits in the `zone` band at either edge of the
  // scroller. A panel shorter than two bands resolves upward first; that only
  // happens far below the widget's minimum height.
  function edgeScrollDelta({ pointerY, top, bottom, zone = 32, maxSpeed = 12 } = {}) {
    const y = numberOr(pointerY, 0);
    const upper = numberOr(top, 0);
    const lower = numberOr(bottom, 0);
    const band = Math.max(1, numberOr(zone, 32));
    const speed = Math.max(0, numberOr(maxSpeed, 12));
    if (y < upper + band) return -Math.min(speed, speed * ((upper + band - y) / band));
    if (y > lower - band) return Math.min(speed, speed * ((y - (lower - band)) / band));
    return 0;
  }

  return { createVerticalDragSnapshot, resolveVerticalDrag, edgeScrollDelta };
});
