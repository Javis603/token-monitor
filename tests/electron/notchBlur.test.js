'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { NOTCH_BLUR_ALPHA, NOTCH_BLUR_FEATHER, NOTCH_BLUR_STRENGTH, notchBlurBounds, notchBlurMask } = require('../../src/electron/notch/blur');
const { createProgressiveBlurApi, applyProgressiveBlur } = require('../../src/electron/notch/macProgressiveBlur');

const display = { bounds: { x: 0, y: 0, width: 1470, height: 956 } };

test('blur bounds hang from the panel top and stay on the display', () => {
  const panel = { x: 562.5, y: 0, width: 345, height: 175 };
  assert.deepEqual(notchBlurBounds(display, panel), {
    x: Math.floor(562.5 - NOTCH_BLUR_FEATHER), y: 0,
    width: Math.ceil(562.5 + 345 + NOTCH_BLUR_FEATHER) - Math.floor(562.5 - NOTCH_BLUR_FEATHER),
    height: 175 + NOTCH_BLUR_FEATHER
  });
  const edge = notchBlurBounds({ bounds: { x: 0, y: 0, width: 600, height: 200 } }, { x: 20, y: 0, width: 345, height: 175 });
  assert.deepEqual(edge, { x: 0, y: 0, width: 20 + 345 + NOTCH_BLUR_FEATHER, height: 200 });
});

test('blur mask is opaque under the panel and fades to nothing at the feather', () => {
  const feather = 20;
  const panel = { x: 30, y: 0, width: 100, height: 60 };
  const { buffer, pixelWidth, pixelHeight } = notchBlurMask({ width: 160, height: 80, panel, radius: 10, feather, scale: 1 });
  assert.deepEqual([pixelWidth, pixelHeight], [160, 80]);
  const at = (x, y) => buffer[(y * pixelWidth + x) * 4 + 3];
  assert.equal(at(80, 30), 255, 'inside the panel');
  assert.equal(at(80, 0), 255, 'the top edge is open: the panel hangs from the menu bar');
  assert.equal(at(5, 30), 0, 'past the feather on the side');
  assert.equal(at(80, 79), 0, 'nothing just inside the bottom of the window');
  assert.ok(at(20, 30) > 0 && at(20, 30) < 255, 'the side fades');
  assert.ok(at(35, 65) < at(80, 65), 'the rounded corner sits further from the fade than the straight bottom');
  for (let x = 131; x < 150; x++) assert.ok(at(x, 30) >= at(x + 1, 30), 'monotonic outward');
  for (let i = 0; i < buffer.length; i += 4) assert.ok(buffer[i] === buffer[i + 3] && buffer[i + 1] === buffer[i + 3]);
});

test('blur mask curves shape the visible fade and the radius independently', () => {
  const options = { width: 200, height: 100, panel: { x: 50, y: 0, width: 100, height: 50 }, radius: 10, feather: 40, scale: 1 };
  const plain = notchBlurMask(options), alpha = notchBlurMask({ ...options, curve: NOTCH_BLUR_ALPHA });
  const strength = notchBlurMask({ ...options, curve: NOTCH_BLUR_STRENGTH });
  const at = (mask, x) => mask.buffer[(25 * mask.pixelWidth + x) * 4 + 3];
  assert.equal(at(alpha, 40), 255, 'the visible fade reaches full strength halfway out');
  assert.equal(at(strength, 40), at(plain, 40), 'the radius follows the falloff itself');
  assert.equal(notchBlurMask({ ...options, scale: 2 }).pixelWidth, 400);
});

test('progressive blur bridge is macOS-only and tolerates missing native pieces', () => {
  const win = { isDestroyed: () => false, getNativeWindowHandle: () => { const b = Buffer.alloc(8); b.writeBigUInt64LE(42n); return b; } };
  const masks = { alphaPng: Buffer.from([1]), blurPng: Buffer.from([2]), width: 10, height: 10, radius: 1 };
  const calls = [];
  const api = { apply: (view, value) => { calls.push([view, value]); return true; } };
  assert.equal(applyProgressiveBlur(win, masks, { platform: 'win32', api }), false);
  assert.equal(applyProgressiveBlur(win, { ...masks, blurPng: Buffer.alloc(0) }, { platform: 'darwin', api }), false);
  assert.equal(applyProgressiveBlur({ ...win, isDestroyed: () => true }, masks, { platform: 'darwin', api }), false);
  assert.equal(calls.length, 0);
  assert.equal(applyProgressiveBlur(win, masks, { platform: 'darwin', api }), true);
  assert.deepEqual(calls, [[42, masks]]);
  assert.equal(applyProgressiveBlur(win, masks, { platform: 'darwin', api: { apply: () => { throw new Error('missing'); } } }), false);
  assert.equal(applyProgressiveBlur(win, masks, { platform: 'darwin', api: { apply: () => 'yes' } }), false);
});

test('numberWithBool is sent through a BOOL argument binding', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/electron/notch/macProgressiveBlur.js'), 'utf8');
  // A double travels in a floating-point register; the BOOL is read from an integer one.
  assert.doesNotMatch(source, /sendDouble\([^)]*numberWithBool/);
  assert.match(source, /objc\.func\('objc_msgSend', 'uintptr_t', \['uintptr_t', 'uintptr_t', 'bool'\]\)/);
  assert.match(source, /sendBoolArg\(classes\.number, sel\('numberWithBool:'\), true\)/);
});

function fakeBlurKoffi(missing) {
  const mutations = [];
  const arrays = { containers: ['container'], layers: ['backdrop', 'tint'] };
  return {
    mutations,
    load: () => ({ func(name) {
      if (name === 'sel_registerName' || name === 'objc_getClass') return value => value;
      if (name === 'object_getClassName') return value => value === 'backdrop' ? 'CABackdropLayer' : 'CALayer';
      assert.equal(name, 'objc_msgSend');
      return (target, selector, ...args) => {
        if (selector === 'respondsToSelector:') return args[0] !== missing;
        if (selector === 'isKindOfClass:') return target === 'effect';
        if (selector === 'count') return arrays[target]?.length || 0;
        if (selector === 'objectAtIndex:') return arrays[target][args[0]];
        if (selector === 'window') return 'window';
        if (selector === 'contentView') return 'content';
        if (selector === 'superview') return 'effect';
        if (selector === 'layer') return 'root';
        if (selector === 'sublayers') return target === 'root' ? 'containers' : 'layers';
        if (selector === 'alloc' || selector === 'initWithData:') return 'image';
        if (selector === 'CGImageForProposedRect:context:hints:') return 'cgImage';
        if (selector === 'filterWithType:') return 'filter';
        if (['setValue:forKey:', 'setScale:', 'setFilters:', 'setHidden:', 'setMaskImage:'].includes(selector)) mutations.push(selector);
        return 1;
      };
    } })
  };
}

test('blur checks required selectors before mutating the native material', () => {
  const masks = { alphaPng: Buffer.from([1]), blurPng: Buffer.from([2]), width: 10, height: 10, radius: 1 };
  for (const missing of ['filterWithType:', 'setScale:', 'setFilters:', 'setMaskImage:', 'setValue:forKey:']) {
    const koffi = fakeBlurKoffi(missing);
    assert.equal(createProgressiveBlurApi(koffi).apply(42, masks), false, missing);
    assert.deepEqual(koffi.mutations, [], 'unsupported material stays untouched');
  }
  const supported = fakeBlurKoffi();
  assert.equal(createProgressiveBlurApi(supported).apply(42, masks), true);
  assert.ok(supported.mutations.includes('setMaskImage:'));
});
