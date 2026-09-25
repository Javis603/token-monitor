'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/macLiquidGlass.js'), 'utf8');
const bounds = { origin: { x: 3, y: 7 }, size: { width: 360, height: 480 } };

// Load the complete production bridge with only its foreign-function boundary
// replaced. Each load has an independent API cache and architecture.
function bridge(arch, { failAt, mainThread = true, available = true } = {}) {
  const calls = [];
  const bindings = [];
  const structs = {};
  const koffi = {
    struct(name, fields) { return (structs[name] = { name, fields }); },
    pointer(type) { return { pointer: type }; },
    out(type) { return { out: type }; },
    load() {
      return { func(symbol, result, args) {
        bindings.push({ symbol, result, args });
        if (symbol === 'objc_getClass') return (name) => name === 'NSGlassEffectView' && !available ? 0 : name;
        if (symbol === 'sel_registerName') return (name) => name;
        return (...values) => {
          if (symbol === 'objc_msgSend_stret') {
            assert.equal(arch, 'x64');
            assert.equal(result, 'void');
            assert.equal(args[0].out.pointer, structs.TokenMonitorGlassRect);
            assert.deepEqual(Array.from(args).slice(1), ['uintptr_t', 'uintptr_t']);
            const [output, target, selector] = values;
            assert.equal(target, 30);
            assert.equal(selector, 'bounds');
            Object.assign(output, bounds);
            calls.push({ target, selector });
            return;
          }
          const [target, selector, ...parameters] = values;
          calls.push({ target, selector, parameters });
          if (selector === failAt) throw new Error('injected native failure');
          switch (selector) {
            case 'isMainThread': return mainThread;
            case 'window': assert.equal(target, 10n); return 20;
            case 'contentView': assert.equal(target, 20); return 30;
            case 'bounds':
              assert.equal(arch, 'arm64');
              assert.equal(result, structs.TokenMonitorGlassRect);
              assert.deepEqual(Array.from(args), ['uintptr_t', 'uintptr_t']);
              return bounds;
            case 'alloc': assert.equal(target, 'NSGlassEffectView'); return 40;
            case 'init': assert.equal(target, 40); return 40;
            case 'stringWithUTF8String:': return parameters[0];
            case 'appearanceNamed:': return parameters[0];
            default: return undefined;
          }
        };
      } };
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, process: { arch },
    require(name) { assert.equal(name, 'koffi'); return koffi; }
  });
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(10n);
  const win = { getNativeWindowHandle: () => handle, isDestroyed: () => false };
  // Normalize VM arrays/objects for strict comparisons across realms.
  return { create: () => module.exports.createMacLiquidGlass(win), win,
    calls: () => JSON.parse(JSON.stringify(calls, (_, value) => typeof value === 'bigint' ? String(value) : value)),
    bindings, structs };
}

for (const arch of ['arm64', 'x64']) {
  test(`${arch}: bridge reads NSRect through the correct ABI and preserves Electron's root`, () => {
    const native = bridge(arch);
    const glass = native.create();
    assert.equal(native.bindings.some((binding) => binding.symbol === 'objc_msgSend_stret'), arch === 'x64');
    assert.deepEqual({ ...native.structs.TokenMonitorGlassRect.fields.size.fields }, { width: 'double', height: 'double' });
    const frame = native.calls().find((call) => call.selector === 'setFrame:');
    assert.deepEqual(frame, { target: 40, selector: 'setFrame:', parameters: [bounds] });
    assert.deepEqual(native.calls().find((call) => call.selector === 'addSubview:positioned:relativeTo:'),
      { target: 30, selector: 'addSubview:positioned:relativeTo:', parameters: [40, -1, 0] });
    assert.equal(native.calls().some((call) => call.selector === 'setContentView:'), false);
    glass.update({ dark: true, radius: 14 });
    glass.update({ dark: true, radius: 14 });
    glass.update({ dark: false, radius: 17 });
    assert.deepEqual(native.calls().filter((call) => call.selector === 'setAppearance:').map((call) => call.parameters),
      [['NSAppearanceNameDarkAqua'], ['NSAppearanceNameAqua']]);
    assert.deepEqual(native.calls().filter((call) => call.selector === 'setCornerRadius:').map((call) => call.parameters), [[14], [17]]);
    glass.dispose();
    const disposed = native.calls();
    glass.dispose();
    glass.update({ dark: true, radius: 14 });
    assert.deepEqual(native.calls(), disposed);
    assert.deepEqual(disposed.slice(-2).map(({ target, selector }) => ({ target, selector })),
      [{ target: 40, selector: 'removeFromSuperview' }, { target: 40, selector: 'release' }]);
  });

  test(`${arch}: closing a window releases only the owned glass once`, () => {
    const native = bridge(arch);
    const glass = native.create();
    native.win.isDestroyed = () => true;
    glass.dispose({ windowClosed: true });
    glass.dispose({ windowClosed: true });
    assert.equal(native.calls().some((call) => call.selector === 'removeFromSuperview'), false);
    assert.deepEqual(native.calls().filter((call) => call.selector === 'release').map((call) => call.target), [40]);
  });

  test(`${arch}: partial initialization cleans up and propagates failure`, () => {
    const native = bridge(arch, { failAt: 'addSubview:positioned:relativeTo:' });
    assert.throws(native.create, /injected native failure/);
    assert.deepEqual(native.calls().slice(-2).map((call) => [call.target, call.selector]),
      [[40, 'removeFromSuperview'], [40, 'release']]);
  });
}

test('unsupported API and non-main-thread calls fail before allocating views', () => {
  for (const options of [{ available: false }, { mainThread: false }]) {
    const native = bridge('arm64', options);
    assert.throws(native.create, /unavailable|main thread/);
    assert.equal(native.calls().some((call) => call.selector === 'alloc'), false);
  }
});
