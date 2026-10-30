'use strict';

// Exercises the raw-bitmap FFI in macVibrancyMask with a fake koffi boundary.
// The real module is loaded in a VM so createApi can be driven without
// CoreGraphics, and applyVibrancyMask runs through the production wrapper.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { applyVibrancyMask } = require('../../src/electron/edgeDock/macVibrancyMask');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/edgeDock/macVibrancyMask.js'), 'utf8');

function bridge({ image = 103, hasShadow = false } = {}) {
  const calls = [];
  const structs = {};
  function dispatch([target, selector, ...parameters]) {
    if (selector === 'window') return 21;
    if (selector === 'contentView') return 30;
    if (selector === 'superview') return 31;
    if (selector === 'isKindOfClass:') return target === 40;
    if (selector === 'subviews') return target === 31 ? 50 : 0;
    if (selector === 'count') return target === 50 ? 1 : 0;
    if (selector === 'objectAtIndex:') return 40;
    if (selector === 'alloc') return 104;
    if (selector === 'initWithCGImage:size:') {
      assert.equal(target, 104);
      assert.equal(parameters[0], 103);
      // The size struct is created in the VM realm; compare its fields.
      assert.equal(parameters[1].width, 2);
      assert.equal(parameters[1].height, 2);
      return 105;
    }
    return undefined;
  }
  const koffi = {
    struct(name, fields) { return (structs[name] = { name, fields }); },
    load() {
      return { func(symbol, _result, _args) {
        return (...values) => {
          const record = { symbol, values };
          if (symbol === 'objc_msgSend') {
            record.target = values[0];
            record.selector = values[1];
            record.parameters = values.slice(2);
          }
          calls.push(record);
          switch (symbol) {
            case 'sel_registerName': return values[0];
            case 'objc_getClass': return values[0];
            case 'CFDataCreate': return 100;
            case 'CGDataProviderCreateWithCFData': return 101;
            case 'CGColorSpaceCreateDeviceRGB': return 102;
            case 'CGImageCreate':
              if (image === 'throw') throw new Error('injected CGImageCreate failure');
              return image;
            case 'objc_msgSend': return dispatch(values);
            default: return undefined;
          }
        };
      } };
    }
  };
  const sandbox = {
    module: { exports: {} },
    require(name) { assert.equal(name, 'koffi'); return koffi; },
    process: { platform: 'darwin' },
    Buffer,
    console
  };
  vm.runInNewContext(`${source}\nthis.createApi = createApi;`, sandbox);
  const api = sandbox.createApi(koffi);
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(10n);
  const win = { isDestroyed: () => false, getNativeWindowHandle: () => handle, hasShadow: () => hasShadow };
  return { api, win, calls, structs };
}

const mask = { buffer: Buffer.alloc(16), pixelWidth: 2, pixelHeight: 2 };

test('raw upload passes the expected CoreGraphics arguments and releases in order', () => {
  const native = bridge();
  assert.equal(applyVibrancyMask(native.win, mask, 2, 2, { api: native.api, platform: 'darwin' }), true);
  const calls = native.calls;
  const data = calls.find((call) => call.symbol === 'CFDataCreate');
  assert.deepEqual(data.values.slice(0, 1), [0]);
  assert.equal(data.values[1], mask.buffer);
  assert.equal(data.values[2], 16);
  const image = calls.find((call) => call.symbol === 'CGImageCreate');
  assert.deepEqual(image.values, [2, 2, 8, 32, 8, 102, 8194, 101, 0, false, 0]);
  assert.deepEqual(calls.filter((call) => call.symbol === 'CFRelease').map((call) => call.values[0]), [103, 102, 101, 100]);
  const masked = calls.find((call) => call.selector === 'setMaskImage:');
  assert.deepEqual(masked.values, [40, 'setMaskImage:', 105]);
  assert.ok(calls.some((call) => call.target === 105 && call.selector === 'release'));
  assert.equal(calls.some((call) => call.selector === 'invalidateShadow'), false);
});

test('a window with a shadow refreshes it after the image is committed', () => {
  const native = bridge({ hasShadow: true });
  assert.equal(applyVibrancyMask(native.win, mask, 2, 2, { api: native.api, platform: 'darwin' }), true);
  assert.ok(native.calls.some((call) => call.target === 21 && call.selector === 'invalidateShadow'));
});

test('CGImageCreate returning null releases every earlier reference', () => {
  const native = bridge({ image: 0 });
  assert.equal(applyVibrancyMask(native.win, mask, 2, 2, { api: native.api, platform: 'darwin' }), false);
  assert.deepEqual(native.calls.filter((call) => call.symbol === 'CFRelease').map((call) => call.values[0]), [102, 101, 100]);
  assert.equal(native.calls.some((call) => call.selector === 'setMaskImage:'), false);
});

test('a throwing CoreGraphics call still unwinds every reference', () => {
  const native = bridge({ image: 'throw' });
  assert.equal(applyVibrancyMask(native.win, mask, 2, 2, { api: native.api, platform: 'darwin' }), false);
  assert.deepEqual(native.calls.filter((call) => call.symbol === 'CFRelease').map((call) => call.values[0]), [102, 101, 100]);
  assert.equal(native.calls.some((call) => call.selector === 'setMaskImage:'), false);
});
