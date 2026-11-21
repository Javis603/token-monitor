'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { rendererStyles } = require('../helpers/rendererStyles');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { LIMIT_PROVIDER_LABELS } = require('../../src/shared/limits/providers');

function limitsViewSource() {
  return read('src/electron/renderer/limits/windowsView.js') + '\n' + read('src/electron/renderer/providers/openrouter/windows.js');
}

test('OpenRouter uses a single secret form and the shared slot panel', () => {
  const { limitAccountFormsForRenderer, accountFieldProjection } = require('../../src/electron/limits/accountSettings');
  const form = limitAccountFormsForRenderer().find(form => form.id === 'openrouter');
  assert.equal(form.accountSlots, true);
  assert.deepEqual(form.fields.map(field => [field.key, field.secret]), [['openrouterApiKey', true]]);
  assert.ok(!JSON.stringify(form).includes('storePath'));
  assert.doesNotMatch(read('src/electron/renderer/index.html'), /id="openrouterProfileName"/);
  assert.doesNotMatch(read('src/electron/renderer/app.js'), /renderOpenRouterProfiles/);
  const projection = accountFieldProjection({ openrouterApiKey: 'private', openrouterProfiles: { work: { apiKey: 'private' } } });
  assert.ok(!JSON.stringify(projection).includes('private'));
});

test('OpenRouter Limits presentation shows a real balance meter and compact spend tooltip', () => {
  const app = read('src/electron/renderer/app.js');
  const presentation = require('../../src/electron/renderer/limits/providerPresentation').connectionTag('openrouter');
  const styles = rendererStyles();
  const { clientColors } = require('../../src/electron/renderer/usageCharts');

  assert.equal(LIMIT_PROVIDER_LABELS.openrouter, 'OpenRouter');
  assert.match(read('src/electron/renderer/limits/windowOwners.js'), /openrouter: require\('\.\.\/providers\/openrouter\/windows'\)/);
  // Several OpenRouter keys render as the shared group, by account count rather
  // than by a wrapper of their own — the same dispatch the dock card uses.
  assert.match(app, /nodes\.push\(renderLimitProviderGroup\(id, label, visibleProviders, color\)\)/);
  assert.match(limitsViewSource(), /function providerSpendEntries\(balance\)/);
  assert.match(limitsViewSource(), /\['Week', optionalFiniteNumber\(balance\?\.weekSpend\)\]/);
  assert.match(limitsViewSource(), /\['All time', optionalFiniteNumber\(balance\?\.allTimeSpend\)\]/);
  assert.match(limitsViewSource(), /summaryNode\.className = 'limit-spend-summary'/);
  assert.match(limitsViewSource(), /function limitDetailInfoNode\(entries, extraClass = '', ariaLabel = ''\)/);
  assert.match(limitsViewSource(), /function limitNoteRowNode\(\{ label, summary = '', detailEntries = null, ariaParts = \[\] \}\)/);
  assert.match(limitsViewSource(), /tooltip\.className = \['limit-detail-tooltip', columns > 2 \? 'limit-detail-tooltip-triple' : ''\]/);
  assert.match(limitsViewSource(), /info\.tabIndex = 0/);
  // The tooltip's render-hold is page state, so the shared view calls back into
  // it rather than reaching for it: the handler stays wired here, and every
  // tooltip — spend, third-party, forecast — is opened and released by the one
  // attacher rather than by a per-row copy.
  assert.match(limitsViewSource(), /function attachLimitDetailTooltip\(wrap, tooltip\)[\s\S]*?const close = \(\) => \{[\s\S]*?tooltipHost\.release\(\);/);
  assert.match(limitsViewSource(), /entries\.map\(\(\[entryLabel, value\]\) => \[entryLabel, formatBalanceSpendAmount\(value, balance\)\]\)/);
  assert.match(limitsViewSource(), /const spendNode = providerSpendNode\(balance\)/);
  assert.match(limitsViewSource(), /function openrouterCreditsWindow\(provider\)/);
  assert.match(limitsViewSource(), /windows\.find\([^\n]*?\(window\) => window\?\.metric === 'credits'\)/);
  assert.match(limitsViewSource(), /windows\.find\([^\n]*?\(window\) => !window\?\.metric && window\?\.label === 'Credits'\)/);
  assert.match(limitsViewSource(), /const creditsWindow = openrouterCreditsWindow\(provider\)/);
  assert.match(limitsViewSource(), /limitWindowNode\(\s*'Balance',\s*\{ \.\.\.balanceWindow, label: 'Balance' \}/);
  assert.match(limitsViewSource(), /\.filter\([^\n]*?\(window\) => window !== creditsWindow\)/);
  assert.match(limitsViewSource(), /const hasMeter = quotaWindow\?\.showMeter !== false/);
  assert.match(limitsViewSource(), /const valueOverride = hasMeter \? null : \(quotaWindow\?\.detail \|\| '—'\)/);
  assert.deepEqual(presentation.parts, ['API key']);
  assert.match(styles, /^\.row-icon-openrouter/m);
  assert.match(styles, /\.limit-spend-summary\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  assert.equal(clientColors.openrouter, '#6566F1');
});

test('OpenRouter credits lookup keeps the mixed-version label fallback', () => {
  const { openrouterCreditsWindow } = require('../../src/electron/renderer/providers/openrouter/windows')({});
  const findCredits = (windows) => openrouterCreditsWindow({ windows });
  const legacyCredits = { kind: 'billing', label: 'Credits', remaining: 4 };
  const metricCredits = { kind: 'billing', metric: 'credits', label: 'Account credit', remaining: 8 };

  assert.equal(findCredits([legacyCredits, metricCredits]).metric, 'credits');
  assert.equal(findCredits([legacyCredits]).label, 'Credits');
  assert.equal(findCredits([{ ...legacyCredits, metric: 'quota' }]), null);
});

test('OpenRouter is documented with its supplied icon in every supported-tools table', () => {
  const row = /\.github\/assets\/tools-icon\/openrouter\.png" width="28" alt="OpenRouter" \/> \| OpenRouter \| OpenRouter API/;
  for (const file of ['README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md']) {
    assert.match(read(file), row, file);
  }
  assert.equal(fs.existsSync(path.join(root, '.github/assets/tools-icon/openrouter.png')), true);
  assert.equal(fs.existsSync(path.join(root, 'assets/icons/openrouter.svg')), true);
});

test('OpenRouter settings status uses collision-free row identity and a stable env account name', () => {
  const document = require('./accountOwnerDom.fixture.cjs').createDocument();
  const { createPanel } = require('../../src/electron/renderer/limits/accountSlotsPanel');
  const { translate } = require('../../src/electron/renderer/i18n');
  const panel = createPanel({ form: { id: 'openrouter', fields: [{ key: 'openrouterApiKey' }] },
    label: 'OpenRouter', document, t: (key, params) => translate('en', key, params), ipc: {}, forms: {},
    preserveScroll: fn => fn(), onChanged() {}, openExternal() {} });
  const accounts = [
    { id: 'environment', source: 'environment', enabled: true, accountName: 'Environment', accountKey: 'env' },
    { id: 'default (env)', enabled: true, accountName: 'default (env)', accountKey: 'saved' }
  ];
  panel.update(accounts, [{ accountKey: 'env', status: 'ok' }, { accountKey: 'saved', status: 'unauthorized' }], { settings: {} });
  const rows = [...panel.element.walk()].filter(node => node.dataset.slotId);
  assert.deepEqual(rows.map(row => row.dataset.slotId), ['environment', 'default (env)']);
  assert.match(rows[0].querySelector('.slot-status').textContent, /Connected/);
  assert.match(rows[1].querySelector('.slot-status').textContent, /API key expired/);
  assert.equal(rows[0].querySelector('.slot-name').textContent, 'Environment');
  assert.equal(rows[1].querySelector('.slot-name').textContent, 'default (env)');
  assert.match(limitsViewSource(), /function namedApiAccountTitle/);
});

test('OpenRouter key page is narrowly allowlisted', () => {
  const main = read('src/electron/main.js');
  assert.match(main, /limitProviderUrlAllowed\(parsed\.hostname, parsed\.pathname\)/);
  const { limitProviderUrlAllowed } = require('../../src/shared/limits/accounts');
  assert.equal(limitProviderUrlAllowed('openrouter.ai', '/settings/keys'), true);
  assert.equal(limitProviderUrlAllowed('openrouter.ai', '/settings'), false);
});
