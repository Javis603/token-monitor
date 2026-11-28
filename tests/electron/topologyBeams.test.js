'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const beams = require('../../src/electron/renderer/dashboard/topologyBeams');

test('live token rate lengthens and brightens the pulse', () => {
  assert.ok(beams.waveLength(160) > beams.waveLength(10));
  assert.equal(beams.waveLength(-5), beams.waveLength(0));
  assert.ok(beams.waveEnergy(200) > beams.waveEnergy(10));
});

test('pulse keeps the card-sweep timing and pins crest arrival to 0.22', () => {
  // Hop delays (0.16 / 0.62) plus 0.22 put receiving-port crest crossing at 38% and 84%.
  assert.equal(beams.waveState(0, 100, 86), null);
  assert.equal(beams.waveState(0.25, 100, 86), null);
  const start = beams.waveState(0.001, 100, 86);
  assert.ok(start.envelope < 0.1);
  assert.ok(beams.waveProfile((0 - (start.center - 43)) / 86) > 0.999);
  const mid = beams.waveState(0.14, 100, 86);
  assert.ok(beams.waveProfile((100 - (mid.center - 43)) / 86) < 0.95);
  const landed = beams.waveState(0.22, 100, 86);
  assert.equal(landed.envelope, 1);
  assert.ok(beams.waveProfile((100 - (landed.center - 43)) / 86) > 0.999999);
  assert.ok(beams.waveProfile((99 - (landed.center - 43)) / 86) < 1);
  assert.ok(beams.waveProfile((101 - (landed.center - 43)) / 86) < 1);
  const fading = beams.waveState(0.24, 100, 86);
  assert.ok(fading.center > landed.center && fading.envelope < 0.4);
});

test('pulse profile is a single soft bell', () => {
  assert.equal(beams.waveProfile(0), 0);
  assert.equal(beams.waveProfile(1), 0);
  const peak = [0.2, 0.4, 0.55, 0.7, 0.9].map(beams.waveProfile);
  assert.ok(Math.max(...peak) > 0.95 && peak[0] < peak[2] && peak[4] < peak[2]);
});

test('beam colours accept the dashboard display colour formats', () => {
  assert.deepEqual(beams.parseColor('#4db6c7'), [77, 182, 199]);
  assert.deepEqual(beams.parseColor('rgb(140, 150, 200)'), [140, 150, 200]);
  assert.deepEqual(beams.parseColor('var(--accent)'), [106, 180, 240]);
});

test('path table follows the topology link cubic', () => {
  const lut = beams.buildPathLut({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.ok(Math.abs(lut.length - 100) < 0.5);
  const half = beams.pointAt(lut, 50);
  assert.ok(Math.abs(half.x - 50) < 1 && Math.abs(half.y) < 1e-6);
  assert.deepEqual(beams.pointAt(lut, 500), lut.pts.at(-1));
});

test('renderer sleeps between pulses instead of repainting an empty canvas', async () => {
  const ctx = new Proxy({}, {
    get: (target, key) => (key in target ? target[key]
      : String(key).startsWith('create') ? () => ({ addColorStop() {} }) : () => {}),
    set: (target, key, value) => ((target[key] = value), true)
  });
  const canvas = { width: 0, height: 0, isConnected: true, getContext: () => ctx };
  let time = 0;
  let pending = null;
  let requested = 0;
  const renderer = beams.createTopologyBeamRenderer(/** @type {any} */ (canvas), {
    now: () => time,
    requestFrame: (cb) => { requested += 1; pending = cb; return requested; },
    cancelFrame: () => { pending = null; }
  });
  const edge = { id: 'a', p1: { x: 0, y: 0 }, p2: { x: 120, y: 0 }, color: '#4db6c7', rate: 0, delay: 0, vis: 1 };
  renderer.update([edge], { width: 200, height: 40, durationMs: 1000, dark: true, dpr: 1 });

  time = 100; // pulse in flight: keep requesting frames
  pending();
  assert.equal(requested, 2);

  time = 400; // gap until the next cycle: no frame until the timer fires near t = 1000
  pending();
  assert.equal(requested, 2);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(requested, 3);
  renderer.destroy();
});

test('updating edges during an idle-gap sleep cancels the stale timer and wakes immediately', () => {
  const ctx = new Proxy({}, {
    get: (target, key) => (key in target ? target[key]
      : String(key).startsWith('create') ? () => ({ addColorStop() {} }) : () => {}),
    set: (target, key, value) => ((target[key] = value), true)
  });
  const canvas = { width: 0, height: 0, isConnected: true, getContext: () => ctx };
  let time = 400;
  let pending = null;
  let requested = 0;
  const renderer = beams.createTopologyBeamRenderer(/** @type {any} */ (canvas), {
    now: () => time,
    requestFrame: (cb) => { requested += 1; pending = cb; return requested; },
    cancelFrame: () => { pending = null; }
  });
  const edge = { id: 'a', p1: { x: 0, y: 0 }, p2: { x: 120, y: 0 }, color: '#4db6c7', width: 1.5, rate: 0, delay: 0, vis: 1 };
  renderer.update([edge], { width: 200, height: 40, durationMs: 1000, dark: true, dpr: 1 });
  assert.equal(requested, 1);

  pending(); // enters idle-gap sleep (t = 400 with delay 0)
  assert.equal(requested, 1);

  // Switch to a staggered edge that is actively in flight at t = 400 (delay 0.3 => lp = 0.1).
  renderer.update([{ ...edge, delay: 0.3 }], { width: 200, height: 40, durationMs: 1000, dark: true, dpr: 1 });
  assert.equal(requested, 2);
  renderer.destroy();
});
