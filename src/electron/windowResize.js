'use strict';

const EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

function resizedWindowBounds(bounds, edge, delta, limits) {
  if (!EDGES.has(edge)) return null;
  const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)));
  const dx = Number(delta.x) || 0;
  const dy = Number(delta.y) || 0;
  const next = { ...bounds };
  if (edge.includes('e') || edge.includes('w')) {
    next.width = clamp(bounds.width + (edge.includes('w') ? -dx : dx), limits.minWidth, limits.maxWidth);
    if (edge.includes('w')) next.x = bounds.x + bounds.width - next.width;
  }
  if (edge.includes('n') || edge.includes('s')) {
    next.height = clamp(bounds.height + (edge.includes('n') ? -dy : dy), limits.minHeight, limits.maxHeight);
    if (edge.includes('n')) next.y = bounds.y + bounds.height - next.height;
  }
  return next;
}

module.exports = { resizedWindowBounds };
