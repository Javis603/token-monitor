'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
function functionsBetween(first, next) {
  return source.slice(source.indexOf(`function ${first}(`), source.indexOf(`function ${next}(`));
}

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
  }
  append(...nodes) { this.childNodes.push(...nodes); }
  getAttributeNames() { return [...this.attributes.keys()]; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get disabled() { return this.hasAttribute('disabled'); }
}
class Input extends Element {
  constructor() { super('input'); this.type = 'checkbox'; this.checked = false; }
}
function findInput(element, id) {
  if (element.id === id) return element;
  for (const child of element.childNodes) {
    const found = findInput(child, id);
    if (found) return found;
  }
  return null;
}

for (const [key, id, initial] of [
  ['codexDotsEnabled', 'codexDotsInput', false],
  ['codexDotsVisible', 'codexDotsVisibleInput', true]
]) {
  for (const fail of [false, true]) {
    test(`${key} preserves pending choice across health refresh, then ${fail ? 'rolls back' : 'commits'}`, async () => {
      const state = { settings: { [key]: initial } };
      const pendingSettingsPatches = new Set();
      let resolveSave;
      let rejectSave;
      let current;
      let context;
      const render = () => {
        const next = context.clientHealthGroup({ id: 'collection', key: 'collection', state: 'local' }, [], 'codex');
        const nextInput = findInput(next, id);
        if (current) context.patchRenderedNode(current, nextInput);
        else current = nextInput;
      };
      context = vm.createContext({
        state, pendingSettingsPatches,
        document: { createElement: (tag) => tag === 'input' ? new Input() : new Element(tag) },
        HTMLInputElement: Input,
        Node: { TEXT_NODE: 3 }, t: (key) => key,
        refillOpenClientHealthPanel: render,
        async saveSettings(patch) {
          pendingSettingsPatches.add(patch);
          try {
            await new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
            Object.assign(state.settings, patch);
            render(); // settings push can precede the IPC promise settling
          } finally { pendingSettingsPatches.delete(patch); }
        }
      });
      vm.runInContext(functionsBetween('patchRenderedNode', 'fillClientHealthPanel')
        + functionsBetween('codexDotsSettingState', 'localDayKey'), context);
      render();
      current.checked = !initial;
      const saving = current.listeners.get('change')();
      render(); // health update while the old saved value is still in settings
      assert.equal(current.checked, !initial);
      assert.equal(current.disabled, true);
      assert.equal(pendingSettingsPatches.size, 1);
      await current.listeners.get('change')(); // a second interaction must not send another write
      assert.equal(pendingSettingsPatches.size, 1);
      if (fail) rejectSave(new Error('fixture write failed')); else resolveSave();
      await saving;
      assert.equal(current.checked, fail ? initial : !initial);
      assert.equal(current.disabled, false);
    });
  }
}
