'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const skyline = require('../../src/electron/renderer/activitySkyline3d');

test('clampCamera normalizes yaw into [-pi, pi] and clamps pitch, zoom, and pan', () => {
  const clamped = skyline.clampCamera({ yaw: Math.PI * 2.5, pitch: 9, zoom: 0.1, panX: 999, panY: -999 });
  assert.ok(clamped.yaw <= Math.PI && clamped.yaw >= -Math.PI);
  assert.equal(clamped.pitch, 1.34);
  assert.equal(clamped.zoom, 0.65);
  assert.equal(clamped.panX, 320);
  assert.equal(clamped.panY, -200);

  const clampedLow = skyline.clampCamera({ yaw: -Math.PI * 2.5, pitch: 0.01, zoom: 9 });
  assert.ok(clampedLow.yaw <= Math.PI && clampedLow.yaw >= -Math.PI);
  assert.equal(clampedLow.pitch, 0.22);
  assert.equal(clampedLow.zoom, 2.35);
  assert.equal(clampedLow.panX, 0);
  assert.equal(clampedLow.panY, 0);
});

test('visibleSideFaces picks the two camera-facing vertical walls in every yaw quadrant', () => {
  assert.deepEqual(skyline.visibleSideFaces(0.4), { zFace: '+z', xFace: '+x' });
  assert.deepEqual(skyline.visibleSideFaces(-0.4), { zFace: '+z', xFace: '-x' });
  assert.deepEqual(skyline.visibleSideFaces(2.5), { zFace: '-z', xFace: '+x' });
  assert.deepEqual(skyline.visibleSideFaces(-2.5), { zFace: '-z', xFace: '-x' });
});

test('sortTowersBackToFront orders farthest towers first across rotated yaws', () => {
  const towers = [
    { id: 'front-right', wx: 10, wz: 3, wy: 0 },
    { id: 'back-left', wx: -10, wz: -3, wy: 0 },
    { id: 'center', wx: 0, wz: 0, wy: 0 }
  ];

  const forwardOrder = skyline.sortTowersBackToFront(towers, { yaw: 0.35, pitch: 0.55, zoom: 1 }, 53)
    .map((t) => t.id);
  assert.deepEqual(forwardOrder, ['back-left', 'center', 'front-right']);

  // Rotating 180 degrees flips near vs far cleanly so painter occlusion remains exact.
  const flippedOrder = skyline.sortTowersBackToFront(towers, { yaw: Math.PI + 0.35, pitch: 0.55, zoom: 1 }, 53)
    .map((t) => t.id);
  assert.deepEqual(flippedOrder, ['front-right', 'center', 'back-left']);
});

test('projectPoint elevates higher y coordinates upward on screen and translates linearly with panX/panY', () => {
  const cam = { yaw: 0.38, pitch: 0.54, zoom: 1.06, panX: 0, panY: 0 };
  const vp = { width: 800, height: 320, weeks: 53 };
  const base = skyline.projectPoint(0, 0, 0, cam, vp);
  const peak = skyline.projectPoint(0, 8, 0, cam, vp);
  const front = skyline.projectPoint(0, 0, 3, cam, vp);
  const back = skyline.projectPoint(0, 0, -3, cam, vp);
  const panned = skyline.projectPoint(0, 0, 0, { ...cam, panX: 42, panY: -18 }, vp);

  assert.ok(peak.y < base.y, 'elevation goes upward on screen');
  assert.ok(front.depth < back.depth, 'positive z is closer to default camera');
  assert.ok(front.scale > back.scale, 'perspective scales closer geometry slightly larger');
  assert.ok(Math.abs((panned.x - base.x) - 42) < 1e-6);
  assert.ok(Math.abs((panned.y - base.y) - (-18)) < 1e-6);
});

test('CAMERA_PRESETS.iso fits full 53-week x 7-day x MAX_H bounds cleanly inside standard card viewports without clipping', () => {
  const weeks = 53;
  const maxH = 3.55;
  for (const vp of [{ width: 692, height: 310, weeks }, { width: 820, height: 320, weeks }]) {
    for (const x of [-weeks / 2 - 0.5, weeks / 2 + 0.5]) {
      for (const y of [0, maxH]) {
        for (const z of [-4.0, 4.0]) {
          const p = skyline.projectPoint(x, y, z, skyline.CAMERA_PRESETS.iso, vp);
          assert.ok(p.x >= 0 && p.x <= vp.width, `x=${p.x} stays inside [0, ${vp.width}]`);
          assert.ok(p.y >= 0 && p.y <= vp.height, `y=${p.y} stays inside [0, ${vp.height}]`);
        }
      }
    }
  }
});

test('applyOrbitDelta rotates and tilts in natural OrbitControls directions across all yaw quadrants', () => {
  const vp = { width: 800, height: 320, weeks: 53 };
  for (const yaw of [0.26, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const cam = { yaw, pitch: 0.54, zoom: 1, panX: 0, panY: 0 };
    const frontPoint = [Math.sin(yaw) * 4, 0, Math.cos(yaw) * 4];
    const prev = skyline.projectPoint(frontPoint[0], frontPoint[1], frontPoint[2], cam, vp);
    const { camera: rotated } = skyline.applyOrbitDelta(cam, 40, 0);
    const next = skyline.projectPoint(frontPoint[0], frontPoint[1], frontPoint[2], rotated, vp);
    assert.ok(next.x > prev.x, `dragging right at yaw=${yaw.toFixed(2)} moves front geometry right`);
  }

  const baseCam = { yaw: 0.26, pitch: 0.54, zoom: 1, panX: 0, panY: 0 };
  const prevTop = skyline.projectPoint(0, 3.5, 0, baseCam, vp);
  const { camera: tilted } = skyline.applyOrbitDelta(baseCam, 0, 40);
  const nextTop = skyline.projectPoint(0, 3.5, 0, tilted, vp);
  assert.ok(tilted.pitch > baseCam.pitch, 'dragging down increases camera pitch toward bird-eye view');
  assert.ok(nextTop.y > prevTop.y, 'dragging down moves elevated peak downward on screen');
});

test('hitTestPolygons returns the topmost painted tower when overlapping', () => {
  const squareAt = (x, y, size) => [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size]
  ];
  const painted = [
    { polygons: [squareAt(100, 100, 40)], item: { date: '2026-10-01' } },
    { polygons: [squareAt(110, 110, 40)], item: { date: '2026-10-08' } }
  ];
  assert.equal(skyline.hitTestPolygons(125, 125, painted)?.date, '2026-10-08');
  assert.equal(skyline.hitTestPolygons(104, 104, painted)?.date, '2026-10-01');
  assert.equal(skyline.hitTestPolygons(10, 10, painted), null);
});
