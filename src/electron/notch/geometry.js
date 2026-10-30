'use strict';

const { rectContains } = require('../edgeDock/geometry');
const { bubbleCommands } = require('../renderer/edgeDock/shapes');

// Logical points for a 179×32pt camera housing. The open panel is a wide, short
// slab that hangs from the menu bar; the resting outline hugs the housing.
const NOTCH_METRICS = Object.freeze({
  openWidth: 640,
  // Including the camera band. The panel reports a fixed content height.
  openHeight: 240,
  openRadius: 40.5,
  openFlare: 18,
  restingRadius: 12,
  restingFlare: 8,
  cameraClearance: 4,
  // Hover feedback without opening: the resting outline grows a little.
  peekGrow: 10,
  peekDrop: 5,
  // Room for the open spring's overshoot, as a share of each axis' travel.
  overshoot: 0.12,
  // The open panel's drop shadow, mirrored by the filter in notch.css: blur
  // and downward offset in points. Chromium applies a drop-shadow blur as the
  // Gaussian's standard deviation, so the canvas reserves three of them.
  shadowBlur: 19.5,
  shadowDrop: 6.5
});

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
// Cap the panel without stretching its fixed content height.
function notchMaxHeight(display, geometry) {
  const area = display.workArea || display.bounds;
  const top = Math.max(display.bounds.y, area.y);
  const bottom = Math.min(display.bounds.y + display.bounds.height, area.y + area.height);
  const usableHeight = Math.max(0, bottom - top);
  return Math.max(geometry.height, Math.min(480,
    Math.round(usableHeight * 0.382),
    Math.floor(bottom - geometry.y - 12)));
}

function notchBounds(display, geometry, expanded, contentHeight = 180, slots = { left: 17, right: 42 }, zoom = 1, maxWidth = display.bounds.width) {
  // Equal ears reserve the wider reading on both sides of the camera gap.
  const ear = slots ? Math.ceil(Math.max(0, slots.left, slots.right) + 8 + NOTCH_METRICS.cameraClearance) : 0;
  const closedShoulder = geometry.notched ? NOTCH_METRICS.restingFlare : 0;
  const baseWidth = (NOTCH_METRICS.openWidth + (geometry.notched ? 2 * NOTCH_METRICS.openFlare : 0)) * zoom;
  // Hardware-free entries hold one compact summary group, without a fake
  // camera gap. Their list width is independent of the resting readout.
  const compactWidth = Math.max(geometry.height * 2, slots ? slots.left + slots.right + 12 * zoom + 2 * (closedShoulder + 8) : 0);
  const closedWidth = geometry.gapWidth > 0 ? geometry.gapWidth + 2 * (ear + closedShoulder) : compactWidth;
  const expandedRequired = geometry.gapWidth > 0 && slots
    ? geometry.gapWidth + 2 * (Math.max(slots.left, slots.right) + 8 + (NOTCH_METRICS.openFlare + 14) * zoom) : 0;
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
  const height = Math.round(expanded ? Math.min(maxHeight, NOTCH_METRICS.openHeight * zoom, contentHeight + (geometry.gapWidth > 0 ? geometry.height : 0)) : geometry.height);
  // Snap to device pixels rather than whole points: an odd width centred on a
  // whole-point camera centre starts on a half point, and rounding it would
  // shift the outline off the hardware notch. Only the canvas is integral.
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1;
  const x = Math.round((geometry.centerX - width / 2) * scale) / scale;
  return { x, y: Math.round(geometry.y), width, height };
}

// The hover outline: the resting shell grown outward and downward.
function notchPeekBounds(closed) {
  return { x: closed.x - NOTCH_METRICS.peekGrow, y: closed.y, width: closed.width + 2 * NOTCH_METRICS.peekGrow,
    height: closed.height + NOTCH_METRICS.peekDrop };
}

// The native canvas holds the open outline plus its spring overshoot and drop
// shadow, which grow sideways and downward from the menu bar only.
function notchCanvasBounds(open, closed, zoom = 1) {
  const reach = NOTCH_METRICS.shadowBlur * 3 * zoom;
  const x = Math.ceil(Math.max(Math.max(0, open.width - closed.width) / 2 * NOTCH_METRICS.overshoot, reach)) + 2;
  const y = Math.ceil(Math.max(Math.max(0, open.height - closed.height) * NOTCH_METRICS.overshoot, reach + NOTCH_METRICS.shadowDrop * zoom)) + 2;
  const left = Math.floor(open.x - x);
  return { x: left, y: open.y, width: Math.ceil(open.x + open.width + x) - left, height: open.height + y };
}

function notchCommands(width, height, notched, expanded, notchHeight = 32, zoom = 1) {
  if (!notched) return bubbleCommands({ width, height, tail: 0, tailY: 0, neck: 0, radius: expanded ? NOTCH_METRICS.openRadius * zoom : height / 2 });
  // One path topology at every endpoint, so each control point moves
  // continuously: concave flares into the menu bar, straight sides and round
  // lower corners. Endpoints past the open state extrapolate the same path.
  const hoverScale = notchHeight > 0 ? height / notchHeight : 1;
  const f = Math.max(0, Math.min(expanded ? NOTCH_METRICS.openFlare * zoom : NOTCH_METRICS.restingFlare * hoverScale, width / 4, height / 3));
  const r = Math.max(0, Math.min(expanded ? NOTCH_METRICS.openRadius * zoom : NOTCH_METRICS.restingRadius * hoverScale, height - f, (width - 2 * f) / 2));
  // Resting corners stay circular like the hardware notch; open corners use
  // longer handles, a continuous-curvature corner that eases out of the side.
  const k = expanded ? 0.32 : 0.448;
  // The flare leaves the menu bar briskly and eases into the side over a long
  // handle, so the side continues the curve instead of meeting a circular arc.
  const lead = 0.35, tail = 0.15;
  return [['M', 0, 0],
    ['C', f * lead, 0, f, f * tail, f, f],
    ['L', f, height - r],
    ['C', f, height - r * k, f + r * k, height, f + r, height],
    ['L', width - f - r, height],
    ['C', width - f - r * k, height, width - f, height - r * k, width - f, height - r],
    ['L', width - f, f],
    ['C', width - f, f * tail, width - f * lead, 0, width, 0],
    ['Z']];
}

function translateCommands(commands, x, y = 0) {
  return commands.map(([op, ...points]) => [op, ...points.map((value, i) => value + (i % 2 ? y : x))]);
}
function interpolateCommands(from, to, progress) {
  return to.map(([op, ...points], index) => [op, ...points.map((value, i) => from[index][i + 1] + (value - from[index][i + 1]) * progress)]);
}
module.exports = { NOTCH_METRICS, notchPeekBounds, notchCanvasBounds, notchGeometry, notchMaxHeight, notchBounds, notchCommands, translateCommands, interpolateCommands, rectContains };
