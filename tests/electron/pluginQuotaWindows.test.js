'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Element } = require('../helpers/notchPanel');
const { normalizeReading } = require('../../src/electron/plugins/limits');
const balance = require('../../src/shared/limits/balanceDisplay');
const { limitWindowLabel } = require('../../src/shared/limits/windowLabels');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/limits/windowsView.js'), 'utf8');
const extract = name => source.match(new RegExp(`  function ${name}\\([^]*?\\n  }`))[0];
function render(windows) {
  const context = vm.createContext({
    document: { createElement: tag => new Element(tag) },
    settings: () => ({}), usageItems: { hiddenUsageItemSet: () => new Set() }, hideUsageItems() {},
    ...balance,
    windowForKind: (provider, kind) => provider.windows.find(window => window.kind === kind),
    windowsForKind: (provider, kind) => provider.windows.filter(window => window.kind === kind),
    providerWindowLabel: (provider, window, fallback) => limitWindowLabel(provider.provider, window, fallback),
    limitWindowNode: (label, window) => Object.assign(new Element(), { label, window }),
    provider: normalizeReading({ status: 'ok', windows }, 'plugin:fixture:quota')
  });
  vm.runInContext(extract('repairWindowPairs') + '\n' + extract('renderProviderWindows'), context);
  return context.renderProviderWindows(context.provider, 'blue').children;
}
test('normalized daily and billing plugin quotas each produce a native window', () => {
  for (const kind of ['daily', 'billing']) {
    const nodes = render([{ kind, label: 'Pool', usedPercent: 20, remainingPercent: 80 }]);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].label, 'Pool');
    assert.equal(nodes[0].window.kind, kind);
  }
});
test('mixed plugin quotas preserve repeated windows and render credits exactly once', () => {
  const windows = ['session', 'weekly', 'daily', 'billing', 'daily'].map((kind, index) => ({ kind, label: `Pool ${index}`, usedPercent: 20, remainingPercent: 80 }));
  windows.push({ kind: 'billing', label: 'Wallet', metric: 'credits', remaining: 60, limit: 100, currency: 'USD' });
  const nodes = render(windows);
  assert.deepEqual(Array.from(nodes, node => node.label), [...windows.map(window => window.label)]);
  assert.equal(nodes.filter(node => node.window.metric === 'credits').length, 1);
});
