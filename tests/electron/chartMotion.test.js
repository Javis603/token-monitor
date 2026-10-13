'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const motion = require('../../src/electron/renderer/chartMotion');
function fixture() {
  const calls = [];
  let finish;
  const animation = { pending: true, playState: 'running', finished: new Promise(resolve => { finish = resolve; }) };
  const svg = { animate(frames, options) { calls.push({ frames, options }); return animation; } };
  return { calls, animation, svg, finish };
}
test('a whole SVG shares one linear reveal for line, fill and discontinuous runs', () => {
  const f = fixture();
  assert.equal(motion.reveal(f.svg), f.animation);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].frames, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }]);
  assert.deepEqual(f.calls[0].options, { duration: 920, easing: 'linear', fill: 'backwards' });
  assert.equal(motion.reveal(f.svg), f.animation);
  assert.equal(f.calls.length, 1, 'a running entry must not restart');
});
test('reduced motion and an unavailable element create no animation', () => {
  const f = fixture();
  assert.equal(motion.reveal(f.svg, { reducedMotion: true }), null);
  assert.equal(motion.reveal(null), null);
  assert.equal(f.calls.length, 0);
});
test('completed animations are released instead of retaining the old entry', async () => {
  const f = fixture(); motion.reveal(f.svg);
  assert.equal(motion.running(f.animation), true);
  f.animation.pending = false; f.animation.playState = 'finished'; f.finish();
  await f.animation.finished;
  assert.equal(motion.running(f.animation), false);
  motion.reveal(f.svg);
  assert.equal(f.calls.length, 2);
});
test('model lists and histories share the existing trusted local IPC gate', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const handler = main.match(/ipcMain.handle\('modelSpeed:list'[\s\S]*?\n {2}\}\);/)?.[0];
  assert.ok(handler);
  assert.match(handler, /trustedSender\(event, \[mainWindow\]/);
  // The handler resolves the shared DAY/MONTH/TOTAL range; the list never
  // chooses a window of its own.
  assert.match(handler, /modelSpeedRuntime\?\.list\(modelSpeedRangeOptions\(/);
});
