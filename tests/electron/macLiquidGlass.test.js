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
function bridge(arch, { failAt, mainThread = true, available = true, pathSupported = true, subduedSupported = true,
  forceAppearanceSupported = true, initialForceAppearance = false } = {}) {
  const calls = [];
  const bindings = [];
  const structs = {};
  let forceAppearance = initialForceAppearance;
  const koffi = {
    struct(name, fields) { return (structs[name] = { name, fields }); },
    pointer(type) { return { pointer: type }; },
    out(type) { return { out: type }; },
    load() {
      return { func(symbol, result, args) {
        bindings.push({ symbol, result, args });
        if (symbol === 'objc_getClass') return (name) => name === 'NSGlassEffectView' && !available ? 0 : name;
        if (symbol === 'sel_registerName') return (name) => name;
        if (symbol.startsWith('CGPath')) {
          return (...values) => {
            calls.push({ symbol, parameters: values });
            if (symbol === failAt) throw new Error('injected native failure');
            return symbol === 'CGPathCreateMutable' ? 99 : undefined;
          };
        }
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
            case 'window':
              if (target === 40) return 21; // the glass view's own window
              assert.equal(target, 10n);
              return 20;
            case 'instancesRespondToSelector:':
              if (parameters[0] === '_setPath:') return pathSupported;
              if (parameters[0] === 'set_subduedState:') return subduedSupported;
              if (parameters[0] === '_setForceMainAppearance:' || parameters[0] === '_forceMainAppearance') return forceAppearanceSupported;
              throw new Error(`unexpected probe ${parameters[0]}`);
            case '_forceMainAppearance': assert.equal(target, 20); return forceAppearance;
            case '_setForceMainAppearance:': assert.equal(target, 20); forceAppearance = parameters[0] === 1; return;
            case 'colorWithSRGBRed:green:blue:alpha:': assert.equal(target, 'NSColor'); return 60;
            case 'contentView': assert.equal(target, 20); return 30;
            case 'layer':
              if (target === 'CAGradientLayer') return 70;
              if (target === 'CAShapeLayer') return 80;
              if (target === 40) return 41;
              throw new Error(`unexpected layer ${target}`);
            case 'CGColor': assert.equal(target, 60); return 61;
            case 'array': assert.equal(target, 'NSMutableArray'); return 90;
            case 'numberWithDouble:': assert.equal(target, 'NSNumber'); return 91;
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
  return { create: (options) => module.exports.createMacLiquidGlass(win, options), win,
    calls: () => JSON.parse(JSON.stringify(calls, (_, value) => typeof value === 'bigint' ? String(value) : value)),
    bindings, structs };
}

for (const arch of ['arm64', 'x64']) {
  test(`${arch}: Regular tint keeps the same appearance on nonactivating panels and restores untinted defaults`, () => {
    const native = bridge(arch);
    const glass = native.create();
    for (const tintOpacity of [0, 0.25, 0.7, 0, 0.4]) {
      glass.update({ dark: true, radius: 14, style: 'regular', tintOpacity });
    }
    assert.deepEqual(native.calls().filter((call) => call.selector === '_setForceMainAppearance:').map((call) => call.parameters), [[1], [0], [1]]);
    assert.deepEqual(native.calls().filter((call) => call.selector === 'set_subduedState:').map((call) => call.parameters), [[1]]);
    glass.dispose();
    assert.deepEqual(native.calls().filter((call) => call.selector === '_setForceMainAppearance:').at(-1).parameters, [0]);
    assert.equal(native.calls().some((call) => /makeKey|makeMain|setContentView/.test(call.selector)), false);
  });

  test(`${arch}: tint updates without a style change and zero restores the system tint`, () => {
    const native = bridge(arch);
    const glass = native.create();
    for (const tintOpacity of [0.1, 0.1, 0.65, 0, -1, 2, NaN]) {
      glass.update({ dark: true, radius: 14, style: 'clear', tintOpacity });
    }
    assert.deepEqual(native.calls().filter((call) => call.selector === 'colorWithSRGBRed:green:blue:alpha:')
      .map((call) => call.parameters.at(-1)), [0.1, 0.65, 1, 0.35]);
    assert.deepEqual(native.calls().filter((call) => call.selector === 'setTintColor:')
      .map((call) => call.parameters), [[60], [60], [0], [60], [60]]);
    glass.update({ dark: true, radius: 14, style: 'regular', tintOpacity: 0.25 });
    assert.equal(native.calls().filter((call) => call.selector === 'colorWithSRGBRed:green:blue:alpha:').at(-1).parameters.at(-1), 0.25);
    assert.equal(native.calls().filter((call) => call.selector === 'alloc').length, 1);
  });

  test(`${arch}: Regular stays unwashed and Clear stays unsubdued on the retained view`, () => {
    const native = bridge(arch);
    const glass = native.create();
    for (const style of ['regular', 'clear', 'clear', 'regular', 'clear', 'invalid']) {
      glass.update({ dark: true, radius: 14, style });
    }
    assert.deepEqual(native.calls().filter((call) => call.selector === 'setStyle:').map((call) => call.parameters),
      [[0], [1], [0], [1], [0]]);
    assert.deepEqual(native.calls().filter((call) => call.selector === 'set_subduedState:').map((call) => call.parameters),
      [[1], [0], [1], [0], [1]]);
    assert.deepEqual(native.calls().filter((call) => call.selector === '_setForceMainAppearance:').map((call) => call.parameters),
      [[1], [0], [1], [0]]);
    assert.deepEqual(native.calls().filter((call) => call.selector === 'setTintColor:').map((call) => call.parameters),
      [[60], [0], [60], [0]]);
    assert.ok(native.calls().filter((call) => call.selector === 'colorWithSRGBRed:green:blue:alpha:')
      .every((call) => JSON.stringify(call.parameters) === JSON.stringify([0, 0, 0, 0.35])));
    assert.equal(native.calls().some((call) => /makeKey|makeMain|setContentView/.test(call.selector)), false);
    assert.equal(native.calls().filter((call) => call.selector === 'alloc').length, 1);
  });

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

test('Clear restores only the window appearance override it owns on disable', () => {
  for (const initialForceAppearance of [false, true]) {
    const native = bridge('arm64', { initialForceAppearance });
    const glass = native.create();
    glass.update({ dark: true, radius: 14, style: 'clear' });
    glass.dispose();
    assert.deepEqual(native.calls().filter((call) => call.selector === '_setForceMainAppearance:').map((call) => call.parameters),
      initialForceAppearance ? [] : [[1], [0]]);
  }
});

test('Clear does not touch a closed native window and skips an unavailable appearance override', () => {
  const native = bridge('arm64');
  const glass = native.create();
  glass.update({ dark: true, radius: 14, style: 'clear' });
  native.win.isDestroyed = () => true;
  glass.dispose({ windowClosed: true });
  assert.deepEqual(native.calls().filter((call) => call.selector === '_setForceMainAppearance:').map((call) => call.parameters), [[1]]);
  const unsupported = bridge('arm64', { forceAppearanceSupported: false });
  const fallback = unsupported.create();
  fallback.update({ dark: true, radius: 14, style: 'clear' });
  fallback.dispose();
  assert.equal(unsupported.calls().some((call) => call.selector === '_setForceMainAppearance:'), false);
});

test('the glass is subdued before it joins the window, and skips the state when missing', () => {
  const native = bridge('arm64');
  native.create();
  const selectors = native.calls().map((call) => call.selector);
  assert.deepEqual(native.calls().filter((call) => call.selector === 'set_subduedState:').map((call) => [call.target, ...call.parameters]),
    [[40, 1]]);
  assert.ok(selectors.indexOf('set_subduedState:') < selectors.indexOf('addSubview:positioned:relativeTo:'));

  const unsupported = bridge('arm64', { subduedSupported: false });
  const glass = unsupported.create();
  assert.doesNotThrow(() => glass.update({ dark: true, radius: 14, style: 'clear' }));
  assert.doesNotThrow(() => glass.update({ dark: true, radius: 14, style: 'regular' }));
  assert.equal(unsupported.calls().some((call) => call.selector === 'set_subduedState:'), false);
  assert.ok(unsupported.calls().some((call) => call.selector === 'addSubview:positioned:relativeTo:'));
});

test('unsupported API and non-main-thread calls fail before allocating views', () => {
  for (const options of [{ available: false }, { mainThread: false }]) {
    const native = bridge('arm64', options);
    assert.throws(native.create, /unavailable|main thread/);
    assert.equal(native.calls().some((call) => call.selector === 'alloc'), false);
  }
});

const railShape = {
  commands: [['M', 64, 0], ['L', 0, 28], ['C', 0, 40, 10, 50, 20, 50], ['Z']],
  width: 64,
  height: 100
};

for (const arch of ['arm64', 'x64']) {
  test(`${arch}: the camera cap and material use one native path and transaction through overshoot and reversal`, () => {
    const native = bridge(arch);
    const glass = native.create({ shaped: true });
    assert.equal(glass.hardwareShade, true);
    for (const [height, progress] of [[100, 0], [180, 0.6], [240, 1.08], [140, 0.3], [100, 0]]) {
      const start = native.calls().length;
      glass.update({ dark: true, tintOpacity: 0, shape: { ...railShape, height },
        hardwareShade: { capEnd: 32 + (height - 32) * 0.24, fadeEnd: 32 + (height - 32) * 0.74, progress } });
      const calls = native.calls().slice(start);
      const selectors = calls.map(call => call.selector);
      const begin = selectors.indexOf('begin'), commit = selectors.indexOf('commit');
      for (const operation of ['setDisableActions:', '_setPath:', 'setPath:', 'setColors:', 'setLocations:']) {
        assert.ok(selectors.indexOf(operation) > begin && selectors.indexOf(operation) < commit, operation);
      }
      assert.deepEqual(calls.filter(call => ['_setPath:', 'setPath:'].includes(call.selector)).map(call => [call.target, ...call.parameters]), [[40, 99], [80, 99]]);
      const p = Math.max(0, Math.min(1, progress));
      assert.deepEqual(calls.filter(call => call.selector === 'colorWithSRGBRed:green:blue:alpha:').map(call => call.parameters.at(-1)), [1, 1 - p * 0.36, 1 - p * 0.68, 1 - p * 0.77]);
    }
    assert.equal(native.calls().filter(call => call.target === 'CAGradientLayer' && call.selector === 'layer').length, 1);
    assert.deepEqual(native.calls().find(call => call.selector === 'addSublayer:'), { target: 41, selector: 'addSublayer:', parameters: [70] });
    assert.deepEqual(native.calls().find(call => call.selector === 'setZPosition:'), { target: 70, selector: 'setZPosition:', parameters: [1] });
    assert.equal(native.calls().some(call => /setContentView|setSubviews/.test(call.selector)), false);
    glass.dispose(); glass.dispose();
    assert.deepEqual(native.calls().filter(call => call.selector === 'release').map(call => call.target), [70, 40]);
  });
}

test('the native cap hides for capsules and role changes, and renormalizes after canvas resizing', () => {
  const native = bridge('arm64'), glass = native.create({ shaped: true });
  const hardwareShade = { capEnd: 40, fadeEnd: 80, progress: 1 };
  glass.update({ shape: railShape, hardwareShade });
  const start = native.calls().length;
  glass.update({ shape: { ...railShape, height: 200 }, hardwareShade });
  assert.deepEqual(native.calls().slice(start).filter(call => call.selector === 'numberWithDouble:').map(call => call.parameters[0]), [0.2, 0.27, 0.344, 0.4]);
  glass.update({ visible: false });
  glass.update({ visible: true });
  glass.update({ shape: railShape });
  assert.deepEqual(native.calls().filter(call => call.target === 70 && call.selector === 'setHidden:').map(call => call.parameters[0]), [0, 0, 1, 0, 1]);
});

test('a failed camera mask update closes the transaction and still releases native resources', () => {
  const native = bridge('arm64', { failAt: 'setPath:' });
  const glass = native.create({ shaped: true });
  assert.throws(() => glass.update({ shape: railShape, hardwareShade: { capEnd: 40, fadeEnd: 80, progress: 0.5 } }), /injected native failure/);
  const calls = native.calls();
  assert.equal(calls.filter(call => call.symbol === 'CGPathRelease').length, 1);
  assert.equal(calls.at(-1).selector, 'commit');
  glass.dispose();
  assert.deepEqual(native.calls().filter(call => call.selector === 'release').map(call => call.target), [70, 40]);
});

test('a window without a system shadow skips shadow invalidation', () => {
  const native = bridge('arm64');
  native.win.hasShadow = () => false;
  const glass = native.create({ shaped: true });
  glass.update({ dark: true, shape: railShape });
  glass.update({ dark: true, shape: { ...railShape, height: 120 } });
  const calls = native.calls();
  assert.deepEqual(calls.filter((call) => call.selector === '_setPath:').map((call) => call.parameters), [[99], [99]]);
  assert.equal(calls.some((call) => call.selector === 'invalidateShadow'), false);
});

test('enabling a shadow after creation refreshes the next committed shape', () => {
  const native = bridge('arm64');
  native.win.hasShadow = () => false;
  const glass = native.create({ shaped: true });
  glass.update({ dark: true, shape: railShape });
  assert.equal(native.calls().some((call) => call.selector === 'invalidateShadow'), false);
  native.win.hasShadow = () => true;
  glass.update({ dark: true, shape: { ...railShape, height: 120 } });
  assert.equal(native.calls().filter((call) => call.selector === 'invalidateShadow').length, 1);
});

test('a shaped glass takes a bottom-up path, releases it and refreshes the shadow', () => {
  const native = bridge('arm64');
  const glass = native.create({ shaped: true });
  glass.update({ dark: true, shape: railShape });
  glass.update({ dark: true, shape: railShape });
  glass.update({ dark: true, shape: { ...railShape, height: 120 } });
  const calls = native.calls();
  const path = calls.filter((call) => call.symbol?.startsWith('CGPath') && call.symbol !== 'CGPathCreateMutable');
  assert.deepEqual(path.slice(0, 5).map((call) => [call.symbol, ...call.parameters]), [
    ['CGPathMoveToPoint', 99, 0, 64, 100],
    ['CGPathAddLineToPoint', 99, 0, 0, 72],
    ['CGPathAddCurveToPoint', 99, 0, 0, 60, 10, 50, 20, 50],
    ['CGPathCloseSubpath', 99],
    ['CGPathRelease', 99]
  ]);
  assert.equal(path[5].parameters[3], 120, 'a new height re-flips the shape');
  assert.deepEqual(calls.filter((call) => call.selector === '_setPath:').map((call) => call.parameters), [[99], [99]]);
  assert.equal(calls.filter((call) => call.symbol === 'CGPathRelease').length, 2);
  assert.deepEqual(calls.filter((call) => call.selector === 'invalidateShadow').map((call) => call.target), [21, 21]);
  assert.equal(calls.some((call) => call.selector === 'setCornerRadius:'), false);
});

test('a rejected shape still releases its path and reports the failure', () => {
  const native = bridge('arm64', { failAt: '_setPath:' });
  const glass = native.create({ shaped: true });
  assert.throws(() => glass.update({ dark: true, shape: railShape }), /injected native failure/);
  const calls = native.calls();
  assert.equal(calls.filter((call) => call.symbol === 'CGPathRelease').length, 1);
  assert.equal(calls.some((call) => call.selector === 'invalidateShadow'), false);
});

test('a shaped glass fails before allocating when the shape setter is missing', () => {
  const native = bridge('arm64', { pathSupported: false });
  assert.throws(() => native.create({ shaped: true }), /custom shape/);
  assert.equal(native.calls().some((call) => call.selector === 'alloc'), false);
  assert.doesNotThrow(() => native.create());
});

test('role changes hide only the retained background glass and preserve its shape', () => {
  const native = bridge('arm64');
  const glass = native.create({ shaped: true });
  glass.update({ dark: true, shape: railShape, visible: true });
  glass.update({ dark: false, visible: false });
  glass.update({ dark: false, visible: false });
  glass.update({ dark: false, shape: railShape, visible: true });
  assert.deepEqual(native.calls().filter((call) => call.selector === 'setHidden:')
    .map((call) => [call.target, ...call.parameters]), [[40, 0], [40, 1], [40, 0]]);
  assert.equal(native.calls().filter((call) => call.selector === 'alloc').length, 1);
  assert.equal(native.calls().filter((call) => call.selector === '_setPath:').length, 1);
});

for (const arch of ['arm64', 'x64']) {
  test(`${arch}: failed detach still releases the owned view exactly once`, () => {
    const native = bridge(arch, { failAt: 'removeFromSuperview' });
    const glass = native.create();
    assert.throws(() => glass.dispose(), /injected native failure/);
    assert.deepEqual(native.calls().filter(call => call.selector === 'release').map(call => call.target), [40]);
    const disposed = native.calls();
    glass.dispose(); assert.deepEqual(native.calls(), disposed);
  });
}
