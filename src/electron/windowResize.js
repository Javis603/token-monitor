'use strict';

const RESIZE_EDGES = new Set(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resizeBounds(start, edge, delta, limits) {
  if (!start || !RESIZE_EDGES.has(edge)) return null;
  const dx = Number(delta?.x);
  const dy = Number(delta?.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;

  const minWidth = Number(limits?.minWidth) || 1;
  const minHeight = Number(limits?.minHeight) || 1;
  const maxWidth = Number(limits?.maxWidth) || Number.MAX_SAFE_INTEGER;
  const maxHeight = Number(limits?.maxHeight) || Number.MAX_SAFE_INTEGER;
  const next = {
    x: Math.round(Number(start.x) || 0),
    y: Math.round(Number(start.y) || 0),
    width: Math.round(Number(start.width) || minWidth),
    height: Math.round(Number(start.height) || minHeight)
  };

  if (edge.includes('e')) {
    next.width = Math.round(clamp(start.width + dx, minWidth, maxWidth));
  }
  if (edge.includes('s')) {
    next.height = Math.round(clamp(start.height + dy, minHeight, maxHeight));
  }
  if (edge.includes('w')) {
    next.width = Math.round(clamp(start.width - dx, minWidth, maxWidth));
    next.x = Math.round(start.x + start.width - next.width);
  }
  if (edge.includes('n')) {
    next.height = Math.round(clamp(start.height - dy, minHeight, maxHeight));
    next.y = Math.round(start.y + start.height - next.height);
  }

  return next;
}

module.exports = { RESIZE_EDGES, resizeBounds };
