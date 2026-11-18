'use strict';
// DOM model shared by owner integration fixtures; adapted from accountSlotsPanel.test.js.
class Node {
  constructor(tag, document) {
    this.style = { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } }; this.rect = { top: 360, bottom: 380, right: 300, width: 160, height: 210 }; this.tagName = tag; this.document = document; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.value = ''; this.className = '';
    this.classList = { contains: name => this.className.split(' ').includes(name), add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; }, remove: name => { this.className = this.className.split(' ').filter(v => v !== name).join(' '); }, toggle: (name, force) => { const yes = force ?? !this.classList.contains(name); this.classList[yes ? 'add' : 'remove'](name); return yes; } };
  }
  set textContent(value) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.text = value; }
  get textContent() { return this.text || this.children.map(child => child.textContent || '').join(''); }
  append(...children) { children.forEach(child => this.insertBefore(child, null)); }
  insertBefore(child, before) { if (typeof child === 'string') child = { textContent: child }; child.remove?.(); this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); child.parentElement = this; }
  moveBefore(child, before) { this.document.moves++; this.insertBefore(child, before); }
  replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  prepend(...children) { for (const child of children.reverse()) this.insertBefore(child, this.children[0] || null); }
  get isConnected() { return this === this.document.root || Boolean(this.parentElement?.isConnected); }
  getBoundingClientRect() { return this.rect; }
  contains(node) { return [...this.walk()].includes(node); }
  showPopover() { this.popoverOpen = true; this.listeners.beforetoggle?.({ newState: 'open' }); this.listeners.toggle?.({ newState: 'open' }); }
  hidePopover() { this.popoverOpen = false; this.listeners.beforetoggle?.({ newState: 'closed' }); this.listeners.toggle?.({ newState: 'closed' }); }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  removeAttribute(key) { delete this.attributes[key]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { const previous = this.listeners[key]; this.listeners[key] = previous ? event => { previous(event); return fn(event); } : fn; }
  focus() { this.document.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  *walk() { yield this; for (const child of this.children) if (child.walk) yield* child.walk(); }
  querySelector(selector) { if (selector.startsWith(':scope > ')) return this.children.find(node => node.classList?.contains(selector.slice(10)));
    return [...this.walk()].find(node => selector[0] === '#' ? node.id === selector.slice(1) : node.classList.contains(selector.slice(1))); }
  matches(selector) {
    if (selector === ':popover-open') return Boolean(this.popoverOpen);
    if (selector === '.slot-row[data-slot-draggable="true"]') return this.classList.contains('slot-row') && this.dataset.slotDraggable === 'true';
    return selector.split(', ').some(part => part[0] === '.' ? this.classList.contains(part.slice(1)) : this.tagName === part);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  removeEventListener(key, fn) { if (this.listeners[key] === fn) delete this.listeners[key]; }
  get offsetWidth() { return 160; }
  get scrollHeight() { return 208; }
  get options() { return this.mockOptions || this.children; }
  set options(options) { this.mockOptions = options; }
  querySelectorAll(selector = '') { if (selector === 'input' || selector === 'select') return [...this.walk()].filter(n => n.tagName === selector); if (selector === '[data-minimax-key]') return [...this.walk()].filter(n => n.dataset.minimaxKey); return [...this.walk()].filter(n => selector.startsWith('.slot-row') ? n.matches(selector) : ['button', 'input'].includes(n.tagName) && !n.disabled); }
  click() { const result = this.listeners.click?.({ detail: 0 }); if (this.attributes.popovertarget) { const menu = this.document.getElementById(this.attributes.popovertarget); if (menu.popoverOpen) menu.hidePopover(); else menu.showPopover(); } return result; }
  key(key, altKey = false) { return this.listeners.keydown?.({ key, altKey, preventDefault() {}, stopPropagation() {} }); }
}

function createDocument() {
  const document = { activeElement: null, moves: 0,
    defaultView: { innerWidth: 800, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {},
    createElement: tag => new Node(tag, document), createTextNode: text => ({ textContent: text }),
    getElementById: id => document.root.querySelector(`#${id}`) || null,
    querySelector: selector => document.root.querySelector(selector),
    querySelectorAll: selector => document.root.querySelectorAll(selector)
  };
  document.root = document.createElement('div');
  return document;
}
module.exports = { createDocument };
