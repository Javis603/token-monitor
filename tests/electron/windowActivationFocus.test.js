'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../../src/electron/renderer/windowActivationFocus');

function fixture() {
  const events = {}, windowEvents = {}, frames = [], timers = new Map();
  let timerId = 0;
  const shell = { focus() { document.activeElement = shell; } };
  const native = { tagName: 'BUTTON' }, plugin = { tagName: 'BUTTON' };
  const editor = { tagName: 'INPUT' }, content = { tagName: 'BUTTON' };
  let focused = true;
  const document = {
    body: { tagName: 'BODY' },
    activeElement: null, hasFocus: () => focused,
    addEventListener: (name, fn) => { events[name] = fn; },
    defaultView: {
      addEventListener: (name, fn) => { windowEvents[name] = fn; },
      requestAnimationFrame: fn => frames.push(fn),
      setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
      clearTimeout: id => timers.delete(id)
    }
  };
  const controller = create({ document, shell, header: { contains: node => [native, plugin].includes(node) } });
  return { document, shell, native, plugin, editor, content, events,
    focus(target) { document.activeElement = target; events.focusin({ target }); },
    blur() { focused = false; windowEvents.blur?.(); },
    reopen() { focused = true; windowEvents.focus?.(); },
    cancel: () => controller.cancel(),
    expire() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    summon: controller.summon,
    flush() { frames.splice(0).forEach(fn => fn()); }
  };
}

test('native and plugin header buttons park focus on explicit summons without activating', () => {
  const f = fixture();
  for (const button of [f.native, f.plugin]) {
    f.focus(button); f.blur(); f.reopen(); f.summon(); f.flush();
    assert.equal(f.document.activeElement, f.shell);
  }
});

test('Tab and arrow navigation preserve the selected header control over window switches', () => {
  for (const key of ['Tab', 'ArrowRight', 'Home', 'End']) {
    const f = fixture();
    f.events.keydown({ key }); f.focus(f.plugin);
    f.blur(); f.reopen(); f.summon(); f.flush();
    assert.equal(f.document.activeElement, f.plugin);
    f.events.pointerdown(); f.summon(); f.flush();
    assert.equal(f.document.activeElement, f.shell, 'pointer interaction ends keyboard ownership');
  }
});

test('OS app switching is not keyboard navigation and never moves focus by itself', () => {
  const f = fixture();
  f.events.keydown({ key: 'Tab', metaKey: true }); f.focus(f.plugin);
  f.blur(); f.reopen(); f.flush();
  assert.equal(f.document.activeElement, f.plugin);
  f.summon(); f.flush(); assert.equal(f.document.activeElement, f.shell);
});

test('Tab consumes navigation after a transient Chromium blur, not before focusin', () => {
  const f = fixture();
  f.focus(f.native); f.events.keydown({ key: 'Tab' });
  f.blur(); f.reopen(); f.focus(f.plugin);
  f.blur(); f.reopen(); f.focus(f.document.body); f.focus(f.plugin);
  f.summon(); f.flush();
  assert.equal(f.document.activeElement, f.plugin);
});

test('a late native focus restore is parked before the one-shot completion', () => {
  const f = fixture();
  f.focus(f.shell); f.summon(); f.flush();
  f.focus(f.plugin); f.flush(); assert.equal(f.document.activeElement, f.shell);
  f.events.pointerdown(); f.focus(f.plugin); f.flush();
  assert.equal(f.document.activeElement, f.plugin);
});

test('editors, content controls, new input and lost native focus win over queued resets', () => {
  const f = fixture();
  for (const target of [f.editor, f.content]) {
    f.focus(target); f.summon(); f.flush(); assert.equal(f.document.activeElement, target);
  }
  for (const name of ['keydown', 'pointerdown']) {
    f.focus(f.plugin); f.summon(); f.events[name]({ key: 'Tab' }); f.flush();
    assert.equal(f.document.activeElement, f.plugin);
  }
  f.focus(f.plugin); f.summon(); f.blur(); f.flush();
  assert.equal(f.document.activeElement, f.plugin);
});


test('summon survives transient blur and body focus before restoring the header', () => {
  const f = fixture();
  f.focus(f.plugin); f.summon(); f.blur(); f.flush();
  f.reopen(); f.focus(f.document.body); f.flush();
  f.focus(f.plugin); f.flush();
  assert.equal(f.document.activeElement, f.shell);
});

test('completed header, keyboard or editor resolution permits later programmatic focus', () => {
  for (const target of ['plugin', 'native', 'editor', 'content']) {
    const f = fixture();
    f.focus(f[target]); f.summon(); f.flush();
    f.focus(f.plugin); f.flush();
    assert.equal(f.document.activeElement, f.plugin);
  }
  const f = fixture();
  f.events.keydown({ key: 'Tab' }); f.focus(f.plugin); f.summon(); f.flush();
  f.focus(f.native); f.flush(); assert.equal(f.document.activeElement, f.native);
});

test('native departure, hide and expiry prevent deferred resets after returning', () => {
  for (const end of ['cancel', 'expire']) {
    const f = fixture();
    f.focus(f.document.body); f.summon(); f.blur(); f[end]();
    f.reopen(); f.focus(f.plugin); f.flush();
    assert.equal(f.document.activeElement, f.plugin);
  }
});

test('a newer summon invalidates frames from the previous transaction', () => {
  const f = fixture();
  f.focus(f.plugin); f.summon(); f.cancel(); f.summon(); f.flush();
  assert.equal(f.document.activeElement, f.shell);
  f.focus(f.native); f.flush(); assert.equal(f.document.activeElement, f.native);
});


test('Enter and Space before the first frame cannot activate incidental header focus', () => {
  for (const key of ['Enter', ' ']) for (const target of ['native', 'plugin']) {
    const f = fixture();
    let prevented = false, stopped = false;
    f.focus(f[target]); f.summon();
    f.events.keydown({ key, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(f.document.activeElement, f.shell);
    f.flush(); assert.equal(f.document.activeElement, f.shell);
  }
});

test('early activation keys preserve deliberate keyboard targets, editors and content controls', () => {
  for (const key of ['Enter', ' ']) for (const target of ['native', 'plugin', 'editor', 'content']) {
    const f = fixture();
    const event = { key, preventDefault() { assert.fail('intentional input was prevented'); }, stopImmediatePropagation() { assert.fail('intentional input was stopped'); } };
    if (['native', 'plugin'].includes(target)) f.events.keydown({ key: 'Tab' });
    f.focus(f[target]); f.summon(); f.events.keydown(event); f.flush();
    assert.equal(f.document.activeElement, f[target]);
  }
});

test('cancelled or unfocused summons do not intercept activation keys', () => {
  for (const end of ['cancel', 'blur']) {
    const f = fixture(); f.focus(f.plugin); f.summon(); f[end]();
    f.events.keydown({ key: 'Enter', preventDefault() { assert.fail('inactive summon intercepted input'); } });
    f.flush(); assert.equal(f.document.activeElement, f.plugin);
  }
});
