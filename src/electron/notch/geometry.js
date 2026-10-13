'use strict';

const { EDGE_DOCK_METRICS, rectContains } = require('../edgeDock/geometry');
const { railCommands, bubbleCommands } = require('../renderer/edgeDock/shapes');

function notchGeometry(display, native, shape = 'auto') {
  const bounds = display.bounds;
  const frame = native?.frame;
  const left = native?.left;
  const right = native?.right;
  const gapLeft = (left?.origin?.x || 0) + (left?.size?.width || 0);
  const gapRight = right?.origin?.x || 0;
  const width = gapRight - gapLeft;
  const height = Number(native?.safeTop) || 0;
  const validRect = (rect) => Boolean(rect && [rect.origin?.x, rect.origin?.y, rect.size?.width, rect.size?.height].every(Number.isFinite)
    && rect.size.width > 0 && rect.size.height > 0);
  const topBand = (rect) => validRect(rect) && Math.abs(rect.origin.y + rect.size.height - (frame.origin.y + frame.size.height)) <= 1
    && Math.abs(rect.size.height - height) <= 1;
  const notched = Boolean(validRect(frame) && Math.abs(frame.size.width - bounds.width) <= 1 && Math.abs(frame.size.height - bounds.height) <= 1
    && topBand(left) && topBand(right) && height > 0 && height < bounds.height / 4
    && width > 0
    && gapLeft >= frame.origin.x && gapRight <= frame.origin.x + frame.size.width);
  const geometry = {
    notched,
    // AppKit global coordinates are bottom-up. The gap's horizontal offset
    // within its screen maps directly; Electron supplies the top-down origin.
    centerX: bounds.x + (notched ? (gapLeft + gapRight) / 2 - frame.origin.x : bounds.width / 2),
    y: bounds.y + (notched ? 0 : 6),
    gapWidth: notched ? width : 0,
    height: notched ? height : 32
  };
  if (shape === 'pill') return { ...geometry, notched: false, gapWidth: 0, y: bounds.y + (notched ? height : 0) + 6 };
  if (shape === 'notch') return { ...geometry, notched: true, y: bounds.y };
  return geometry;
}

// Logical screen points, independent of content zoom or Retina pixel scale.
// These are caps only: short cards keep their measured natural height.
function notchMaxHeight(display, geometry, detail = false) {
  const area = display.workArea || display.bounds;
  const top = Math.max(display.bounds.y, area.y);
  const bottom = Math.min(display.bounds.y + display.bounds.height, area.y + area.height);
  const usableHeight = Math.max(0, bottom - top);
  const origin = detail ? Math.max(top, geometry.y + geometry.height) : geometry.y;
  return Math.max(geometry.height, Math.min(detail ? 640 : 480,
    Math.round(usableHeight * (detail ? 0.618 : 0.382)),
    Math.floor(bottom - origin - (detail ? EDGE_DOCK_METRICS.screenMargin : 12))));
}

function notchBounds(display, geometry, expanded, contentHeight = 180, slots = { left: 17, right: 42 }, zoom = 1, maxWidth = display.bounds.width) {
  // Equal ears reserve the wider reading on both sides of the camera gap.
  const ear = slots ? Math.ceil(Math.max(0, slots.left, slots.right) + 16) : 0;
  const closedShoulder = geometry.notched && slots ? 4 : 0;
  const baseWidth = (EDGE_DOCK_METRICS.bubbleWidth + (geometry.notched ? 2 * EDGE_DOCK_METRICS.shoulder : 0)) * zoom;
  // Hardware-free entries hold one compact summary group, without a fake
  // camera gap. Their list width is independent of the resting readout.
  const compactWidth = Math.max(geometry.height * 2, slots ? slots.left + slots.right + 12 * zoom + 2 * (closedShoulder + 8) : 0);
  const closedWidth = geometry.gapWidth > 0 ? geometry.gapWidth + 2 * (ear + closedShoulder) : compactWidth;
  const expandedRequired = geometry.gapWidth > 0 && slots
    ? geometry.gapWidth + 2 * (Math.max(slots.left, slots.right) + 8 + (EDGE_DOCK_METRICS.shoulder + 14) * zoom) : 0;
  const listWidth = Math.max(baseWidth, expandedRequired, closedWidth);
  // The camera gap is irreducible; other visual minimums yield to clearance.
  const limit = expanded ? display.bounds.width : Math.max(geometry.gapWidth, Math.min(display.bounds.width, Math.floor(maxWidth)));
  let width = (expanded ? Math.ceil : Math.round)(Math.min(limit, expanded ? listWidth : closedWidth));
  // Preserve hardware gap parity; camera-free outlines use center parity,
  // including a capsule beneath a half-point physical camera center.
  const parity = geometry.gapWidth > 0 && Number.isInteger(geometry.gapWidth)
    ? geometry.gapWidth % 2 : Math.abs(geometry.centerX * 2) % 2;
  if (width > 0 && Number.isInteger(geometry.centerX * 2) && width % 2 !== parity) {
    width += width + 1 <= limit ? 1 : -1;
  }
  const maxHeight = notchMaxHeight(display, geometry);
  const height = Math.round(expanded ? Math.min(maxHeight, contentHeight + (geometry.gapWidth > 0 ? geometry.height : 0)) : geometry.height);
  const x = geometry.centerX - width / 2;
  return { x: Math.round(x), y: Math.round(geometry.y), width, height };
}

// Measure notch clearance from right-hand status windows. Left-hand
// app-menu titles have no verified permission-free geometry contract.
function notchSummaryMaxWidth(display, geometry, windows, ownWindowIds = []) {
  if (!geometry.notched || !Array.isArray(windows)) return null;
  const gapRight = geometry.centerX + geometry.gapWidth / 2;
  const screenRight = display.bounds.x + display.bounds.width;
  let right = screenRight;
  for (const rect of windows) {
    if (ownWindowIds.includes(rect.id) || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
      || rect.width <= 0 || rect.height <= 0) continue;
    // Full vertical containment rejects tall status-level panels. Menu height
    // can differ from the safe top by one physical point.
    if (Math.abs(rect.y - geometry.y) > 1 || rect.y + rect.height > geometry.y + geometry.height + 1
      || rect.x >= screenRight || rect.x + rect.width <= gapRight) continue;
    right = Math.min(right, Math.max(gapRight, rect.x));
  }
  return Math.max(0, Math.floor(2 * (right - geometry.centerX - EDGE_DOCK_METRICS.screenMargin)));
}

function notchCommands(width, height, notched, expanded, notchHeight = 32, zoom = 1) {
  if (!notched) return bubbleCommands({ width, height, tail: 0, tailY: 0, neck: 0, radius: expanded ? EDGE_DOCK_METRICS.bubbleRadius * zoom : height / 2 });
  // Keep the same path topology at both endpoints, so every control point can
  // move continuously. AppKit exposes the gap, not the model's corner radii;
  // the shallow resting shoulder is a visual fit to the physical notch.
  const s = Math.min(expanded ? EDGE_DOCK_METRICS.shoulder * zoom : 4, width / 2);
  const r = Math.min(expanded ? EDGE_DOCK_METRICS.railRadius * zoom : 14, (height - 6) / 2, Math.max(0, width / 2 - s));
  const cap = expanded ? Math.min(EDGE_DOCK_METRICS.railWidth * zoom, notchHeight / 0.53) : 6 / 0.53;
  const rail = railCommands({ width: cap, height: width, shoulder: s, radius: expanded ? r : 0 });
  const rotate = ([op, ...points]) => [op, ...points.flatMap((_, i) => i % 2 ? [] : [points[i + 1], cap - points[i]])];
  const first = rotate(rail[1]);
  const last = rotate(rail.at(-2));
  const spread = first.at(-1);
  return [['M', 0, 0], first, ['L', s, height - r],
    ['C', s, height - r * 0.448, s + r * 0.448, height, s + r, height],
    ['L', width - s - r, height],
    ['C', width - s - r * 0.448, height, width - s, height - r * 0.448, width - s, height - r],
    ['L', width - s, spread], last, ['Z']];
}

function translateCommands(commands, x, y = 0) {
  return commands.map(([op, ...points]) => [op, ...points.map((value, i) => value + (i % 2 ? y : x))]);
}
function interpolateCommands(from, to, progress) {
  return to.map(([op, ...points], index) => [op, ...points.map((value, i) => from[index][i + 1] + (value - from[index][i + 1]) * progress)]);
}
module.exports = { notchGeometry, notchMaxHeight, notchBounds, notchSummaryMaxWidth, notchCommands, translateCommands, interpolateCommands, rectContains };
