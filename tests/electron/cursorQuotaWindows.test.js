'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Element } = require('../helpers/notchPanel');
const usageItems = require('../../src/shared/limits/usageItems');
const { limitWindowLabel } = require('../../src/shared/limits/windowLabels');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/limits/windowsView.js'), 'utf8');
const extract = name => source.match(new RegExp(`  function ${name}\\([^]*?\\n  }`))[0];

test('Cursor quota rows display the period and retain their saved visibility identity', () => {
  for (const [kind, label] of [['weekly', 'Weekly'], ['billing', 'Monthly']]) {
    const window = Object.freeze({ kind, label: 'Included usage', remainingPercent: 80 });
    const context = vm.createContext({
      document: { createElement: tag => new Element(tag) },
      settings: () => ({}), usageItems, hideUsageItems() {},
      providerWindowLabel: (provider, window, fallback) => limitWindowLabel(provider.provider, window, fallback),
      providerWindowText: () => ({ value: null, detail: '' }),
      motion: { remainingPercent: window => window.remainingPercent, displayPercent: value => value, windowKey: label => label },
      ...require('../../src/electron/renderer/limits/displayMode'),
      formatPercent: value => `${Math.round(value)}%`,
      colorWithAlpha: value => value, applyBarScale() {}
    });
    vm.runInContext(['tagUsageItem', 'limitMeterNode', 'formatLimitWindowValue', 'limitWindowNode',
      'repairWindowPairs', 'renderProviderWindows'].map(extract).join('\n'), context);
    const row = context.renderProviderWindows({ provider: 'cursor', windows: [window] }, 'white').children[0];
    assert.equal(row.children[0].children[0].textContent, label);
    assert.equal(row.dataset.usageItem, usageItems.limitUsageItemId(window));
    assert.equal(row.dataset.usageItemLabel, label);
    assert.equal(window.label, 'Included usage');
  }
});
