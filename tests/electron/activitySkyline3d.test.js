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

  const clampedZoomed = skyline.clampCamera({ yaw: 0.26, pitch: 0.54, zoom: 2.35, panX: 700, panY: -450 });
  assert.equal(clampedZoomed.zoom, 2.35);
  assert.equal(clampedZoomed.panX, 700, 'zoomed camera expands panX range up to zoom-scaled bound');
  assert.equal(clampedZoomed.panY, -450, 'zoomed camera expands panY range up to zoom-scaled bound');

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

test('createSkylineController pans on zoomed wheel, horizontal/shift wheel, and middle-drag without trapping default vertical scroll', () => {
  const origRaf = global.requestAnimationFrame;
  const origCancelRaf = global.cancelAnimationFrame;
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};

  try {
    const listeners = new Map();
    const classSet = new Set();
    const grad = { addColorStop() {} };
    let transformDpr;
    const ctxStub = {
      setTransform(scale) { transformDpr = scale; },
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      save() {},
      restore() {},
      clip() {},
      fillText() {},
      createLinearGradient: () => grad
    };
    const canvasStub = {
      className: '',
      width: 800,
      height: 320,
      setAttribute() {},
      getContext: () => ctxStub,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 320 }),
      setPointerCapture() {},
      releasePointerCapture() {},
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type) { listeners.delete(type); }
    };
    const hostEl = {
      clientWidth: 800,
      clientHeight: 320,
      classList: {
        toggle(cls, force) { if (force) classSet.add(cls); else classSet.delete(cls); },
        remove(...clsList) { for (const c of clsList) classSet.delete(c); }
      },
      ownerDocument: {
        documentElement: {},
        defaultView: { devicePixelRatio: 1, getComputedStyle: () => ({ fontFamily: 'sans-serif', getPropertyValue: () => '' }) },
        createElement: () => canvasStub
      },
      replaceChildren() {}
    };

    let interacts = 0;
    const hoverEvents = [];
    const ctrl = skyline.createSkylineController(hostEl, {
      onInteract: () => { interacts += 1; },
      onHover: (hit) => { hoverEvents.push(hit); }
    });
    ctrl.setData({ cells: [{ date: '2026-11-26', col: 0, row: 3, tokens: 100, cost: 1, intensity: 2 }], weeks: 1, reducedMotion: true });

    const wheel = listeners.get('wheel');
    const pointerdown = listeners.get('pointerdown');
    const pointermove = listeners.get('pointermove');
    const pointerup = listeners.get('pointerup');
    const mousedown = listeners.get('mousedown');

    // Hover the center tower first so we verify Ctrl-wheel zoom clears stale tooltip/hover state
    const vp = { width: 800, height: 320 };
    const projected = skyline.projectPoint(0, 0.2, 0, ctrl.getState().camera, vp);
    pointermove({ clientX: projected.x, clientY: projected.y });
    assert.equal(ctrl.getState().hoveredDate, '2026-11-26');
    assert.ok(hoverEvents.at(-1)?.cell?.date === '2026-11-26');

    // Ctrl+wheel zoom must clear hoveredDate and emit null hover immediately
    let zoomClearedHover = false;
    wheel({ deltaX: 0, deltaY: -40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, preventDefault() { zoomClearedHover = true; } });
    assert.equal(zoomClearedHover, true);
    assert.equal(ctrl.getState().hoveredDate, '', 'zoom must clear hovered tower state');
    assert.equal(hoverEvents.at(-1), null, 'zoom must clear open hover tooltip');
    ctrl.setPreset('iso');

    // 1. Default 1x vertical wheel lets parent page scroll
    let prevented = false;
    wheel({ deltaX: 0, deltaY: 80, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, 'default 1x vertical scroll must not prevent page scrolling');

    // 2. Horizontal trackpad swipe and Shift+wheel pan horizontally at 1x zoom
    prevented = false;
    wheel({ deltaX: 60, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(ctrl.getState().camera.panX, -60);

    prevented = false;
    wheel({ deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(ctrl.getState().camera.panX, -100);

    // 3. Ctrl+wheel zooms in, and subsequent plain wheel pans both X and Y across expanded bounds
    prevented = false;
    wheel({ deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.ok(ctrl.getState().camera.zoom > 1.02);

    prevented = false;
    wheel({ deltaX: -50, deltaY: 90, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(ctrl.getState().camera.panX, -50);
    assert.equal(ctrl.getState().camera.panY, -90);

    // 4. Middle-mouse press prevents Chromium autoscroll and drags to pan
    let middlePrevented = false;
    mousedown({ button: 1, preventDefault() { middlePrevented = true; } });
    assert.equal(middlePrevented, true);
    let pointerMidPrevented = false;
    pointerdown({ button: 1, shiftKey: false, clientX: 200, clientY: 150, pointerId: 1, preventDefault() { pointerMidPrevented = true; } });
    assert.equal(pointerMidPrevented, true);
    assert.equal(classSet.has('is-panning'), true);
    pointerdown({ button: 0, pointerId: 2, clientX: 700, clientY: 200 });
    pointermove({ clientX: 700, clientY: 200, pointerId: 2 });
    pointerup({ pointerId: 2 });
    assert.equal(classSet.has('is-panning'), true);
    pointermove({ clientX: 280, clientY: 180, pointerId: 1 });
    pointerup({ pointerId: 1 });
    assert.equal(ctrl.getState().camera.panX, 30);
    assert.equal(ctrl.getState().camera.panY, -60);
    assert.ok(interacts > 0);
    const keydown = listeners.get('keydown');
    const beforeKeyOrbit = ctrl.getState().camera.yaw;
    const key = (key, shiftKey = false) => keydown({ key, shiftKey, preventDefault() {} });
    key('ArrowRight');
    assert.notEqual(ctrl.getState().camera.yaw, beforeKeyOrbit);
    key('ArrowRight', true);
    assert.equal(ctrl.getState().camera.panX, 48);
    const beforeZoom = ctrl.getState().camera.zoom;
    key('+');
    assert.ok(ctrl.getState().camera.zoom > beforeZoom);
    const bitmapWidth = canvasStub.width;
    const bitmapHeight = canvasStub.height;
    hostEl.clientWidth /= 2;
    hostEl.clientHeight /= 2;
    hostEl.ownerDocument.defaultView.devicePixelRatio = 2;
    ctrl.resize();
    assert.equal(canvasStub.width, bitmapWidth);
    assert.equal(canvasStub.height, bitmapHeight);
    assert.equal(transformDpr, 2);
    ctrl.destroy();
  } finally {
    global.requestAnimationFrame = origRaf;
    global.cancelAnimationFrame = origCancelRaf;
  }
});

test('large finite and infinite yaw normalize without an unbounded loop', () => {
  assert.ok(Math.abs(skyline.clampCamera({ yaw: 2 ** 60 }).yaw) <= Math.PI);
  assert.equal(skyline.clampCamera({ yaw: Infinity }).yaw, 0);
});
