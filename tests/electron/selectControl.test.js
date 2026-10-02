'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { enhance, navigate, typeahead, popupPosition } = require('../../src/electron/renderer/selectControl');

class Element extends EventTarget {
  constructor(tagName, document) {
    super();
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = document;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.rect = { left: 20, top: 50, right: 220, bottom: 80, width: 200, height: 30 };
    this.scrollHeight = 180;
    this.offsetHeight = 182;
    this.clientHeight = 180;
    this.bindings = new Set();
  }
  get childNodes() { return this.children; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  after(node) { node.parentElement = this.parentElement; this.parentElement.children.splice(this.parentElement.children.indexOf(this) + 1, 0, node); }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
  remove() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  closest() { return this.hidden ? this : this.parentElement?.closest() || null; }
  getBoundingClientRect() { return this.rect; }
  showPopover() { this.popoverOpen = true; }
  hidePopover() { this.popoverOpen = false; }
  matches() { return Boolean(this.popoverOpen); }
  scrollIntoView() { this.scrolled = true; }
  focus() { this.ownerDocument.activeElement = this; }
  addEventListener(type, handler, options) { super.addEventListener(type, handler, options); this.bindings.add(handler); }
  removeEventListener(type, handler, options) { super.removeEventListener(type, handler, options); this.bindings.delete(handler); }
}

function harness({ supported = true, metadata = {}, value = 'local' } = {}) {
  const document = new EventTarget();
  document.createElement = tag => new Element(tag, document);
  document.body = document.createElement('body');
  document.body.rect = { left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 };
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const window = new EventTarget();
  let frame = 0;
  const frames = new Map();
  Object.assign(window, {
    Event, HTMLElement: supported ? Element : class {},
    innerWidth: 400, innerHeight: 600,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', overflowX: 'visible', overflowY: 'visible' }),
    MutationObserver: Observer, ResizeObserver: Observer,
    requestAnimationFrame(callback) { frames.set(++frame, callback); return frame; },
    cancelAnimationFrame(id) { frames.delete(id); }
  });
  document.defaultView = window;
  function addSelect() {
    const label = document.createElement('label');
    const labelTitle = { nodeType: 3, textContent: 'Sync method' };
    label.children.push(labelTitle);
    const select = document.createElement('select');
    select.id = `mode-${document.body.children.length}`;
    label.setAttribute('for', select.id);
    select.setAttribute('aria-describedby', 'mode-description');
    select.labels = [label];
    select.value = value;
    select.options = ['local', 'client', 'host', 'icloud'].map((value, index) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = ['Local only', 'Connect to hub', 'Host hub', 'iCloud'][index];
      option.disabled = index === 3;
      return option;
    });
    label.append(select);
    document.body.append(label);
    const control = enhance(select, { getOptionMeta: option => metadata[option.value] });
    return { select, label, control, trigger: label.children[2], popup: document.body.children.at(-1) };
  }
  const fixture = addSelect();
  return { ...fixture, document, window, observers, frames, addSelect };
}

function send(target, type, properties = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}
const key = (fixture, value, properties) => send(fixture.trigger, 'keydown', { key: value, ...properties });
const open = fixture => send(fixture.trigger, 'click');

test('navigation skips disabled options, clamps at endpoints and supports page steps', () => {
  const options = Array.from({ length: 20 }, (_, index) => ({ disabled: index === 2 }));
  assert.equal(navigate(options, 1, 1), 3);
  assert.equal(navigate(options, 0, -1), 0);
  assert.equal(navigate(options, 19, 1), 19);
  assert.equal(navigate(options, 0, 10), 11);
  assert.equal(navigate(options, 15, -10), 5);
  assert.equal(navigate(options, 0, 'last'), 19);
  assert.equal(navigate([{ disabled: true }], 0, 'first'), -1);
  assert.equal(navigate([], 0, 1), -1);
});

test('typeahead matches prefixes and repeated letters cycle enabled matches', () => {
  const options = [{ label: 'Local' }, { label: 'Light' }, { label: 'Locked', disabled: true }, { label: 'Hub' }];
  assert.equal(typeahead(options, 0, 'l'), 1);
  assert.equal(typeahead(options, 1, 'll'), 0);
  assert.equal(typeahead(options, 1, 'li'), 1);
  assert.equal(typeahead(options, 0, 'hu'), 3);
  assert.equal(typeahead(options, 0, 'zz'), 0);
});

test('popup geometry flips, clamps width and aligns to either trigger edge', () => {
  const viewport = { width: 240, height: 400 };
  const rect = { left: 80, right: 220, top: 330, bottom: 360, width: 140 };
  const above = popupPosition(rect, viewport, { width: 320, height: 200 });
  assert.deepEqual(above, { left: 8, top: 126, width: 224, maxHeight: 318, opensAbove: true });
  const below = popupPosition({ ...rect, top: 20, bottom: 50 }, viewport, { width: 180, height: 150, align: 'end' });
  assert.equal(below.left, 40);
  assert.equal(below.top, 54);
  assert.equal(below.opensAbove, false);
});

test('enhancement preserves source interface and links accessible name and description', () => {
  const f = harness();
  assert.equal(f.select.hidden, true);
  assert.equal(f.select.tabIndex, -1);
  assert.equal(f.label.getAttribute('for'), f.trigger.id);
  assert.equal(f.trigger.getAttribute('role'), 'combobox');
  assert.equal(f.trigger.getAttribute('aria-label'), 'Sync method');
  assert.equal(f.trigger.getAttribute('aria-describedby'), 'mode-description');
  assert.equal(enhance(f.select), f.control);
  open(f);
  assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(f.trigger.getAttribute('aria-activedescendant'), f.popup.children[0].id);
  assert.equal(f.popup.children[3].getAttribute('aria-disabled'), 'true');
  f.control.destroy();
});

test('option confirmation emits input and change once; same value emits neither', () => {
  const f = harness();
  const events = [];
  f.select.addEventListener('input', event => events.push(['input', event.bubbles]));
  f.select.addEventListener('change', event => events.push(['change', event.bubbles]));
  open(f);
  send(f.popup.children[1], 'click');
  assert.equal(f.select.value, 'client');
  assert.deepEqual(events, [['input', true], ['change', true]]);
  assert.equal(f.trigger.children[1].textContent, 'Connect to hub');
  open(f);
  send(f.popup.children[1], 'click');
  assert.equal(events.length, 2);
  open(f);
  send(f.popup.children[3], 'click');
  assert.equal(f.select.value, 'client');
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
  f.control.destroy();
});

test('keyboard separates highlight from selection and Escape cancels without saving', () => {
  const f = harness();
  key(f, 'ArrowDown');
  key(f, 'ArrowDown');
  assert.equal(f.select.value, 'local');
  assert.equal(f.trigger.getAttribute('aria-activedescendant'), f.popup.children[1].id);
  assert.equal(key(f, 'Escape').defaultPrevented, true);
  assert.equal(f.select.value, 'local');
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  key(f, 'ArrowDown', { altKey: true });
  assert.equal(f.trigger.getAttribute('aria-activedescendant'), f.popup.children[0].id);
  key(f, 'ArrowDown', { altKey: true });
  assert.equal(f.trigger.getAttribute('aria-activedescendant'), f.popup.children[0].id);
  key(f, 'End');
  assert.equal(f.trigger.getAttribute('aria-activedescendant'), f.popup.children[2].id);
  key(f, 'Enter');
  assert.equal(f.select.value, 'host');
  key(f, 'Home');
  key(f, ' ');
  assert.equal(f.select.value, 'local');
  key(f, 'h');
  key(f, 'ArrowUp', { altKey: true });
  assert.equal(f.select.value, 'host');
  f.control.destroy();
});

test('Tab confirms keyboard navigation but outside clicks, blur and trigger toggling cancel', () => {
  const f = harness();
  open(f);
  key(f, 'ArrowDown');
  assert.equal(key(f, 'Tab').defaultPrevented, false);
  assert.equal(f.select.value, 'client');
  open(f);
  key(f, 'ArrowDown');
  open(f);
  assert.equal(f.select.value, 'client');
  open(f);
  key(f, 'ArrowDown');
  send(f.document, 'pointerdown');
  assert.equal(f.select.value, 'client');
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  open(f);
  key(f, 'Home');
  send(f.trigger, 'blur', { relatedTarget: f.select });
  assert.equal(f.select.value, 'client');
  f.control.destroy();
});

test('pointer highlight clears on leave and cannot commit through dismissal or Tab', () => {
  const f = harness({ value: 'host' });
  let changes = 0;
  f.select.addEventListener('change', () => changes++);
  open(f);
  assert.ok(f.popup.children.every(row => row.dataset.highlighted === 'false'));
  assert.equal(f.popup.children[2].dataset.selected, 'true');
  send(f.popup.children[0], 'pointermove', { pointerType: 'mouse' });
  assert.equal(f.popup.children[0].dataset.highlighted, 'true');
  assert.equal(f.select.value, 'host');
  f.control.sync();
  assert.equal(f.popup.children[0].dataset.highlighted, 'true');
  send(f.popup.children[0], 'pointerleave');
  assert.ok(f.popup.children.every(row => row.dataset.highlighted === 'false'));
  assert.equal(f.popup.children[2].dataset.selected, 'true');
  send(f.document, 'pointerdown');
  assert.equal(f.select.value, 'host');
  open(f);
  send(f.popup.children[0], 'pointermove', { pointerType: 'mouse' });
  key(f, 'Tab');
  assert.equal(f.select.value, 'host');
  open(f);
  send(f.popup.children[1], 'pointermove', { pointerType: 'mouse' });
  send(f.trigger, 'blur', { relatedTarget: f.select });
  assert.equal(f.select.value, 'host');
  assert.equal(changes, 0);
  open(f);
  send(f.popup.children[1], 'pointermove', { pointerType: 'mouse' });
  send(f.popup.children[1], 'click');
  assert.equal(f.select.value, 'client');
  assert.equal(changes, 1, 'a direct click still selects and emits one change');
  f.control.destroy();
});

test('keyboard highlight and pointer hover switch ownership without leaving a stale row', () => {
  const f = harness();
  key(f, 'ArrowDown');
  key(f, 'ArrowDown');
  assert.equal(f.popup.children[1].dataset.highlighted, 'true');
  send(f.popup.children[2], 'pointermove', { pointerType: 'mouse' });
  assert.equal(f.popup.children[1].dataset.highlighted, 'false');
  assert.equal(f.popup.children[2].dataset.highlighted, 'true');
  send(f.popup.children[2], 'pointerleave');
  assert.ok(f.popup.children.every(row => row.dataset.highlighted === 'false'));
  key(f, 'ArrowDown');
  assert.equal(f.popup.children[2].dataset.highlighted, 'true');
  key(f, 'Enter');
  assert.equal(f.select.value, 'host');
  f.control.destroy();
});

test('touch and disabled rows do not leave a pointer highlight', () => {
  const f = harness();
  open(f);
  send(f.popup.children[1], 'pointermove', { pointerType: 'touch' });
  send(f.popup.children[3], 'pointermove', { pointerType: 'mouse' });
  assert.ok(f.popup.children.every(row => row.dataset.highlighted === 'false'));
  f.control.destroy();
});

test('plain and rich options share control; icons also appear in the selected trigger', () => {
  const icon = document => document.createElement('svg');
  const f = harness({ metadata: { local: { icon, description: 'This device only.' } } });
  assert.equal(f.trigger.children[0].hidden, false);
  assert.equal(f.trigger.children[0].children[0].tagName, 'SVG');
  const row = f.popup.children[0];
  assert.equal(row.children[1].children[1].textContent, 'This device only.');
  assert.equal(row.getAttribute('aria-describedby'), row.children[1].children[1].id);
  f.select.value = 'client';
  f.control.sync();
  assert.equal(f.trigger.children[0].hidden, true);
  assert.equal(f.popup.children[1].children[1].children[1].hidden, true);
  f.control.destroy();
});

test('sync updates translations, value and availability without events or needless row replacement', () => {
  const metadata = { local: { description: 'This device only.' } };
  const f = harness({ metadata });
  let changes = 0;
  f.select.addEventListener('change', () => changes++);
  const original = f.popup.children[0];
  open(f);
  key(f, 'ArrowDown');
  f.control.sync();
  assert.equal(f.popup.children[0], original);
  assert.equal(f.trigger.getAttribute('aria-activedescendant'), f.popup.children[1].id);
  f.select.options[1].textContent = '連接 Hub';
  metadata.local.description = '只顯示這台裝置。';
  f.observers[0].callback();
  assert.equal(f.popup.children[1].getAttribute('aria-label'), '連接 Hub');
  assert.equal(f.trigger.getAttribute('aria-activedescendant'), f.popup.children[1].id);
  f.select.value = 'client';
  f.control.sync();
  assert.equal(f.trigger.children[1].textContent, '連接 Hub');
  f.select.disabled = true;
  f.control.sync();
  assert.equal(f.trigger.disabled, true);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(changes, 0);
  f.control.destroy();
});

test('only one control is open and window blur, hidden anchor and detachment cancel', () => {
  const f = harness();
  const second = f.addSelect();
  open(f);
  key(f, 'ArrowDown');
  open(second);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(f.select.value, 'local');
  assert.equal(f.document.activeElement, second.trigger);
  send(f.window, 'blur');
  assert.equal(second.trigger.getAttribute('aria-expanded'), 'false');
  open(f);
  key(f, 'ArrowDown');
  f.label.hidden = true;
  f.observers.at(-2).callback();
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(f.select.value, 'local');
  f.label.hidden = false;
  open(f);
  f.label.remove();
  f.observers.at(-2).callback();
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  f.control.destroy();
  second.control.destroy();
});

test('scroll and resize are frame-coalesced and destroy releases listeners and restores source', () => {
  const f = harness();
  open(f);
  send(f.window, 'resize');
  send(f.window, 'resize');
  assert.equal(f.frames.size, 1);
  f.control.destroy();
  assert.equal(f.frames.size, 0);
  assert.equal(f.observers.every(observer => !observer.connected), true);
  assert.equal(f.trigger.bindings.size, 0);
  assert.equal(f.popup.bindings.size, 0);
  assert.equal(f.select.hidden, false);
  assert.equal(f.select.getAttribute('aria-hidden'), null);
  assert.equal(f.select.getAttribute('tabindex'), null);
  assert.equal(f.label.getAttribute('for'), f.select.id);
  f.control.destroy();
});

test('unsupported platform keeps native select; empty and all-disabled choices cannot open', () => {
  const unsupported = harness({ supported: false });
  assert.equal(unsupported.control, null);
  assert.equal(unsupported.select.hidden, false);
  assert.equal(unsupported.label.getAttribute('for'), unsupported.select.id);
  const f = harness();
  f.select.options.forEach(option => { option.disabled = true; });
  f.control.sync();
  assert.equal(f.trigger.disabled, true);
  open(f);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  f.select.options = [];
  f.control.sync();
  assert.equal(f.trigger.children[1].textContent, '');
  f.control.destroy();
});
