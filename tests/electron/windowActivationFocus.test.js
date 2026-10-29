'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../../src/electron/renderer/windowActivationFocus');

function fixture() {
  const events = {}, windowEvents = {}, frames = [];
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
      requestAnimationFrame: fn => frames.push(fn)
    }
  };
  const controller = create({ document, shell, header: { contains: node => [native, plugin].includes(node) } });
  return { document, shell, native, plugin, editor, content, events,
    focus(target) { document.activeElement = target; events.focusin({ target }); },
    blur() { focused = false; windowEvents.blur(); },
    reopen() { focused = true; },
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

test('a late native focus restore is parked until new input or window blur', () => {
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
