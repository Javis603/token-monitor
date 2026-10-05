'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const customPricingFormApi = require('../../src/electron/renderer/customPricingForm');
const { normalizeCustomPricingSetting } = require('../../src/shared/tokscaleCustomPricing');

const appSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const pricingSource = appSource.slice(appSource.indexOf('function customPricingMeta('), appSource.indexOf('function setupCursorAccountUI('));

function fixture(options = {}) {
  const nodes = new Map();
  function node() {
    const classes = new Set();
    const listeners = {};
    return {
      value: '', textContent: '', children: [], disabled: false, open: false, popoverOpen: false,
      get options() { return this.children; },
      classList: {
        add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key),
        toggle: (key, active) => active ? classes.add(key) : classes.delete(key)
      },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute() {},
      matches(selector) { return selector === ':popover-open' && this.popoverOpen; },
      hidePopover() { this.popoverOpen = false; },
      addEventListener(event, handler) { listeners[event] = handler; },
      dispatchEvent(event) { return listeners[event.type]?.(event); },
      click() { if (!this.disabled) return listeners.click?.(); }
    };
  }
  const document = {
    createElement: node,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }
  };
  const state = { settings: { customModelPricing: [] }, stats: { modelAliasSourceIds: ['a', 'b'] } };
  const requests = [];
  const context = {
    state, document, customPricingFormApi, structuredClone, syncContentForm: null, Event: class { constructor(type) { this.type = type; } },
    t: key => key, formatCost: String, isSettingsSurfaceVisible: () => true, setAccountGroupExpanded() {},
    saveSettings: async patch => {
      await options.save?.(patch);
      state.settings.customModelPricing = normalizeCustomPricingSetting(patch.customModelPricing);
    },
    window: { TokenMonitorSyncContentForm: require('../../src/electron/renderer/syncContentForm'), tokenMonitor: { lookupModelPricing: id => new Promise(resolve => requests.push({ id, resolve })) } }
  };
  vm.runInNewContext(`let openCustomPricingForm; ${pricingSource}; setupCustomPricingUI();`, context);
  const get = suffix => document.getElementById('customPricing' + suffix);
  const enter = (suffix, value) => { get(suffix).value = String(value); get(suffix).dispatchEvent({ type: 'input' }); };
  const select = id => { get('ModelSelect').value = id; return get('ModelSelect').dispatchEvent({ type: 'change' }); };
  return { state, get, enter, select, requests };
}

test('pricing editor saves, reopens and removes both cache-write rates', async () => {
  const f = fixture();
  f.get('AddButton').click();
  await f.select('__manual__');
  f.enter('ModelInput', 'manual-model');
  for (const [key, value] of [['Input', 3], ['Output', 15], ['CacheRead', 0.3], ['CacheWrite', 3.75], ['CacheWrite1h', 6]]) f.enter(key, value);
  await f.get('SaveButton').click();
  assert.deepEqual(f.state.settings.customModelPricing, [{
    modelId: 'manual-model', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, cacheWrite1hPerM: 6
  }]);
  const row = f.get('List').children[0];
  assert.match(row.children[0].children[1].textContent, /cacheWrite1h.*\$6/);
  row.children[0].click();
  assert.equal(f.get('CacheWrite1h').value, 6);
  assert.equal(f.get('Advanced').open, true);
  await row.children[1].click();
  assert.deepEqual(f.state.settings.customModelPricing, []);
});

test('advanced pricing starts closed, keeps hidden prefilled prices, and opens saved zero rates', async () => {
  const f = fixture();
  f.get('AddButton').click();
  assert.equal(f.get('Advanced').open, false);
  const lookup = f.select('a');
  f.requests[0].resolve({ ok: true, result: { pricing: { inputCostPerToken: 1e-6, cacheCreationInputTokenCost: 3e-6 } } });
  await lookup;
  assert.equal(f.get('Advanced').open, false, 'new entries stay closed after prefill');
  assert.equal(f.get('AdvancedSummary').textContent, 'settings.customPricing.advancedConfigured');
  await f.get('SaveButton').click();
  assert.equal(f.state.settings.customModelPricing[0].cacheWritePerM, 3, 'collapsed fields are still saved');
  f.get('List').children[0].children[0].click();
  assert.equal(f.get('Advanced').open, true);
  f.enter('CacheWrite', 0);
  f.get('Advanced').open = false;
  await f.get('SaveButton').click();
  f.get('List').children[0].children[0].click();
  assert.equal(f.get('Advanced').open, true, 'zero is a configured price');
  assert.equal(f.get('CacheWrite').value, 0);
  await f.select('__manual__');
  assert.equal(f.get('Advanced').open, false, 'switching models resets disclosure');
  assert.equal(f.get('AdvancedSummary').textContent, '');
  f.enter('ModelInput', 'base-only');
  f.enter('Input', 1);
  await f.get('SaveButton').click();
  f.get('List').children[1].children[0].click();
  assert.equal(f.get('Advanced').open, false, 'base-only saved prices stay closed');
});

test('closing the editor dismisses its pricing guide and leaves no overlay on the next form', () => {
  const f = fixture();
  f.get('AddButton').click();
  f.get('Help').popoverOpen = true;
  f.get('CancelButton').click();
  assert.equal(f.get('Help').popoverOpen, false);
  f.get('AddButton').click();
  assert.equal(f.get('Help').popoverOpen, false);
  assert.equal(f.get('Advanced').open, false);
});

test('delayed prefill preserves edited fields and does not carry the previous model prices', async () => {
  const f = fixture();
  f.get('AddButton').click();
  f.enter('CacheWrite1h', 9);
  const lookup = f.select('a');
  assert.equal(f.get('CacheWrite1h').value, '');
  f.enter('Input', 99);
  f.enter('CacheWrite', '');
  f.requests[0].resolve({ ok: true, result: { pricing: { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6, cacheCreationInputTokenCost: 3e-6 } } });
  await lookup;
  assert.equal(f.get('Input').value, '99');
  assert.equal(f.get('Output').value, 2);
  assert.equal(f.get('CacheWrite').value, '', 'explicitly clearing a field is an edit');
  assert.equal(f.get('CacheRead').value, '');
  assert.equal(f.get('CacheWrite1h').value, '');
});

test('an older lookup and a lookup from a closed form cannot replace the current model prices', async () => {
  const f = fixture();
  f.get('AddButton').click();
  const first = f.select('a');
  const second = f.select('b');
  f.requests[1].resolve({ ok: true, result: { pricing: { outputCostPerToken: 2e-6 } } });
  await second;
  f.requests[0].resolve({ ok: true, result: { pricing: { outputCostPerToken: 8e-6 } } });
  await first;
  assert.equal(f.get('Output').value, 2);
  const pending = f.select('a');
  f.get('CancelButton').click();
  f.get('AddButton').click();
  f.enter('Output', 4);
  f.requests[2].resolve({ ok: true, result: { pricing: { outputCostPerToken: 9e-6 } } });
  await pending;
  assert.equal(f.get('Output').value, '4');
});

test('invalid cache-write values and failed saves leave the editor open with its input intact', async () => {
  const f = fixture({ save: async () => { throw new Error('disk full'); } });
  f.get('AddButton').click();
  await f.select('__manual__');
  f.enter('ModelInput', 'manual-model');
  f.enter('Input', 0);
  f.enter('CacheWrite1h', -1);
  f.get('Advanced').open = false;
  await f.get('SaveButton').click();
  assert.equal(f.get('Error').textContent, 'settings.customPricing.errorNoPrice');
  assert.equal(f.get('Advanced').open, true, 'reveal an invalid hidden rate so it can be corrected');
  f.enter('CacheWrite1h', 0);
  await f.get('SaveButton').click();
  assert.equal(f.get('Error').textContent, 'settings.customPricing.saveFailed');
  assert.equal(f.get('Input').value, '0');
  assert.equal(f.get('CacheWrite1h').value, '0');
  assert.equal(f.get('Form').classList.contains('hidden'), false);
  assert.equal(f.get('SaveButton').disabled, false);
  assert.deepEqual(f.state.settings.customModelPricing, []);
});
