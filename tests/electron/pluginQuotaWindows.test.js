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
function render(windows, { showLimitUsed = false, native = false, details = false, notes } = {}) {
  const context = vm.createContext({
    document: { createElement: tag => new Element(tag) },
    presentationApi: require('../../src/electron/renderer/limits/providerPresentation'),
    t: (key, params) => require('../../src/electron/renderer/i18n').translate('en', key, params),
    settings: () => ({ showLimitUsed }), usageItems: { hiddenUsageItemSet: () => new Set(), limitUsageItemId: () => 'credits' }, hideUsageItems() {},
    ...balance,
    windowForKind: (provider, kind) => provider.windows.find(window => window.kind === kind),
    windowsForKind: (provider, kind) => provider.windows.filter(window => window.kind === kind),
    providerWindowLabel: (provider, window, fallback) => limitWindowLabel(provider.provider, window, fallback),
    limitDetailInfoNode: () => null,
    limitWindowNode: (label, window) => Object.assign(new Element(), { label, window }),
    motion: { remainingPercent: window => window.remainingPercent, displayPercent: value => value, windowKey: label => label },
    ...require('../../src/electron/renderer/limits/displayMode'),
    formatPercent: value => `${Math.round(value)}%`, formatLimitBoundary: window => window.boundaryKind === 'expiry' ? 'Expires 30d' : 'Reset 30d',
    colorWithAlpha: value => value, applyBarScale: (node, value) => { node.scale = value; }, tagUsageItem: node => node,
    provider: normalizeReading({ status: 'ok', windows, notes }, 'plugin:fixture:quota')
  });
  if (details) {
    Object.assign(context, { tooltipHost: { hasOpened: () => false }, attachLimitDetailTooltip: () => {} });
    vm.runInContext(['detailTooltipNode', 'limitDetailInfoNode', 'limitNoteRowNode'].map(extract).join('\n'), context);
  }
  if (native) vm.runInContext(['limitMeterNode', 'formatLimitWindowValue', 'limitWindowNode'].map(extract).join('\n'), context);
  vm.runInContext(['quotaDetailEntries', 'genericCreditWindowNode', 'positionPluginQuotaInfo', 'pluginQuotaWindowNode', 'repairWindowPairs', 'renderProviderWindows'].map(extract).join('\n'), context);
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


test('plugin window spans keep input order across money and percentage windows', () => {
  const mixed = [
    {kind:'session',label:'First',usedPercent:10,span:1},
    {...credit,label:'Second',span:1},
    {kind:'weekly',label:'Third',usedPercent:20,span:2},
    {...credit,label:'Fourth',span:1}
  ];
  const nodes = render(mixed);
  assert.deepEqual(Array.from(nodes,node=>node.label),['First','Second','Third','Fourth']);
  assert.deepEqual(Array.from(nodes,node=>node.classList.contains('limit-window-wide')),[false,false,true,false]);
  assert.equal(nodes[3].dataset.limitSpan,'1','explicit half width survives odd-run repair');
});
test('window and note details share native tooltip cells and money formatting', () => {
  const infoRows=[{label:'Today',value:{amount:1.25,currency:'USD'}},{label:'Scope',value:'<b>plain text</b>'}];
  const nodes=render([{...credit,infoRows}],{native:true,details:true,notes:[{label:'Spend',value:{amount:4,currency:'USD'},infoRows}]});
  assert.equal(nodes.length,2);
  for (const node of nodes) {
    const trigger=node.querySelector('.limit-detail-tooltip-trigger');
    assert.equal(trigger.tabIndex,0);
    assert.equal(trigger.getAttribute('aria-label'),'Today: $1.25, Scope: <b>plain text</b>');
    assert.equal(node.querySelectorAll('.limit-detail-tooltip-row').length,2);
    assert.equal(node.querySelector('b'),null,'author strings are text, not markup');
  }
  assert.equal(nodes[0].querySelector('.limit-detail-tooltip').classList.contains('is-centered'),true,'window tooltip uses native viewport clamping');
  assert.equal(nodes[1].querySelector('.limit-detail-tooltip').classList.contains('is-centered'),true,'note tooltip also uses native viewport clamping');
  assert.equal(nodes[1].querySelector('.limit-spend-summary').textContent,'$4.00');
});
test('detail DTO limits reject malformed shapes and never enter shared windows', () => {
  const row={label:'Today',value:{amount:0,currency:'USD'}};
  const make=window=>normalizeReading({status:'ok',windows:[{...credit,...window}]},'plugin:fixture:quota');
  const value=make({span:1,infoRows:[row]});
  assert.deepEqual(value.windows[0].infoRows,[row]);
  const shared=require('../../src/shared/limits/core').normalizeLimitWindow(value.windows[0]);
  assert.equal(shared.span,undefined);assert.equal(shared.infoRows,undefined);
  for (const patch of [{span:0},{span:3},{span:'1'},{infoRows:{}},{infoRows:[...Array(13)].map(()=>row)},{infoRows:[{label:'x',value:{amount:Infinity,currency:'USD'}}]},{infoRows:[{label:'x',value:{amount:1,currency:'usd'}}]},{infoRows:[{label:'x',value:{html:'x'}}]},{infoRows:[{label:'x'.repeat(81),value:'x'}]},{infoRows:[{label:'x',value:'x'.repeat(161)}]},{infoRows:[{label:'\u202e',value:'x'}]}]) assert.throws(()=>make(patch));
  for (const notes of [{},Array(9).fill({label:'Note'}),[{label:'Note',value:null}]]) assert.throws(()=>normalizeReading({status:'ok',windows:[],notes},'plugin:fixture:quota'));
  const notes=[{label:'Partial details',infoRows:[row]}];
  assert.deepEqual(normalizeReading({status:'ok',windows:[],notes},'plugin:fixture:quota').notes,notes);
});


test('percent credit detail remains visible without an expiry/reset date', () => {
  const [node]=render([{...credit,resetsAt:null,creditsDisplay:'percent'}],{native:true});
  assert.equal(node.classList.contains('limit-window-no-reset'),false);
  assert.equal(node.children[2].children[0].textContent,'');
  assert.equal(node.children[2].children[1].textContent,'$83.25 / $100.00');
});


test('default percentage windows pair and expand an odd trailing window', () => {
  const nodes=render(['session','weekly','daily'].map(kind=>({kind,usedPercent:10})),{native:true});
  assert.deepEqual(Array.from(nodes,node=>node.classList.contains('limit-window-wide')),[false,false,true]);
});
