'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyVibrancyMask } = require('../../src/electron/edgeDock/macVibrancyMask');

function windowHandle() {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(10n);
  return handle;
}

test('raw masks forward the current window shadow state', () => {
  const calls = [];
  const api = { apply: (...args) => { calls.push(args); return true; } };
  let hasShadow = false;
  const win = { isDestroyed: () => false, getNativeWindowHandle: windowHandle, hasShadow: () => hasShadow };
  const mask = { buffer: Buffer.alloc(16), pixelWidth: 2, pixelHeight: 2 };
  assert.equal(applyVibrancyMask(win, mask, 2, 2, { api, platform: 'darwin' }), true);
  assert.equal(calls[0][4], false);
  // A window can enable its shadow later; the next upload must see it.
  hasShadow = true;
  assert.equal(applyVibrancyMask(win, mask, 2, 2, { api, platform: 'darwin' }), true);
  assert.equal(calls[1][4], true);
});

test('a window without hasShadow keeps invalidating its shadow', () => {
  const calls = [];
  const api = { apply: (...args) => { calls.push(args); return true; } };
  const win = { isDestroyed: () => false, getNativeWindowHandle: windowHandle };
  assert.equal(applyVibrancyMask(win, { buffer: Buffer.alloc(16), pixelWidth: 2, pixelHeight: 2 }, 2, 2, { api, platform: 'darwin' }), true);
  assert.equal(calls[0][4], true);
});

test('raw masks must carry a full bitmap and a finite size', () => {
  const calls = [];
  const api = { apply: (...args) => { calls.push(args); return true; } };
  const win = { isDestroyed: () => false, getNativeWindowHandle: windowHandle };
  // The native bridge reads pixelWidth * pixelHeight * 4 bytes.
  assert.equal(applyVibrancyMask(win, { buffer: Buffer.alloc(4), pixelWidth: 2, pixelHeight: 2 }, 2, 2, { api, platform: 'darwin' }), false);
  assert.equal(applyVibrancyMask(win, { buffer: Buffer.alloc(16), pixelWidth: 0, pixelHeight: 2 }, 2, 2, { api, platform: 'darwin' }), false);
  assert.equal(applyVibrancyMask(win, { buffer: Buffer.alloc(16), pixelWidth: 2.5, pixelHeight: 2 }, 2, 2, { api, platform: 'darwin' }), false);
  assert.equal(applyVibrancyMask(win, { buffer: Buffer.alloc(16), pixelWidth: 2, pixelHeight: 2 }, 0, 2, { api, platform: 'darwin' }), false);
  assert.equal(applyVibrancyMask(win, Buffer.alloc(0), 2, 2, { api, platform: 'darwin' }), false);
  assert.equal(applyVibrancyMask(win, { buffer: new Uint8Array(16), pixelWidth: 2, pixelHeight: 2 }, 2, 2, { api, platform: 'darwin' }), false);
  assert.equal(applyVibrancyMask(win, { buffer: Buffer.alloc(16), pixelWidth: 2, pixelHeight: 2 }, 2, 2, { api, platform: 'darwin' }), true);
  assert.equal(calls.length, 1);
});

test('an encoded mask still reaches the legacy bridge and other platforms stop early', () => {
  const calls = [];
  const api = { apply: (...args) => { calls.push(args); return true; } };
  const win = { isDestroyed: () => false, getNativeWindowHandle: windowHandle, hasShadow: () => false };
  assert.equal(applyVibrancyMask(win, Buffer.from([1, 2, 3]), 2, 2, { api, platform: 'darwin' }), true);
  assert.equal(Buffer.isBuffer(calls[0][1]), true);
  assert.equal(applyVibrancyMask(win, Buffer.from([1]), 1, 1, { api, platform: 'win32' }), false);
  assert.equal(applyVibrancyMask(win, null, 1, 1, { api, platform: 'darwin' }), false);
  assert.equal(applyVibrancyMask({ isDestroyed: () => true }, Buffer.from([1]), 1, 1, { api, platform: 'darwin' }), false);
});
