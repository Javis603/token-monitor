'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createWindowsDockBackdrop, helperPathFor } = require('../../src/electron/edgeDock/windowsBackdrop');

class Child extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new EventEmitter();
    this.messages = [];
    this.stdin.write = (line) => { this.messages.push(JSON.parse(line)); return !this.blocked; };
    this.stdin.destroy = () => { this.destroyed = true; };
    this.stdin.end = () => { this.ended = true; };
  }
  kill() { this.killed = true; }
  report(message) { this.stdout.write(JSON.stringify(message) + '\n'); }
}

class Window extends EventEmitter {
  constructor() { super(); this.bounds = { x: -400, y: 100, width: 64, height: 300 }; }
  getBounds() { return this.bounds; }
  isDestroyed() { return this.destroyed === true; }
  isVisible() { return this.hidden !== true; }
  getNativeWindowHandle() { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(9007199254740993n); return buffer; }
}

function fixture(options = {}) {
  const children = [];
  const logs = [];
  const conversions = [];
  const service = createWindowsDockBackdrop({
    app: { isPackaged: false }, platform: 'win32', release: '10.0.22631', helperPath: '/helper.exe',
    screen: { dipToScreenRect(_win, rect) { conversions.push(rect); return { x: -600, y: 150, width: rect.width * 1.5, height: rect.height * 1.5 }; } },
    logger: (line) => logs.push(line), exists: () => true,
    spawnHelper(file, args, config) {
      assert.equal(file, '/helper.exe');
      assert.deepEqual(args, [String(process.pid)]);
      assert.equal(config.windowsHide, true);
      const child = new Child(); children.push(child); return child;
    }, ...options
  });
  const attach = () => {
    const win = new Window(); const material = [];
    const adapter = service.attach(win, (value) => material.push(value));
    return { win, material, adapter };
  };
  return { service, attach, children, logs, conversions };
}

const settle = () => new Promise((resolve) => queueMicrotask(resolve));
const shape = { key: 'rail:right', commands: [['M', 0, 10], ['C', 0, 20, 32, 30, 64, 40], ['Z']] };

test('helper paths point at the project build or packaged resources', () => {
  assert.equal(helperPathFor({ isPackaged: false }), path.resolve(__dirname, '../../build/windows-dock/TokenMonitor.DockBackdrop.exe'));
  assert.equal(helperPathFor({ isPackaged: true }, '/resources'), path.join('/resources', 'windows-dock', 'TokenMonitor.DockBackdrop.exe'));
});

test('one helper serves every surface and converts curves and negative origins to physical pixels', async (t) => {
  const f = fixture();
  const a = f.attach(); const b = f.attach();
  t.after(() => { a.adapter.dispose(); b.adapter.dispose(); f.children[0].emit('exit', 0); });
  a.adapter.update(shape); a.adapter.setOpacity(.75);
  b.adapter.update(shape);
  await settle();
  const child = f.children[0];
  assert.equal(f.children.length, 1);
  assert.equal(child.messages.length, 0, 'wait for native initialization');
  child.report({ type: 'ready', protocol: 1 });
  assert.equal(child.messages.length, 2);
  const message = child.messages[0];
  assert.equal(message.hwnd, '9007199254740993', 'preserve 64-bit handles exactly');
  assert.deepEqual([message.x, message.y, message.width, message.height], [-600, 150, 96, 450]);
  assert.deepEqual(message.commands[1], ['C', 0, 30, 48, 45, 96, 60]);
  assert.equal(message.opacity, .75);
  assert.deepEqual(a.material, [], 'lower the renderer tint only after the surface is attached');
  child.report({ type: 'attached', id: message.id });
  assert.deepEqual(a.material, [true]);
  a.win.hidden = true; a.win.emit('hide'); await settle();
  assert.equal(child.messages.at(-1).opacity, 0);
});

test('backpressure retains the latest state instead of queuing stale animation frames', async (t) => {
  const f = fixture(); const a = f.attach(); const child = f.children[0];
  t.after(() => { a.adapter.dispose(); child.emit('exit', 0); });
  child.report({ type: 'ready', protocol: 1 });
  child.blocked = true;
  a.adapter.update(shape); await settle();
  for (const opacity of [.2, .4, .8, 1]) { a.adapter.setOpacity(opacity); await settle(); }
  assert.equal(child.messages.length, 1);
  child.blocked = false; child.stdin.emit('drain');
  assert.equal(child.messages.length, 2);
  assert.equal(child.messages.at(-1).opacity, 1);
});

test('steady hover updates do not re-present unchanged glass, while native movement and stacking still resync', async (t) => {
  const f = fixture(); const a = f.attach(); const child = f.children[0];
  t.after(() => { a.adapter.dispose(); child.emit('exit', 0); });
  child.report({ type: 'ready', protocol: 1 });
  a.adapter.update(shape); a.adapter.setOpacity(1); await settle();
  const initial = child.messages.length;
  for (let i = 0; i < 20; i++) {
    a.adapter.setOpacity(1); a.adapter.update(shape); await settle();
  }
  assert.equal(child.messages.length, initial, 'no repeated native update for the same visible surface');
  a.adapter.reorder(); await settle();
  assert.equal(child.messages.length, initial + 1, 'an explicit raise still repairs stacking');
  a.win.emit('move'); await settle();
  assert.equal(child.messages.length, initial + 2, 'sub-DIP native moves still reach the helper');
  a.adapter.setOpacity(.5); await settle();
  assert.equal(child.messages.at(-1).opacity, .5, 'real fade steps are retained');
});

test('fractional-DPI rounding does not stretch the curve to a rounded getBounds rectangle', async (t) => {
  const f = fixture({ screen: {
    getDisplayMatching: () => ({ scaleFactor: 1.5 }),
    dipToScreenRect: () => ({ x: 150, y: 269, width: 120, height: 746 })
  } });
  const a = f.attach(); const child = f.children[0];
  t.after(() => { a.adapter.dispose(); child.emit('exit', 0); });
  a.win.bounds = { x: 100, y: 179, width: 80, height: 497 };
  a.adapter.update({ key: 'scaled', commands: [['M', 80, 496], ['Z']] });
  child.report({ type: 'ready', protocol: 1 }); await settle();
  assert.deepEqual(child.messages[0].commands[0], ['M', 120, 744]);
});

for (const options of [{ exists: () => false }, { release: '10.0.19045' }]) {
  test(`unavailable helper falls back without spawning: ${options.release || 'missing build'}`, () => {
    const f = fixture(options); const a = f.attach(); const b = f.attach();
    assert.equal(f.children.length, 0);
    assert.deepEqual(a.material, [false]);
    assert.equal(f.logs.length, 1);
    a.adapter.dispose(); b.adapter.dispose();
  });
}

test('helper errors restore every material and reject stale attach acknowledgements', (t) => {
  const f = fixture(); const a = f.attach(); const b = f.attach(); const child = f.children[0];
  t.after(() => { a.adapter.dispose(); b.adapter.dispose(); });
  child.report({ type: 'attached', id: '1' });
  child.stdout.write(JSON.stringify({ type: 'error', message: 'DWM unavailable' }) + '\n'
    + JSON.stringify({ type: 'attached', id: '2' }) + '\n');
  assert.deepEqual(a.material, [true, false]);
  assert.deepEqual(b.material, [false]);
  assert.equal(child.killed, true);
});

test('startup timeout shuts down the helper and restores the tinted fallback', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const a = f.attach();
  t.after(() => a.adapter.dispose());
  t.mock.timers.tick(5000);
  assert.deepEqual(a.material, [false]);
  assert.equal(f.children[0].killed, true);
});

for (const failure of ['startup timeout', 'helper exit']) {
  test(`a new surface generation retries after ${failure}, without retrying a live failed generation`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); const a = f.attach(); const b = f.attach(); const child = f.children[0];
    t.after(() => { a.adapter.dispose(); b.adapter.dispose(); });
    if (failure === 'startup timeout') t.mock.timers.tick(5000);
    else { child.report({ type: 'ready', protocol: 1 }); child.emit('exit', 1); }
    assert.deepEqual(a.material, [false]);
    assert.deepEqual(b.material, [false]);
    a.adapter.dispose();
    const remaining = f.attach();
    t.after(() => remaining.adapter.dispose());
    remaining.adapter.update(shape); remaining.adapter.setOpacity(1); await settle();
    assert.equal(f.children.length, 1, 'no retry while failed surfaces still exist');
    b.adapter.dispose(); remaining.adapter.dispose();

    const fresh = f.attach();
    t.after(() => fresh.adapter.dispose());
    assert.equal(f.children.length, 2, 'all surfaces stopping allows a new helper');
    const next = f.children[1];
    fresh.adapter.update(shape); fresh.adapter.setOpacity(1); await settle();
    child.report({ type: 'ready', protocol: 1 }); child.report({ type: 'error', message: 'stale helper' });
    next.report({ type: 'ready', protocol: 1 });
    assert.equal(next.messages.length, 1, 'new generation updates reach the helper');
    next.report({ type: 'attached', id: next.messages[0].id });
    assert.deepEqual(fresh.material, [true], 'new generation restores glass');
    assert.equal(f.logs.length, 1, 'late responses from the old helper cannot fail the new generation');
  });
}

test('closing all surfaces ends stdin, bounds shutdown and isolates the next helper generation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const a = f.attach(); const child = f.children[0];
  a.win.emit('closed');
  assert.equal(child.ended, true);
  assert.equal(a.win.listenerCount('move'), 0);
  const b = f.attach(); const next = f.children[1];
  child.report({ type: 'attached', id: '1' }); child.emit('exit', 0);
  next.report({ type: 'ready', protocol: 1 }); next.report({ type: 'attached', id: '2' });
  assert.deepEqual(a.material, []);
  assert.deepEqual(b.material, [true]);
  b.adapter.dispose(); t.mock.timers.tick(1000);
  assert.equal(next.killed, true);
});
