'use strict';

// The rasterizer is a hot path: one mask per animation frame. These cases pin
// its output byte-for-byte to the reference scanline implementation, so a
// future rewrite cannot change an edge pixel unnoticed.

const assert = require('node:assert/strict');
const test = require('node:test');
const { rasterizeMask } = require('../../src/electron/edgeDock/mask');
const { toPolygons, bubbleCommands, peekCommands, railCommands } = require('../../src/electron/renderer/edgeDock/shapes');
const { notchCommands, translateCommands } = require('../../src/electron/notch/geometry');

const SUBSAMPLES = 8;

// Pre-optimization implementation, kept verbatim as the oracle.
function referenceRasterize(polygons, width, height, scale = 1) {
  const rowCrossings = (scaledPolygons, y) => {
    const crossings = [];
    for (const polygon of scaledPolygons) {
      for (let index = 0; index < polygon.length; index += 1) {
        const [x1, y1] = polygon[index];
        const [x2, y2] = polygon[(index + 1) % polygon.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    return crossings.sort((a, b) => a - b);
  };
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

function assertSame(polygons, width, height, scale = 2) {
  const expected = referenceRasterize(polygons, width, height, scale);
  const actual = rasterizeMask(polygons, width, height, scale);
  assert.equal(actual.pixelWidth, expected.pixelWidth);
  assert.equal(actual.pixelHeight, expected.pixelHeight);
  assert.ok(actual.buffer.equals(expected.buffer), `mask differs at ${width}x${height} @${scale}`);
}

test('mask matches the reference scanline implementation on every surface family', () => {
  const families = {
    notch: (width, height) => translateCommands(notchCommands(width, height, true, true, 32, 1), 1),
    closed: (width, height) => translateCommands(notchCommands(width, height, true, false, 32, 1), 1),
    bubble: (width, height) => bubbleCommands({ width, height, tail: 12, tailY: 8, neck: 4, radius: 12 }),
    peek: (width, height) => peekCommands({ width, height }),
    rail: (width, height) => railCommands({ width, height })
  };
  for (const make of Object.values(families)) {
    for (const width of [24, 160, 320, 712]) {
      for (const height of [8, 32, 120, 240]) {
        let polygons;
        try { polygons = toPolygons(make(width, height)); } catch { continue; }
        assertSame(polygons, Math.ceil(width + 8), Math.ceil(height + 8), 2);
        assertSame(polygons, Math.ceil(width + 8), Math.ceil(height + 8), 1);
      }
    }
  }
  // The real open canvas, once: largest surface and shadow room.
  assertSame(toPolygons(translateCommands(notchCommands(712, 240, true, true, 32, 1), 60)), 833, 307, 2);
});

test('mask matches the reference on degenerate and random polygons', () => {
  assertSame([], 40, 30, 2);
  assertSame([[[5, 5]]], 40, 30, 2);
  assertSame([[[5, 5], [5, 5], [5, 5]]], 40, 30, 2);
  // Non-finite crossings must take the reference path instead of turning a
  // row's interior into an opaque span.
  assertSame([[[0, 0], [NaN, 10], [10, 10], [10, 0]]], 8, 8, 1);
  assertSame([[[0, 0], [Infinity, 10], [10, 10], [10, 0]]], 8, 8, 1);
  assertSame([[[0, 0], [8, 0], [8, 8], [0, 8]], [[2, 2], [NaN, 2], [2, 6], [2, 6]]], 8, 8, 1);
  // Deterministic pseudo-random polygons, including self-intersections and
  // multi-span rows, which take the reference fallback per row.
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let shape = 0; shape < 80; shape += 1) {
    const points = 3 + Math.floor(random() * 9);
    const polygon = [];
    for (let point = 0; point < points; point += 1) {
      polygon.push([random() * 60 - 5, random() * 40 - 5]);
    }
    assertSame([polygon], 60, 40, shape % 2 === 0 ? 1 : 2);
  }
});
