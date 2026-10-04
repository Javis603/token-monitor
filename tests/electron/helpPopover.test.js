'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHelpPopover } = require('../../src/electron/renderer/helpPopover');

function target(extra = {}) {
  const listeners = new Map();
  return { ...extra,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event = {}) { for (const listener of listeners.get(type) || []) listener({ preventDefault() {}, ...event }); },
    count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); }
  };
}
function fixture() {
  const document = target({ activeElement: null });
  const window = target({ innerWidth: 320, innerHeight: 600 });
  document.defaultView = window;
  function pair(id) {
    const trigger = target({ id, ownerDocument: document, hidden: false, disabled: false, isConnected: true,
      contains(node) { return node === this; }, closest() { return this.ancestorHidden ? {} : null; },
      setAttribute(key, value) { this[key] = value; },
      getBoundingClientRect() { return { left: 290, right: 308, top: 520, bottom: 538, width: 18 }; } });
    const popover = target({ id: id + '-help', style: {}, scrollHeight: 220, offsetHeight: 220, clientHeight: 220,
      contains(node) { return node === this; }, matches() { return this.open === true; },
      showPopover() { this.open = true; }, hidePopover() { this.open = false; } });
    const controller = createHelpPopover({ trigger, popover, document, closeDelay: 10 });
    return { trigger, popover, controller };
  }
  return { document, window, pair };
}

test('independent help instances share the viewport and only one is open per document', () => {
  const f = fixture(), first = f.pair('first'), second = f.pair('second');
  first.trigger.emit('pointerenter');
  assert.equal(first.controller.isOpen(), true);
  assert.equal(f.document.activeElement, null);
  assert.equal(first.popover.style.width, '280px');
  assert.ok(parseFloat(first.popover.style.left) >= 8);
  assert.ok(parseFloat(first.popover.style.top) >= 8);
  assert.ok(parseFloat(first.popover.style.top) + 220 <= 600);
  second.trigger.emit('focus');
  assert.equal(first.controller.isOpen(), false);
  assert.equal(second.controller.isOpen(), true);
  assert.equal(first.trigger['aria-expanded'], 'false');
  assert.equal(second.trigger['aria-describedby'], second.popover.id);
  first.controller.dispose(); second.controller.dispose();
});

test('hover gap, Escape, external scroll and resize close correctly without closing internal scrolling', async () => {
  const f = fixture(), p = f.pair('test');
  p.trigger.emit('pointerenter');
  p.trigger.emit('pointerleave');
  p.popover.emit('pointerenter');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(p.controller.isOpen(), true);
  f.document.emit('scroll', { target: p.popover });
  assert.equal(p.controller.isOpen(), true);
  f.document.emit('scroll', { target: {} });
  assert.equal(p.controller.isOpen(), false);
  p.trigger.emit('click');
  f.window.emit('resize');
  assert.equal(p.controller.isOpen(), false);
  p.trigger.emit('focus');
  f.document.emit('keydown', { key: 'Escape' });
  assert.equal(p.controller.isOpen(), false);
  p.controller.dispose();
});

test('hidden triggers cannot open help and dispose removes listeners and pending close work', async () => {
  const f = fixture(), p = f.pair('test');
  p.trigger.ancestorHidden = true;
  p.trigger.emit('pointerenter');
  assert.equal(p.controller.isOpen(), false);
  p.trigger.ancestorHidden = false;
  p.trigger.emit('click');
  p.trigger.emit('pointerleave');
  p.controller.dispose();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(p.controller.isOpen(), false);
  assert.equal(p.trigger.count() + p.popover.count() + f.document.count() + f.window.count(), 0);
  p.controller.open();
  assert.equal(p.controller.isOpen(), false);
});
