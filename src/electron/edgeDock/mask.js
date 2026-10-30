'use strict';

// Rasterizes dock silhouettes into an alpha mask for the native material.
// Done in the main process, synchronously with the window's bounds change, so
// a surface is never shown with a rectangular material for a frame while a
// renderer round trip catches up.

const SUBSAMPLES = 8;

// Scratch arrays are reused across calls. The main process is single-threaded
// and rasterizeMask never re-enters, so one set serves every caller.
let coverage = new Float32Array(0);
let crossings = new Float64Array(0);
let edges = new Float64Array(0);
const starts = new Float64Array(SUBSAMPLES);
const ends = new Float64Array(SUBSAMPLES);

// One mask per animation frame otherwise leaves ~175MB of short-lived buffers
// per open at 60Hz. The pool returns an exact-length view that callers consume
// synchronously; native image creation copies it and the Windows region reader
// finishes before returning. Oversized masks stay unpooled so a pathological
// input cannot pin memory.
const POOL_LIMIT = 16 * 1024 * 1024;
let pooledBuffer = null;

function maskBuffer(byteLength) {
  if (pooledBuffer && pooledBuffer.length >= byteLength) {
    const buffer = pooledBuffer.subarray(0, byteLength);
    buffer.fill(0);
    return buffer;
  }
  const buffer = Buffer.alloc(byteLength);
  if (byteLength <= POOL_LIMIT) pooledBuffer = buffer;
  return buffer;
}

function ensureScratch(pixelWidth, edgeCount) {
  if (coverage.length < pixelWidth) coverage = new Float32Array(pixelWidth);
  if (crossings.length < edgeCount) crossings = new Float64Array(edgeCount);
  if (edges.length < edgeCount * 4) edges = new Float64Array(edgeCount * 4);
}

// Keeps the previous implementation's scanline math, sample order and
// rounding, so the alpha mask stays byte-identical. The fast path only accepts
// rows whose eight samples each describe one span. Rows outside the polygon's
// y range, or with no crossings at all, are skipped: the buffer is zeroed, so
// their output is already correct. Rows with several spans or non-finite
// crossings take the reference path below.
function rasterizeMask(polygons, width, height, scale = 1) {
  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));
  const buffer = maskBuffer(pixelWidth * pixelHeight * 4);
  let edgeCount = 0;
  for (const polygon of polygons) edgeCount += polygon.length;
  ensureScratch(pixelWidth, edgeCount);

  let edgeEnd = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const [x1, y1] = polygon[index];
      const [x2, y2] = polygon[(index + 1) % polygon.length];
      if (y1 === y2) continue; // horizontal edges never cross a scanline
      const scaledY1 = y1 * scale, scaledY2 = y2 * scale;
      if (scaledY1 < minY) minY = scaledY1;
      if (scaledY2 < minY) minY = scaledY2;
      if (scaledY1 > maxY) maxY = scaledY1;
      if (scaledY2 > maxY) maxY = scaledY2;
      edges[edgeEnd] = x1 * scale;
      edges[edgeEnd + 1] = scaledY1;
      edges[edgeEnd + 2] = x2 * scale;
      edges[edgeEnd + 3] = scaledY2;
      edgeEnd += 4;
    }
  }
  if (edgeEnd === 0) return { buffer, pixelWidth, pixelHeight };

  for (let row = 0; row < pixelHeight; row += 1) {
    // Rows outside the polygon's device-pixel y range cannot contribute.
    if (row + 1 <= minY || row >= maxY) continue;
    coverage.fill(0);
    let oneSpan = true;
    let sawZero = false;
    let empty = true;
    for (let sample = 0; sample < SUBSAMPLES; sample += 1) {
      const y = row + (sample + 0.5) / SUBSAMPLES;
      let count = 0;
      for (let edge = 0; edge < edgeEnd; edge += 4) {
        const x1 = edges[edge], y1 = edges[edge + 1], x2 = edges[edge + 2], y2 = edges[edge + 3];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          crossings[count] = x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
          count += 1;
        }
      }
      if (count === 0) { sawZero = true; continue; }
      empty = false;
      if (count !== 2) { oneSpan = false; break; }
      const start = Math.max(0, Math.min(crossings[0], crossings[1]));
      const end = Math.min(pixelWidth, Math.max(crossings[0], crossings[1]));
      // Non-finite crossings take the reference path; NaN would otherwise
      // leave the row's bounds undefined and fill the whole interior.
      if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) { oneSpan = false; break; }
      starts[sample] = start;
      ends[sample] = end;
    }
    if (empty) continue;
    if (sawZero) oneSpan = false;

    if (!oneSpan) {
      // Reference path: every span, in sample order.
      coverage.fill(0);
      for (let sample = 0; sample < SUBSAMPLES; sample += 1) {
        const y = row + (sample + 0.5) / SUBSAMPLES;
        let count = 0;
        for (let edge = 0; edge < edgeEnd; edge += 4) {
          const x1 = edges[edge], y1 = edges[edge + 1], x2 = edges[edge + 2], y2 = edges[edge + 3];
          if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
            crossings[count] = x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
            count += 1;
          }
        }
        // Array#sort keeps the previous ordering for non-finite crossings;
        // the fast path above bails out before ordering them.
        const sorted = [];
        for (let index = 0; index < count; index += 1) sorted.push(crossings[index]);
        sorted.sort((a, b) => a - b);
        for (let index = 0; index + 1 < sorted.length; index += 2) {
          addSpan(Math.max(0, sorted[index]), Math.min(pixelWidth, sorted[index + 1]), pixelWidth);
        }
      }
    } else {
      let maxStart = -Infinity, minEnd = Infinity;
      for (let sample = 0; sample < SUBSAMPLES; sample += 1) {
        if (starts[sample] > maxStart) maxStart = starts[sample];
        if (ends[sample] < minEnd) minEnd = ends[sample];
      }
      // Columns every sample covers completely are 1.0 in the reference too.
      const lo = Math.ceil(maxStart), hi = Math.floor(minEnd);
      if (hi > lo) coverage.fill(1, lo, hi);
      // Boundary columns keep the reference's per-sample accumulation order.
      for (let sample = 0; sample < SUBSAMPLES; sample += 1) {
        const start = starts[sample], end = ends[sample];
        const first = Math.floor(start);
        const last = Math.min(pixelWidth - 1, Math.floor(end));
        // A span narrower than one column has no interior; walk it once so a
        // column cannot be counted by both boundary ranges.
        const leftEnd = hi > lo ? Math.min(last, lo - 1) : last;
        for (let column = first; column <= leftEnd; column += 1) {
          const overlap = Math.min(end, column + 1) - Math.max(start, column);
          if (overlap > 0) coverage[column] += overlap / SUBSAMPLES;
        }
        if (hi <= lo) continue;
        for (let column = Math.max(first, hi); column <= last; column += 1) {
          const overlap = Math.min(end, column + 1) - Math.max(start, column);
          if (overlap > 0) coverage[column] += overlap / SUBSAMPLES;
        }
      }
    }

    const offset = row * pixelWidth * 4;
    for (let column = 0; column < pixelWidth; column += 1) {
      buffer[offset + column * 4 + 3] = Math.round(Math.min(1, coverage[column]) * 255);
    }
  }
  return { buffer, pixelWidth, pixelHeight };
}

function addSpan(start, end, pixelWidth) {
  if (end <= start) return;
  const first = Math.floor(start);
  const last = Math.min(pixelWidth - 1, Math.floor(end));
  for (let column = first; column <= last; column += 1) {
    const overlap = Math.min(end, column + 1) - Math.max(start, column);
    if (overlap > 0) coverage[column] += overlap / SUBSAMPLES;
  }
}

// setShape() supplies the Windows input region and keeps transparent corners
// click-through. Include every antialiased edge pixel plus a one-pixel fringe:
// clipping at 50% alpha cuts Chromium's smoother edge into visible stair steps.
// Consecutive scanlines with identical spans are merged to keep the region small.
function shapeRectsFromPolygons(polygons, width, height) {
  const { buffer, pixelWidth, pixelHeight } = rasterizeMask(polygons, width, height, 1);
  const rows = [];
  for (let y = 0; y < pixelHeight; y += 1) {
    let start = -1;
    let end = -1;
    for (let x = 0; x < pixelWidth; x += 1) {
      if (buffer[(y * pixelWidth + x) * 4 + 3] === 0) continue;
      if (start < 0) start = x;
      end = x + 1;
    }
    if (start >= 0 && end > start) {
      start = Math.max(0, start - 1);
      end = Math.min(pixelWidth, end + 1);
      rows.push({ x: start, y, width: end - start, height: 1 });
    }
  }
  const rects = [];
  for (const row of rows) {
    const previous = rects.at(-1);
    if (previous && previous.x === row.x && previous.width === row.width && previous.y + previous.height === row.y) {
      previous.height += 1;
    } else {
      rects.push(row);
    }
  }
  return rects;
}

module.exports = { rasterizeMask, shapeRectsFromPolygons };
