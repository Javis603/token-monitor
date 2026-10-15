'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createWindowsNonActivatingInput, installWindowsNonActivatingInput } = require('../../src/electron/windowsNonActivatingInput');

function fixture({ installResult = 1, installError = null } = {}) {
  const calls = [];
  const callbacks = [];
  const koffi = {
    load(name) {
      assert.equal(name, 'comctl32.dll');
      return {
        func(signature) {
          if (signature.includes('SetWindowSubclass')) {
            assert.match(signature, /^int32_t __stdcall SetWindowSubclass\(/, 'Win32 BOOL is a 32-bit signed integer');
            return (...args) => {
              calls.push(['install', ...args]);
              if (installError) throw installError;
              return installResult;
            };
          }
          if (signature.includes('RemoveWindowSubclass')) {
            assert.match(signature, /^int32_t __stdcall RemoveWindowSubclass\(/, 'Win32 BOOL is a 32-bit signed integer');
            return (...args) => {
              calls.push(['remove', ...args]);
              return 1;
            };
          }
          if (signature.includes('DefSubclassProc')) return (...args) => {
            calls.push(['next', ...args]);
            // The real Chromium handler returns 4 for WM_MOUSEACTIVATE on
            // these windows. Win+L makes Windows consult it before every press.
            return args[1] === 0x21 ? 4 : -123;
          };
          throw new Error(`Unexpected function: ${signature}`);
        }
      };
    },
    proto(signature) { assert.match(signature, /^intptr_t __stdcall/); return signature; },
    pointer(type) { return type; },
    register(fn) { const pointer = { fn }; callbacks.push(pointer); return pointer; },
    unregister(pointer) { calls.push(['unregister', pointer]); }
  };
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.getNativeWindowHandle = () => {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(0x123456789n);
    return handle;
  };
  return { calls, callbacks, win, install: createWindowsNonActivatingInput(koffi) };
}

test('non-activating Windows input retains the press instead of Chromium eating it', () => {
  const f = fixture();
  assert.equal(f.install(f.win), true);
  const [callback] = f.callbacks;
  assert.equal(callback.fn(0x123456789n, 0x21, 42, 0x02010001, 1, 0), 3);
  assert.deepEqual(f.calls.map(([name]) => name), ['install'], 'activation never reaches the click-eating handler');
  assert.equal(f.calls[0][1], 0x123456789n, 'HWND retains its full pointer width');
});

test('all other messages and their signed result stay on the native subclass chain', () => {
  const f = fixture();
  f.install(f.win);
  const [callback] = f.callbacks;
  assert.equal(callback.fn(0x123456789n, 0x84, 99, -42, 1, 0), -123);
  assert.deepEqual(f.calls.at(-1), ['next', 0x123456789n, 0x84, 99, -42]);
  assert.equal(f.install(f.win), true);
  assert.equal(f.callbacks.length, 1, 'repeated installation does not stack callbacks');
});

test('nonzero Win32 BOOL results are successful even when the low byte is zero', () => {
  for (const installResult of [0x100, -1]) {
    const f = fixture({ installResult });
    assert.equal(f.install(f.win), true);
    assert.equal(f.win.listenerCount('closed'), 1);
    assert.equal(f.calls.some(([name]) => name === 'unregister'), false);
  }
});

test('native destruction removes the subclass before chaining and releases the callback after returning', async () => {
  const f = fixture();
  f.install(f.win);
  const [callback] = f.callbacks;
  assert.equal(callback.fn(0x123456789n, 0x82, 0, 0, 1, 0), -123);
  f.win.emit('closed');
  assert.deepEqual(f.calls.map(([name]) => name), ['install', 'remove', 'next']);
  assert.deepEqual(f.calls[1], ['remove', 0x123456789n, callback, 1]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls.map(([name]) => name), ['install', 'remove', 'next', 'unregister']);
  assert.equal(f.calls.at(-1)[1], callback);
});

test('a closed window also releases the callback when no native destruction notification arrives', async () => {
  const f = fixture();
  f.install(f.win);
  f.win.emit('closed');
  assert.equal(f.calls.some(([name]) => name === 'unregister'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.filter(([name]) => name === 'unregister').length, 1);
});

for (const options of [{ installResult: 0 }, { installError: new Error('native install failed') }]) {
  test(`failed subclass installation releases its registered callback (${options.installError ? 'throw' : 'FALSE'})`, () => {
    const f = fixture(options);
    assert.throws(() => f.install(f.win), /SetWindowSubclass returned FALSE|native install failed/);
    assert.deepEqual(f.calls.map(([name]) => name), ['install', 'unregister']);
    assert.equal(f.win.listenerCount('closed'), 0);
  });
}

test('non-Windows platforms and destroyed windows do not install a native callback', () => {
  assert.equal(installWindowsNonActivatingInput(null, { platform: 'darwin' }), false);
  const f = fixture();
  f.win.isDestroyed = () => true;
  assert.equal(f.install(f.win), false);
  assert.equal(f.install(null), false);
  assert.deepEqual(f.callbacks, []);
});
