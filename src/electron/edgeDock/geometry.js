'use strict';

// Pure placement and pointer-intent logic for the edge dock. Nothing here
// touches Electron, so the whole interaction contract is testable under
// node:test; edgeDock.js owns the windows and feeds this module cursor reads.

const EDGE_DOCK_SIDES = Object.freeze(['right', 'left']);
const EDGE_DOCK_DEFAULT_OFFSET = 0.3;

// Rail metrics in DIPs. The rail renderer lays cells out on the same numbers,
// which is what lets the main process resolve the hovered cell from a cursor
// read instead of a DOM event that cannot cross into the bubble window.
const EDGE_DOCK_METRICS = Object.freeze({
  railWidth: 64,
  // Concave shoulders where the rail body flows into the screen edge. They are
  // part of the rail window, above and below the first and last cell.
  shoulder: 28,
  railRadius: 20,
  padding: 4,
  cellHeight: 70,
  // Floor for the compressed density used when every cell cannot fit at full
  // height; below it the rail clips its last cells rather than shrinking rings
  // into illegibility.
  minCellHeight: 54,
  // Usage stats render as a compact two-line readout rather than a ring.
  statHeight: 56,
  minStatHeight: 48,
  cellGap: 2,
  // Hover/click targets reach this far from the rail's centre line: the ring
  // plus a little slack, but not the strip at the physical screen edge.
  hitRadius: 28,
  edgeInset: 0,
  // The handle's window, with room for the handle to grow while the pointer
  // approaches it and for its outline and shadow to clear the window's edges.
  // The handle is a silhouette inside it like the rail's, so its material and
  // tint are the rail's too. Only the handle itself takes the pointer (see
  // edgeDockHandleBounds). AppKit clamps a window narrower than 10px.
  peekWidth: 10,
  peekLength: 88,
  handleWidth: 6,
  handleLength: 72,
  handleNearWidth: 8,
  handleNearLength: 80,
  // Around the handle, measured in from the screen edge. Resting the pointer in
  // the wake zone reveals the rail, the way the edge strip does; the approach
  // zone only grows the handle, so it can be found before it is reached. Both
  // stay local to the handle: a full-length band this deep would open the rail
  // on the way to every scrollbar along the edge.
  wakeDepth: 24,
  approachDepth: 48,
  approachSlack: 24,
  refreshSize: 32,
  refreshGap: 4,
  bubbleWidth: 280,
  bubbleTail: 12,
  bubbleNeck: 18,
  bubbleRadius: 18,
  bubbleGap: 4,
  triggerDepth: 2,
  screenMargin: 8
});

const EDGE_DOCK_TIMING = Object.freeze({
  // Long enough that sweeping past the edge toward a scrollbar does not open
  // the dock, short enough to read as a response to a deliberate push.
  revealDelayMs: 140,
  // Grace before retracting; covers the gap between rail and bubble and a
  // slightly overshooting pointer.
  hideDelayMs: 320,
  // First bubble waits for intent; moving between cells while a bubble is
  // already open switches immediately.
  bubbleDelayMs: 70
});

// `alwaysExceptFullScreen` behaves as `always` on the desktop and as
// `autoHide` while a full-screen app covers the dock's display.
const EDGE_DOCK_MODES = Object.freeze(['autoHide', 'always', 'alwaysExceptFullScreen']);

function normalizeEdgeDockMode(value) {
  return EDGE_DOCK_MODES.includes(value) ? value : 'autoHide';
}

function normalizeEdgeDockSide(value) {
  return EDGE_DOCK_SIDES.includes(value) ? value : 'right';
}

function normalizeEdgeDockOffset(value) {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) {
    return EDGE_DOCK_DEFAULT_OFFSET;
  }
  return Math.max(0, Math.min(1, number));
}

// The dock's size: three presets, or a scale of the user's own kept separately
// so switching to a preset and back does not lose it.
const EDGE_DOCK_SIZES = Object.freeze({ small: 0.85, medium: 1, large: 1.25, custom: null });
const EDGE_DOCK_CUSTOM_SCALE = Object.freeze({ min: 0.75, max: 1.5, step: 0.05 });

function normalizeEdgeDockSize(value) {
  return Object.hasOwn(EDGE_DOCK_SIZES, value) ? value : 'medium';
}

function normalizeEdgeDockCustomScale(value) {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return 1;
  const { min, max, step } = EDGE_DOCK_CUSTOM_SCALE;
  const stepped = Math.round(Math.max(min, Math.min(max, number)) / step) * step;
  return Number(stepped.toFixed(2));
}

function edgeDockScale(settings = {}) {
  const size = normalizeEdgeDockSize(settings?.edgeDockSize);
  return size === 'custom' ? normalizeEdgeDockCustomScale(settings?.edgeDockCustomScale) : EDGE_DOCK_SIZES[size];
}

// Measured from the pointer's side rather than the dock's, so they stay put
// whatever size the dock is drawn at: a larger dock should not open from
// further away, nor a smaller one become harder to reach.
const UNSCALED_METRICS = new Set(['wakeDepth', 'approachDepth', 'approachSlack', 'triggerDepth', 'screenMargin', 'edgeInset']);

// Whole pixels, so every window keeps integer bounds. The handle's window keeps
// the width AppKit will not clamp, and the handle stays wide enough to find.
function scaledEdgeDockMetrics(scale) {
  const factor = Number(scale);
  if (!Number.isFinite(factor) || factor === 1) return EDGE_DOCK_METRICS;
  const scaled = {};
  for (const [key, value] of Object.entries(EDGE_DOCK_METRICS)) {
    scaled[key] = UNSCALED_METRICS.has(key) ? value : Math.round(value * factor);
  }
  scaled.peekWidth = Math.max(EDGE_DOCK_METRICS.peekWidth, scaled.peekWidth);
  scaled.handleWidth = Math.max(5, scaled.handleWidth);
  scaled.handleNearWidth = Math.max(scaled.handleWidth + 1, scaled.handleNearWidth);
  return Object.freeze(scaled);
}

function normalizeEdgeDockDisplayId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = String(value).trim();
  return id || null;
}

function rectContains(rect, point) {
  if (!rect || !point) return false;
  return point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height;
}

function unionRect(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y
  };
}

function cellKindsFrom(cellKinds, cellCount) {
  // An explicit list is authoritative, including an empty one: an empty dock is
  // a valid choice, and synthesizing a provider here would reserve a cell the
  // renderer never paints.
  if (Array.isArray(cellKinds)) return cellKinds;
  const count = Math.max(1, Math.round(Number(cellCount) || 0));
  return Array.from({ length: count }, () => 'provider');
}

function naturalHeight(kind, metrics, compact) {
  if (kind === 'stat') return compact ? metrics.minStatHeight : metrics.statHeight;
  return compact ? metrics.minCellHeight : metrics.cellHeight;
}

// Heights and offsets of every cell, in the rail's own coordinates. Cells use
// their full height when everything fits and the compact density otherwise;
// past that the rail is clipped by the work area rather than shrunk further.
function edgeDockCellLayout(workArea, cellKinds, metrics = EDGE_DOCK_METRICS) {
  const kinds = cellKindsFrom(cellKinds);
  const chrome = metrics.shoulder * 2 + metrics.padding * 2;
  const measure = (compact) => kinds.reduce((sum, kind) => sum + naturalHeight(kind, metrics, compact), 0)
    + Math.max(0, kinds.length - 1) * metrics.cellGap;
  const available = workArea ? workArea.height - metrics.screenMargin * 2 - chrome : Infinity;
  const compact = measure(false) > available;
  const heights = kinds.map((kind) => naturalHeight(kind, metrics, compact));
  const tops = [];
  let cursor = metrics.shoulder + metrics.padding;
  for (const height of heights) {
    tops.push(cursor);
    cursor += height + metrics.cellGap;
  }
  return { kinds, heights, tops, compact, length: chrome + measure(compact) };
}

// The strip between the card and the rail, as tall as the card. Crossing it
// must not count as leaving. It used to be the bounding box of both surfaces,
// which on a long rail with a card near the top swallowed a large empty area
// of the screen and kept the card open after the pointer had clearly left.
// A larger dock that would not fit the work area at full density shrinks to the
// largest size that does, so it still scales as a whole: the compressed density
// would otherwise shrink its rings and type straight back, and only its width
// would grow. A dock that does not fit even at 100% keeps that density, as it
// always has.
function edgeDockFittingScale({ workArea, cellKinds, cellCount, scale }) {
  const requested = Number(scale) || 1;
  if (!workArea || requested <= 1) return requested;
  const kinds = cellKindsFrom(cellKinds, cellCount);
  const fits = (value) => !edgeDockCellLayout(workArea, kinds, scaledEdgeDockMetrics(value)).compact;
  if (fits(requested)) return requested;
  if (!fits(1)) return 1;
  let low = 100;
  let high = Math.round(requested * 100);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid / 100)) low = mid;
    else high = mid;
  }
  return low / 100;
}

function edgeDockCorridorBounds(railBounds, bubbleBounds, slack = 6) {
  if (!railBounds || !bubbleBounds) return null;
  const bubbleRight = bubbleBounds.x + bubbleBounds.width;
  const railRight = railBounds.x + railBounds.width;
  // Card left of the rail (right-edge dock) or right of it (left-edge dock).
  const [start, end] = bubbleRight <= railBounds.x ? [bubbleRight, railBounds.x] : [railRight, bubbleBounds.x];
  return { x: start - slack, y: bubbleBounds.y, width: Math.max(0, end - start) + slack * 2, height: bubbleBounds.height };
}

function railLength(cellCount, metrics = EDGE_DOCK_METRICS, cellKinds = null) {
  return edgeDockCellLayout(null, cellKindsFrom(cellKinds, cellCount), metrics).length;
}

function railTop(workArea, length, offset, metrics = EDGE_DOCK_METRICS) {
  const minY = workArea.y + metrics.screenMargin;
  const maxY = workArea.y + workArea.height - length - metrics.screenMargin;
  const travel = Math.max(0, maxY - minY);
  return Math.round(minY + travel * normalizeEdgeDockOffset(offset));
}

function edgeDockRailBounds({ workArea, side, offset, cellCount, cellKinds, metrics = EDGE_DOCK_METRICS }) {
  if (!workArea) return null;
  const cells = edgeDockCellLayout(workArea, cellKindsFrom(cellKinds, cellCount), metrics);
  const length = Math.min(cells.length, Math.max(0, workArea.height - metrics.screenMargin * 2));
  const x = normalizeEdgeDockSide(side) === 'left'
    ? workArea.x + metrics.edgeInset
    : workArea.x + workArea.width - metrics.railWidth - metrics.edgeInset;
  return { x: Math.round(x), y: railTop(workArea, length, offset, metrics), width: metrics.railWidth, height: length, cells };
}

function edgeDockPeekBounds({ workArea, side, railBounds, metrics = EDGE_DOCK_METRICS }) {
  if (!workArea || !railBounds) return null;
  const x = normalizeEdgeDockSide(side) === 'left'
    ? workArea.x
    : workArea.x + workArea.width - metrics.peekWidth;
  const height = metrics.peekLength;
  const y = railBounds.y + Math.round((railBounds.height - height) / 2);
  return { x: Math.round(x), y, width: metrics.peekWidth, height };
}

// The handle within its window: flush with the screen edge and centred along it.
// `handle` is its current size, fractional mid-growth.
function edgeDockHandleBounds({ side, peekBounds, handle = null, metrics = EDGE_DOCK_METRICS }) {
  if (!peekBounds) return null;
  const width = handle?.width ?? metrics.handleWidth;
  const height = handle?.length ?? metrics.handleLength;
  const x = normalizeEdgeDockSide(side) === 'left' ? peekBounds.x : peekBounds.x + peekBounds.width - width;
  return { x, y: peekBounds.y + (peekBounds.height - height) / 2, width, height };
}

function edgeDockHandleZones({ side, peekBounds, metrics = EDGE_DOCK_METRICS }) {
  if (!peekBounds) return null;
  const left = normalizeEdgeDockSide(side) === 'left';
  const zone = (depth, slack) => ({
    x: left ? peekBounds.x : peekBounds.x + peekBounds.width - depth,
    y: peekBounds.y - slack,
    width: depth,
    height: peekBounds.height + slack * 2
  });
  return { wake: zone(metrics.wakeDepth, 0), approach: zone(metrics.approachDepth, metrics.approachSlack) };
}

function edgeDockRefreshBounds({ workArea, displayBounds = workArea, railBounds, metrics = EDGE_DOCK_METRICS }) {
  if (!workArea || !railBounds) return null;
  const size = metrics.refreshSize;
  const minY = displayBounds.y + metrics.screenMargin;
  const maxY = displayBounds.y + displayBounds.height - metrics.screenMargin - size;
  // The shoulder reaches the screen edge beyond the visible body. Nest the
  // button into that empty curve rather than measuring from the window edge.
  const inset = Math.round(metrics.shoulder * 0.7);
  const below = railBounds.y + railBounds.height - inset + metrics.refreshGap;
  // The floating action stays in the rail's column. The desktop can extend
  // below the work area (e.g. a Dock/taskbar inset); only the display edge clips it.
  const x = railBounds.x + Math.round((railBounds.width - size) / 2);
  return { x, y: Math.max(minY, Math.min(below, maxY)), width: size, height: size };
}

function edgeDockRefreshCorridor(rail, button) {
  if (!rail || !button) return null;
  if (button.y >= rail.y + rail.height) return { x: button.x, y: rail.y + rail.height, width: button.width, height: button.y - rail.y - rail.height };
  if (button.y + button.height <= rail.y) return { x: button.x, y: button.y + button.height, width: button.width, height: rail.y - button.y - button.height };
  const x = Math.min(rail.x + rail.width, button.x + button.width);
  const right = Math.max(rail.x, button.x);
  return { x, y: button.y, width: Math.max(0, right - x), height: button.height };
}

// The strip the pointer has to reach to reveal the dock. It runs from the work
// area's edge to the physical display edge (a side-docked macOS Dock or taskbar
// puts space between them) and spans the rail's full length, so the target is
// the whole region the rail will occupy, not only the small peek handle.
function edgeDockTriggerBounds({ workArea, displayBounds, side, railBounds, metrics = EDGE_DOCK_METRICS }) {
  if (!workArea || !railBounds) return null;
  const display = displayBounds || workArea;
  if (normalizeEdgeDockSide(side) === 'left') {
    const x = display.x;
    const right = workArea.x + metrics.triggerDepth;
    return { x, y: railBounds.y, width: Math.max(metrics.triggerDepth, right - x), height: railBounds.height };
  }
  const x = workArea.x + workArea.width - metrics.triggerDepth;
  const right = display.x + display.width;
  return { x, y: railBounds.y, width: Math.max(metrics.triggerDepth, right - x), height: railBounds.height };
}

function edgeDockCellAt(point, railBounds, cellCount, metrics = EDGE_DOCK_METRICS) {
  if (!rectContains(railBounds, point)) return null;
  // Only the column around the marks counts. The rail runs flush to the screen
  // edge, and a pointer parked against that edge is not pointing at a ring.
  const centerX = railBounds.x + railBounds.width / 2;
  if (Math.abs(point.x - centerX) > metrics.hitRadius) return null;
  const layout = railBounds.cells || edgeDockCellLayout(null, cellKindsFrom(null, cellCount), metrics);
  const local = point.y - railBounds.y;
  const count = Math.min(cellCount, layout.tops.length);
  for (let index = 0; index < count; index += 1) {
    // The gap below a cell belongs to it, so crossing between cells never
    // passes through a dead zone that would close and reopen the card.
    if (local >= layout.tops[index] && local < layout.tops[index] + layout.heights[index] + metrics.cellGap) return index;
  }
  return null;
}

function edgeDockBubbleBounds({ railBounds, cellIndex, height, workArea, side, metrics = EDGE_DOCK_METRICS }) {
  if (!railBounds || !workArea || !Number.isInteger(cellIndex)) return null;
  const bubbleHeight = Math.max(40, Math.round(Number(height) || 0));
  const layout = railBounds.cells || edgeDockCellLayout(null, cellKindsFrom(null, cellIndex + 1), metrics);
  const top = layout.tops[cellIndex] ?? layout.tops[layout.tops.length - 1];
  const cellCenter = railBounds.y + top + (layout.heights[cellIndex] ?? metrics.cellHeight) / 2;
  const minY = workArea.y + metrics.screenMargin;
  const maxY = workArea.y + workArea.height - bubbleHeight - metrics.screenMargin;
  const y = Math.round(Math.max(minY, Math.min(Math.max(minY, maxY), cellCenter - bubbleHeight / 2)));
  // The window carries the tail as well as the card, so it is wider than the
  // card by the tail length; the tail tip points at the cell's centre even when
  // the card itself had to be clamped to stay on screen.
  const width = metrics.bubbleWidth + metrics.bubbleTail;
  const x = normalizeEdgeDockSide(side) === 'left'
    ? railBounds.x + railBounds.width + metrics.bubbleGap
    : railBounds.x - metrics.bubbleGap - width;
  return { x: Math.round(x), y, width, height: bubbleHeight, tailY: Math.round(cellCenter - y) };
}

// Placement after a drag: vertical position becomes the normalized offset
// within the work area, and the side follows whichever half the pointer was
// released in, so a drag across the screen re-docks on the other edge.
function edgeDockPlacementForDrop({ workArea, pointer, grabOffsetY, cellCount, cellKinds, metrics = EDGE_DOCK_METRICS }) {
  if (!workArea || !pointer) return null;
  const side = pointer.x < workArea.x + workArea.width / 2 ? 'left' : 'right';
  const length = Math.min(
    edgeDockCellLayout(workArea, cellKindsFrom(cellKinds, cellCount), metrics).length,
    Math.max(0, workArea.height - metrics.screenMargin * 2)
  );
  const minY = workArea.y + metrics.screenMargin;
  const travel = Math.max(0, workArea.height - length - metrics.screenMargin * 2);
  const top = pointer.y - (Number(grabOffsetY) || 0);
  const offset = travel > 0 ? (top - minY) / travel : EDGE_DOCK_DEFAULT_OFFSET;
  return { side, offset: Math.round(normalizeEdgeDockOffset(offset) * 1000) / 1000 };
}

// Pointer intent state machine. `tick` takes one cursor observation and returns
// the effects to apply; it never schedules timers itself, so a poll loop (or a
// test) drives time explicitly.
function createEdgeDockIntent(timing = EDGE_DOCK_TIMING) {
  const state = {
    revealed: false,
    pinned: false,
    // Always-visible mode: the rail never retracts; only the card comes and goes.
    always: false,
    dwellSince: null,
    leaveSince: null,
    cell: null,
    candidate: null,
    candidateSince: null
  };

  function reset() {
    state.dwellSince = null;
    state.leaveSince = null;
    state.cell = null;
    state.candidate = null;
    state.candidateSince = null;
  }

  function tick(input = {}, now = Date.now()) {
    const effects = [];
    if (input.dragging) {
      state.leaveSince = null;
      return effects;
    }
    if (!state.revealed) {
      if (input.inTrigger || input.inPeek || input.inWake) {
        if (state.dwellSince === null) state.dwellSince = now;
        const delay = input.inPeek ? Math.min(60, timing.revealDelayMs) : timing.revealDelayMs;
        if (now - state.dwellSince >= delay) {
          state.revealed = true;
          reset();
          effects.push({ type: 'reveal' });
        }
      } else {
        state.dwellSince = null;
      }
      return effects;
    }

    const inside = Boolean(input.inRail || input.inBubble || input.inCorridor || input.inTrigger);
    if (inside) {
      state.leaveSince = null;
    } else if (!state.pinned && !state.always) {
      if (state.leaveSince === null) state.leaveSince = now;
      if (now - state.leaveSince >= timing.hideDelayMs) {
        state.revealed = false;
        const hadBubble = state.cell !== null;
        reset();
        if (hadBubble) effects.push({ type: 'bubble', cell: null });
        effects.push({ type: 'retract' });
        return effects;
      }
    }

    if (input.inRail && Number.isInteger(input.cellIndex)) {
      if (input.cellIndex === state.cell) {
        state.candidate = null;
        state.candidateSince = null;
      } else if (state.cell !== null) {
        state.cell = input.cellIndex;
        state.candidate = null;
        state.candidateSince = null;
        effects.push({ type: 'bubble', cell: state.cell });
      } else {
        if (state.candidate !== input.cellIndex) {
          state.candidate = input.cellIndex;
          state.candidateSince = now;
        }
        if (now - state.candidateSince >= timing.bubbleDelayMs) {
          state.cell = input.cellIndex;
          state.candidate = null;
          state.candidateSince = null;
          effects.push({ type: 'bubble', cell: state.cell });
        }
      }
    } else if (!input.inRail && !input.inBubble && !input.inCorridor) {
      state.candidate = null;
      state.candidateSince = null;
      // A pinned or always-visible dock keeps the rail but lets the card go
      // once the pointer has clearly left, so it never covers content.
      const holdsRail = state.pinned || state.always;
      if (holdsRail && state.cell !== null && state.leaveSince === null) {
        state.leaveSince = now;
      }
      if (holdsRail && state.cell !== null && now - state.leaveSince >= timing.hideDelayMs) {
        state.cell = null;
        effects.push({ type: 'bubble', cell: null });
      }
    }
    return effects;
  }

  function reveal({ pinned = false } = {}) {
    const effects = [];
    state.pinned = pinned;
    if (!state.revealed) {
      state.revealed = true;
      reset();
      effects.push({ type: 'reveal' });
    }
    return effects;
  }

  function togglePin() {
    if (!state.revealed) return reveal({ pinned: true });
    state.pinned = !state.pinned;
    state.leaveSince = null;
    return [];
  }

  function retract() {
    const effects = [];
    if (!state.revealed) return effects;
    if (state.always) {
      state.pinned = false;
      if (state.cell !== null) {
        state.cell = null;
        effects.push({ type: 'bubble', cell: null });
      }
      return effects;
    }
    const hadBubble = state.cell !== null;
    state.revealed = false;
    state.pinned = false;
    reset();
    if (hadBubble) effects.push({ type: 'bubble', cell: null });
    effects.push({ type: 'retract' });
    return effects;
  }

  function setAlways(always) {
    state.always = always === true;
    if (state.always && !state.revealed) {
      state.revealed = true;
      reset();
      return [{ type: 'reveal' }];
    }
    return [];
  }

  // A click opens a cell's bubble directly, without the hover intent delay.
  function focusCell(index) {
    state.cell = Number.isInteger(index) ? index : null;
    state.candidate = null;
    state.candidateSince = null;
    state.leaveSince = null;
  }

  // The cell list can shrink under an open bubble when a provider disappears.
  function clampCell(cellCount) {
    if (state.cell !== null && state.cell >= cellCount) {
      state.cell = null;
      return [{ type: 'bubble', cell: null }];
    }
    return [];
  }

  return {
    tick,
    reveal,
    retract,
    togglePin,
    setAlways,
    focusCell,
    clampCell,
    snapshot: () => ({ ...state })
  };
}

module.exports = {
  EDGE_DOCK_DEFAULT_OFFSET,
  EDGE_DOCK_METRICS,
  EDGE_DOCK_MODES,
  EDGE_DOCK_CUSTOM_SCALE,
  EDGE_DOCK_SIDES,
  EDGE_DOCK_SIZES,
  EDGE_DOCK_TIMING,
  createEdgeDockIntent,
  edgeDockBubbleBounds,
  edgeDockCellAt,
  edgeDockCellLayout,
  edgeDockCorridorBounds,
  edgeDockFittingScale,
  edgeDockHandleBounds,
  edgeDockHandleZones,
  edgeDockPeekBounds,
  edgeDockPlacementForDrop,
  edgeDockRailBounds,
  edgeDockRefreshBounds,
  edgeDockRefreshCorridor,
  edgeDockScale,
  edgeDockTriggerBounds,
  normalizeEdgeDockCustomScale,
  normalizeEdgeDockDisplayId,
  normalizeEdgeDockMode,
  normalizeEdgeDockOffset,
  normalizeEdgeDockSide,
  normalizeEdgeDockSize,
  railLength,
  rectContains,
  scaledEdgeDockMetrics,
  unionRect
};
