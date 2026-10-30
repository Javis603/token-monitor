'use strict';

// The progressive blur behind the open panel: a click-through native material
// window whose mask is opaque under the panel and fades out over `feather`
// points around it, so the desktop softens toward the panel instead of ending
// at a hard edge. Pure geometry; the native window lives in the controller.

const NOTCH_BLUR_FEATHER = 84;
// Peak radius beside the panel: enough to soften nearby text while
// its shapes stay recognisable, so the panel reads as lifted off the page
// rather than sitting in a smear. The mask scales it down to nothing outward.
const NOTCH_BLUR_RADIUS = 1;
// The visible fade reaches full strength halfway out, so the outer edge
// dissolves without a seam; inside that the radius alone carries the falloff,
// which keeps the transition free of a crisp-and-blurred double image.
const NOTCH_BLUR_ALPHA = (value) => Math.min(1, value * 2);
const NOTCH_BLUR_STRENGTH = (value) => value;

// Window bounds around the open panel, clamped to the display. The top edge
// stays on the panel's top: the blur hangs from the menu bar like the panel.
function notchBlurBounds(display, panel, feather = NOTCH_BLUR_FEATHER) {
  const area = display.bounds;
  const x = Math.max(area.x, Math.floor(panel.x - feather));
  const right = Math.min(area.x + area.width, Math.ceil(panel.x + panel.width + feather));
  const bottom = Math.min(area.y + area.height, Math.ceil(panel.y + panel.height + feather));
  return { x, y: panel.y, width: Math.max(1, right - x), height: Math.max(1, bottom - panel.y) };
}

// BGRA bitmap for the mask, in device pixels. Alpha is 1 inside the rounded
// panel rectangle and eases to 0 at `feather` points outside it. The panel's
// top edge is open, so only the sides, bottom and lower corners fall off.
function notchBlurMask({ width, height, panel, radius, feather = NOTCH_BLUR_FEATHER, scale = 2, curve = (value) => value }) {
  const pixelWidth = Math.max(1, Math.round(width * scale));
  const pixelHeight = Math.max(1, Math.round(height * scale));
  const buffer = Buffer.alloc(pixelWidth * pixelHeight * 4);
  const r = Math.max(0, Math.min(radius, panel.width / 2, panel.height));
  const left = panel.x, right = panel.x + panel.width, bottom = panel.y + panel.height;
  for (let py = 0; py < pixelHeight; py += 1) {
    const y = (py + 0.5) / scale;
    for (let px = 0; px < pixelWidth; px += 1) {
      const x = (px + 0.5) / scale;
      // Signed distance to a rectangle rounded only at its lower corners.
      const dx = Math.max(left + r - x, 0, x - (right - r));
      const dy = Math.max(0, y - (bottom - r));
      let distance;
      if (dy > 0 && dx > 0) distance = Math.hypot(dx, dy) - r;
      else distance = Math.max(left - x, x - right, y - bottom);
      const t = Math.max(0, Math.min(1, distance / feather));
      // Smoothstep keeps both ends of the falloff free of a visible seam.
      const alpha = distance <= 0 ? 1 : 1 - t * t * (3 - 2 * t);
      const offset = (py * pixelWidth + px) * 4;
      const value = Math.round(Math.max(0, Math.min(1, curve(alpha))) * 255);
      buffer[offset] = buffer[offset + 1] = buffer[offset + 2] = buffer[offset + 3] = value;
    }
  }
  return { buffer, pixelWidth, pixelHeight };
}

module.exports = { NOTCH_BLUR_ALPHA, NOTCH_BLUR_FEATHER, NOTCH_BLUR_RADIUS, NOTCH_BLUR_STRENGTH, notchBlurBounds, notchBlurMask };
