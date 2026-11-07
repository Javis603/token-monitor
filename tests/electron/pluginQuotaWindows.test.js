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
function render(windows, { showLimitUsed = false, native = false } = {}) {
  const context = vm.createContext({
    document: { createElement: tag => new Element(tag) },
    settings: () => ({ showLimitUsed }), usageItems: { hiddenUsageItemSet: () => new Set(), limitUsageItemId: () => 'credits' }, hideUsageItems() {},
    ...balance,
    windowForKind: (provider, kind) => provider.windows.find(window => window.kind === kind),
    windowsForKind: (provider, kind) => provider.windows.filter(window => window.kind === kind),
    providerWindowLabel: (provider, window, fallback) => limitWindowLabel(provider.provider, window, fallback),
    limitWindowNode: (label, window) => Object.assign(new Element(), { label, window }),
    motion: { remainingPercent: window => window.remainingPercent, displayPercent: value => value, windowKey: label => label },
    ...require('../../src/electron/renderer/limits/displayMode'),
    formatPercent: value => `${Math.round(value)}%`, formatLimitBoundary: window => window.boundaryKind === 'expiry' ? 'Expires 30d' : 'Reset 30d',
    colorWithAlpha: value => value, applyBarScale: (node, value) => { node.scale = value; }, tagUsageItem: node => node,
    provider: normalizeReading({ status: 'ok', windows }, 'plugin:fixture:quota')
  });
  if (native) vm.runInContext(['limitMeterNode', 'formatLimitWindowValue', 'limitWindowNode'].map(extract).join('\n'), context);
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
const credit = { kind: 'billing', metric: 'credits', label: 'API credits', remaining: 83.25, limit: 100, currency: 'USD', boundaryKind: 'expiry', resetsAt: '2030-01-01T00:00:00Z' };
test('credits display projection survives normalization and is desktop-only and allowlisted', () => {
  const reading = normalizeReading({status:'ok',windows:[{...credit,creditsDisplay:'percent'}]},'plugin:fixture:quota');
  assert.equal(normalizeReading(reading,reading.provider).windows[0].creditsDisplay,'percent');
  const core = require('../../src/shared/limits/core');
  assert.equal(core.normalizeLimitWindow({...credit,creditsDisplay:'percent'}).creditsDisplay,undefined);
  assert.equal(normalizeReading({status:'ok',windows:[{...credit,creditsDisplay:'arbitrary'}]},reading.provider).windows[0].creditsDisplay,undefined);
});
test('opt-in percentage headline, meter and money detail follow used/remaining and retain expiry', () => {
  for (const showLimitUsed of [false,true]) {
    const [node] = render([{...credit,creditsDisplay:'percent',usedPercent:99}],{native:true,showLimitUsed});
    assert.equal(node.children[0].children[1].textContent,showLimitUsed?'17% used':'83% left');
    assert.equal(node.children[1].children[0].scale,showLimitUsed?0.1675:0.8325);
    assert.equal(node.children[2].children[0].textContent,'Expires 30d');
    assert.equal(node.children[2].children[1].textContent,showLimitUsed?'$16.75 / $100.00':'$83.25 / $100.00');
  }
});
test('legacy display stays monetary; explicit balance and unreliable totals never invent a meter', () => {
  const [legacy] = render([credit],{native:true,showLimitUsed:true});
  assert.equal(legacy.children[0].children[1].textContent,'$83.25');
  assert.equal(legacy.children[1].className,'limit-meter');
  for (const limit of [null,undefined,0,-1,50]) {
    const [node] = render([{...credit,limit,creditsDisplay:'percent',usedPercent:42}],{native:true});
    assert.equal(node.children[0].children[1].textContent,'$83.25');
    assert.equal(node.children.length,2);
    assert.equal(node.children[1].textContent,'Expires 30d');
  }
  for (const [remaining,limit,headline,meter] of [[0,100,'0% left',true],[0,0,'$0.00',false]]) {
    const [node] = render([{...credit,remaining,limit,creditsDisplay:'percent'}],{native:true});
    assert.equal(node.children[0].children[1].textContent,headline);
    assert.equal(node.children.length,meter?3:2);
  }
  const [balance] = render([{...credit,creditsDisplay:'balance'}],{native:true,showLimitUsed:true});
  assert.equal(balance.children[0].children[1].textContent,'$83.25');
  assert.equal(balance.children.length,2);
});
test('mixed plugin quotas preserve repeated windows and render credits exactly once', () => {
  const windows = ['session', 'weekly', 'daily', 'billing', 'daily'].map((kind, index) => ({ kind, label: `Pool ${index}`, usedPercent: 20, remainingPercent: 80 }));
  windows.push({ kind: 'billing', label: 'Wallet', metric: 'credits', remaining: 60, limit: 100, currency: 'USD' });
  const nodes = render(windows);
  assert.deepEqual(Array.from(nodes, node => node.label), [...windows.map(window => window.label)]);
  assert.equal(nodes.filter(node => node.window.metric === 'credits').length, 1);
});
