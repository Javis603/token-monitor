'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createMacPrimaryPressMonitor, monitorMacPrimaryPress } = require('../../src/electron/notch/macPrimaryPress');

function fakeKoffi({ unsupported = false, failLocal = false, failRemove = false } = {}) {
  const selectors = new Map(), records = new Map(), callbacks = new Map(), monitors = new Map(), calls = [];
  let id = 1000n;
  const selector = name => { if (!selectors.has(name)) selectors.set(name, ++id); return selectors.get(name); };
  const koffi = {
    calls, callbacks, monitors,
    struct: fields => ({ fields }),
    sizeof: type => Object.keys(type.fields).length === 5 ? 32 : 16,
    proto: (result, args) => ({ result, args }),
    pointer: type => type,
    encode: (buffer, _type, record) => records.set(buffer, record),
    register: (callback, type) => { const pointer = ++id; callbacks.set(pointer, { callback, type }); return pointer; },
    unregister: pointer => { calls.push(['unregister', pointer]); callbacks.delete(pointer); },
    load: () => ({
      symbol: () => 42n,
      func(name, result, args) {
        if (name === 'sel_registerName') return selector;
        if (name === 'objc_getClass') return () => 101n;
        if (name === 'CGEventGetLocation') return event => ({ x: Number(event), y: -250 });
        assert.equal(name, 'objc_msgSend');
        if (result === 'bool') return () => !unsupported;
        if (args.length === 2) return event => event + 100n;
        if (args.length === 4) return (_target, method, mask, block) => {
          const local = method === selector('addLocalMonitorForEventsMatchingMask:handler:');
          assert.equal(mask, 2n, 'only leftMouseDown is requested');
          const record = records.get(block);
          assert.equal(record.isa, 42n); assert.equal(record.flags, 1 << 28);
          assert.equal(records.get(record.descriptor).size, 32);
          assert.deepEqual(callbacks.get(record.invoke).type, { result: local ? 'uintptr_t' : 'void', args: ['void *', 'uintptr_t'] });
          if (local && failLocal) return 0n;
          const token = ++id;
          monitors.set(token, { invoke: record.invoke, local }); calls.push(['add', token]);
          return token;
        };
        if (result === 'void') return (_target, _method, token) => {
          calls.push(['remove', token]);
          if (failRemove && !monitors.get(token).local) throw new Error('remove failed');
          monitors.delete(token);
        };
        assert.fail('unexpected native binding');
      }
    }),
    deliver(local, event = 7n) {
      const monitor = [...monitors.values()].find(m => m.local === local);
      return callbacks.get(monitor.invoke).callback(0n, event);
    }
  };
  return koffi;
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('local and global native monitors deliver event coordinates and preserve local input', async () => {
  const koffi = fakeKoffi(), points = [];
  const stop = createMacPrimaryPressMonitor(koffi)(point => points.push(point));
  assert.equal(koffi.deliver(false), undefined);
  assert.equal(koffi.deliver(true, 9n), 9n, 'local event reaches its original receiver');
  assert.deepEqual(points, [{ x: 107, y: -250 }, { x: 109, y: -250 }]);
  stop(); stop();
  assert.equal(koffi.monitors.size, 0);
  assert.equal(koffi.callbacks.size, 2, 'native callbacks remain registered until their stack has returned');
  for (const { callback } of koffi.callbacks.values()) callback(0n, 10n);
  assert.equal(points.length, 2, 'late callbacks are inert');
  await nextTurn();
  assert.equal(koffi.callbacks.size, 0);
  assert.deepEqual(koffi.calls.map(call => call[0]), ['add', 'add', 'remove', 'remove', 'unregister', 'unregister']);
});

test('a throwing observer never swallows a local click', async () => {
  const koffi = fakeKoffi();
  const stop = createMacPrimaryPressMonitor(koffi)(() => { throw new Error('observer failed'); });
  assert.equal(koffi.deliver(true, 12n), 12n);
  assert.doesNotThrow(() => koffi.deliver(false));
  stop(); await nextTurn();
});

test('partial native installation rolls back monitors and callbacks', async () => {
  const koffi = fakeKoffi({ failLocal: true });
  assert.throws(() => createMacPrimaryPressMonitor(koffi)(() => {}), /unavailable/);
  assert.equal(koffi.monitors.size, 0);
  await nextTurn();
  assert.equal(koffi.callbacks.size, 0);
});

test('unremovable native monitors keep their callback pinned and inert', async () => {
  const koffi = fakeKoffi({ failRemove: true });
  const stop = createMacPrimaryPressMonitor(koffi)(() => assert.fail('disposed monitor must stay silent'));
  assert.throws(stop, /remove failed/);
  await nextTurn();
  assert.equal(koffi.monitors.size, 1);
  assert.equal(koffi.callbacks.size, 1, 'never unregister a callback still owned by AppKit');
  assert.doesNotThrow(() => koffi.deliver(false));
});

test('unsupported native selectors and other platforms skip monitoring', () => {
  const koffi = fakeKoffi({ unsupported: true });
  assert.equal(createMacPrimaryPressMonitor(koffi)(() => {}), null);
  assert.equal(koffi.callbacks.size, 0);
  const api = () => assert.fail('non-macOS must not load a monitor');
  assert.equal(monitorMacPrimaryPress(() => {}, { platform: 'win32', api }), null);
  const logs = [];
  assert.equal(monitorMacPrimaryPress(() => {}, { platform: 'darwin', api: () => { throw new Error('unavailable'); }, logger: line => logs.push(line) }), null);
  assert.equal(logs.length, 1);
});
