'use strict';

// Silhouettes for the edge dock surfaces, as plain command lists. The same
// commands drive two consumers that must agree to the pixel: the renderer turns
// them into the SVG that tints each surface, and the macOS main process
// rasterizes them into the mask that clips the native material to that shape.
(function exposeEdgeDockShapes(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorEdgeDockShapes = api;
})(typeof window !== 'undefined' ? window : null, function createEdgeDockShapes() {
  // Distance from a corner to its cubic control point, as a share of the radius,
  // that best approximates a quarter circle.
  const ARC = 0.448;

  function mirrorX(commands, width) {
    return commands.map(([op, ...points]) => {
      const next = [op];
      for (let index = 0; index < points.length; index += 2) {
        next.push(width - points[index], points[index + 1]);
      }
      return next;
    });
  }

  // A rail flush with the screen edge whose body flows into that edge through
  // two concave shoulders, so it reads as growing out of the display rather
  // than floating next to it. Drawn for the right edge and mirrored for the left.
  // The first and last points sit on the screen edge; `open: true` drops the
  // closing segment so an outline is never stroked along the display edge.
  function railCommands({ width, height, side = 'right', shoulder, radius, open = false }) {
    const w = width;
    const h = height;
    const s = Math.max(0, Math.min(shoulder, h / 2));
    const spread = Math.min(w * 0.53, w - radius);
    const r = Math.max(0, Math.min(radius, (h - 2 * s) / 2, w - spread));
    const commands = [
      ['M', w, 0],
      ['C', w, s * 0.76, w - w * 0.25, s, w - spread, s],
      ['L', r, s],
      ['C', r * ARC, s, 0, s + r * ARC, 0, s + r],
      ['L', 0, h - s - r],
      ['C', 0, h - s - r * ARC, r * ARC, h - s, r, h - s],
      ['L', w - spread, h - s],
      ['C', w - w * 0.25, h - s, w, h - s * 0.76, w, h]
    ];
    if (!open) commands.push(['Z']);
    return side === 'left' ? mirrorX(commands, w) : commands;
  }

  // A rounded card with a broad-necked tail pointing at the rail. `tailY` is the
  // tip's offset from the top; it is clamped so the neck never runs into a
  // corner. Drawn with the tail on the right and mirrored for a left rail.
  function bubbleCommands({ width, height, side = 'right', tail, tailY, neck, radius }) {
    const bw = width - tail;
    // Leave the point inside the BrowserWindow. A tip exactly on its outer edge
    // clips half of the antialiased outline and leaves a notch on both Chromium
    // and the macOS native-material mask.
    const tipX = Math.max(bw, width - 1);
    const h = height;
    const r = Math.max(0, Math.min(radius, h / 2, bw / 2));
    const n = Math.max(0, Math.min(neck, (h - 2 * r) / 2));
    const ty = Math.max(r + n, Math.min(h - r - n, Number(tailY) || h / 2));
    const commands = [
      ['M', r, 0],
      ['L', bw - r, 0],
      ['C', bw - r * ARC, 0, bw, r * ARC, bw, r],
      ['L', bw, ty - n],
      ['C', bw, ty - n * 0.4, bw + tail * 0.5, ty - 1.5, tipX, ty],
      ['C', bw + tail * 0.5, ty + 1.5, bw, ty + n * 0.4, bw, ty + n],
      ['L', bw, h - r],
      ['C', bw, h - r * ARC, bw - r * ARC, h, bw - r, h],
      ['L', r, h],
      ['C', r * ARC, h, 0, h - r * ARC, 0, h - r],
      ['L', 0, r],
      ['C', 0, r * ARC, r * ARC, 0, r, 0],
      ['Z']
    ];
    return side === 'left' ? mirrorX(commands, width) : commands;
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function toSvgPath(commands) {
    return commands.map(([op, ...points]) => `${op}${points.map(round).join(' ')}`).join(' ');
  }

  // Flattens the commands into closed polygons for scanline filling.
  function toPolygons(commands, segments = 24) {
    const polygons = [];
    let current = null;
    let x = 0;
    let y = 0;
    for (const [op, ...p] of commands) {
      if (op === 'M') {
        current = [[p[0], p[1]]];
        polygons.push(current);
        [x, y] = p;
      } else if (op === 'L') {
        current.push([p[0], p[1]]);
        [x, y] = p;
      } else if (op === 'C') {
        for (let step = 1; step <= segments; step += 1) {
          const t = step / segments;
          const u = 1 - t;
          current.push([
            u * u * u * x + 3 * u * u * t * p[0] + 3 * u * t * t * p[2] + t * t * t * p[4],
            u * u * u * y + 3 * u * u * t * p[1] + 3 * u * t * t * p[3] + t * t * t * p[5]
          ]);
        }
        [x, y] = [p[4], p[5]];
      }
    }
    return polygons;
  }

  return {
    bubbleCommands,
    railCommands,
    toPolygons,
    toSvgPath
  };
});
