'use strict';

// Rasterizes dock silhouettes into an alpha mask for the native material.
// Done in the main process, synchronously with the window's bounds change, so
// a surface is never shown with a rectangular material for a frame while a
// renderer round trip catches up.

const SUBSAMPLES = 8;

function rowCrossings(polygons, y) {
  const crossings = [];
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const [x1, y1] = polygon[index];
      const [x2, y2] = polygon[(index + 1) % polygon.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
  }
  return crossings.sort((a, b) => a - b);
}

// Returns a BGRA buffer (black, alpha = coverage) at `scale` device pixels per
// point, anti-aliased with vertical supersampling and exact horizontal span
// coverage. Even-odd filling is enough for the simple closed dock shapes.
function rasterizeMask(polygons, width, height, scale = 1) {
  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));
  const buffer = Buffer.alloc(pixelWidth * pixelHeight * 4);
  const coverage = new Float32Array(pixelWidth);
  const scaled = polygons.map((polygon) => polygon.map(([x, y]) => [x * scale, y * scale]));
  for (let row = 0; row < pixelHeight; row += 1) {
    coverage.fill(0);
    for (let sample = 0; sample < SUBSAMPLES; sample += 1) {
      const crossings = rowCrossings(scaled, row + (sample + 0.5) / SUBSAMPLES);
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        const start = Math.max(0, crossings[index]);
        const end = Math.min(pixelWidth, crossings[index + 1]);
        if (end <= start) continue;
        const first = Math.floor(start);
        const last = Math.min(pixelWidth - 1, Math.floor(end));
        for (let column = first; column <= last; column += 1) {
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
