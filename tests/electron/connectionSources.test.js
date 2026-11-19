'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { LIMIT_PROVIDER_ACCOUNTS } = require('../../src/shared/limits/accounts');
const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');
const { MESSAGES, translate } = require('../../src/electron/renderer/i18n');
const presentation = require('../../src/electron/renderer/limits/providerPresentation');
const { limitConnectionSourcesForRenderer, limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
const app = fs.readFileSync('src/electron/renderer/app.js', 'utf8');

test('every provider declares ordered, localized display sources without credentials or copied URLs', () => {
  const projected = limitConnectionSourcesForRenderer();
  assert.deepEqual(projected.map(entry => entry.id), LIMIT_PROVIDER_IDS);
  for (const { id, sources } of LIMIT_PROVIDER_ACCOUNTS) {
    assert.ok(sources.length, id);
    assert.equal(new Set(sources.map(source => source.id)).size, sources.length, id);
    for (const source of sources) {
      assert.match(source.id, /^[a-z][a-z0-9-]*$/);
      assert.ok(['cli', 'desktop', 'web', 'apiKey', 'env', 'file', 'oauth'].includes(source.kind), id);
      assert.ok(['alternative', 'complement', 'single'].includes(source.relation), id);
      assert.equal(source.relation === 'single', sources.length === 1, id);
      for (const locale of Object.keys(MESSAGES)) {
        assert.ok(MESSAGES[locale][source.labelKey], `${id} ${locale} label`);
        assert.ok(MESSAGES[locale][source.descriptionKey], `${id} ${locale} description`);
      }
      if (source.products) assert.ok(source.products.every(product => typeof product === 'string' && product.length > 0));
      assert.ok(Object.keys(source).every(key => ['id', 'kind', 'relation', 'labelKey', 'descriptionKey', 'getUrlFromForm', 'products'].includes(key)));
      if (source.getUrlFromForm) assert.ok(limitAccountFormsForRenderer().find(form => form.id === id)?.openUrl, id);
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);
});

test('provider headers omit connection capabilities while expanded options keep the connection card', () => {
  for (const id of LIMIT_PROVIDER_IDS) {
    assert.equal(headerTags({ provider: id, status: 'ok' }).some(tag => tag.kind === 'capability'), false, id);
  }
  const render = app.slice(app.indexOf('function renderLimitProviderCheckboxes('), app.indexOf('function limitProviderConnectionDetail('));
  assert.ok(render.indexOf('optionsInner.append(limitProviderConnectionDetail') < render.indexOf('optionsInner.append(settingsList)'));
});

function renderConnection(id, reading = {}, hasOpenControl = true, preference = 'auto', editorUrl) {
  const nodes = [];
  const document = { getElementById: () => hasOpenControl ? {} : null, createTextNode(textContent) { return { textContent }; }, createElement(tag) { const node = { tag, children: [], dataset: {}, textContent: '', append(...children) { this.children.push(...children); }, setAttribute() {}, addEventListener(event, callback) { this[event] = callback; } }; nodes.push(node); return node; } };
  const source = app.slice(app.indexOf('function limitProviderConnectionDetail('), app.indexOf('// Single entry point for the provider options'));
  const opened = [];
  const form = limitAccountFormsForRenderer().find(entry => entry.id === id);
  const state = { settings: { limitConnectionSources: limitConnectionSourcesForRenderer(), [`${id}SourcePreference`]: preference } };
  const saves = [];
  const context = { state, accountSlotPanels: new Map([[id, { activeEditorUrl: () => editorUrl }]]), saveSettings: async patch => { saves.push(patch); Object.assign(state.settings, patch); }, LIMIT_PROVIDERS: [{ id, label: id === 'zed' ? 'Zed' : id }], document, t: (key, params) => translate('en', key, params), limitAccountForm: () => form,
    externalProviderForAccount: () => reading, limitAccountPanelsApi: require('../../src/electron/renderer/limits/accountPanels'),
    window: { TokenMonitorConnectionPresentation: require('../../src/electron/renderer/limits/connectionPresentation'), tokenMonitor: { openExternal: url => opened.push(url) } } };
  vm.runInNewContext(source + '\nthis.renderConnection = limitProviderConnectionDetail;', context);
  const panel = context.renderConnection(id, LIMIT_PROVIDER_ACCOUNTS.find(entry => entry.id === id).sources, reading);
  return { panel, nodes, opened, saves, state };
}

test('alternative connection row uses existing provenance, never invents detection', () => {
  const { panel, nodes } = renderConnection('ollama', { source: 'api', status: 'ok' });
  assert.equal(panel.className, 'limit-provider-connection-sources');
  assert.ok(nodes.some(node => node.className === 'connection-source-card'));
  assert.ok(!nodes.some(node => node.tag === 'details'));
  assert.ok(nodes.some(node => node.tag === 'option' && node.value === 'auto' && node.textContent === 'Auto · API key'));
  assert.equal(nodes.filter(node => node.className === 'settings-item-desc').length,
    2, 'only the summary and save-status line remain outside the menu');
  const unknown = renderConnection('ollama', { source: 'api', status: 'unavailable' });
  assert.ok(unknown.nodes.some(node => node.textContent === 'Auto · try sources in order'));
  assert.ok(!unknown.nodes.some(node => /currently using|not detected/i.test(node.textContent)));
});

test('single connection row reuses the form URL and existing link style', () => {
  const { nodes, opened } = renderConnection('zed', {}, false);
  const link = nodes.find(node => node.tag === 'button');
  assert.equal(link.className, 'inline-link connection-source-get');
  assert.equal(link.children[0].textContent, 'Get from Zed');
  assert.equal(link.children[1].tag, 'span');
  link.click();
  assert.deepEqual(opened, ['https://dashboard.zed.dev/']);
});

test('retired provider tag and connection tables stay unused', () => {
  const presentation = fs.readFileSync('src/electron/renderer/limits/providerPresentation.js', 'utf8');
  for (const name of ['CAPABILITY_TAGS', 'PROVIDER_SOURCE_LABELS', 'LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS']) {
    assert.ok(!app.includes(name) && !presentation.includes(name), name);
  }
});

function headerTags(provider) {
  const expression = app.slice(app.indexOf('    const tagInfos = pluginModule'), app.indexOf('    if (pluginModule) tagInfos.push'));
  return vm.runInNewContext(expression + '\ntagInfos;', { pluginModule: null, limitProviderPresentationApi: presentation, provider, provenance: null, id: provider.provider, state: { settings: { limitConnectionSources: limitConnectionSourcesForRenderer() } } });
}

test('provider headers retain state and action tags without connection capability tags', () => {
  for (const id of LIMIT_PROVIDER_IDS) {
    for (const status of ['unauthorized', 'notConfigured', 'unavailable', 'rateLimited', 'sourceRateLimited', 'error', 'disabled', 'noSyncedData']) {
      const provider = { provider: id, status };
      assert.deepEqual(JSON.parse(JSON.stringify(headerTags(provider).filter(tag => tag.kind === 'status'))), presentation.limitProviderSettingsTags(provider).filter(tag => tag.kind === 'status'), `${id} ${status}`);
    }
  }
  for (const [id, label] of [['opencode', 'Sign in again'], ['cline', 'Open Cline']]) {
    const tags = { children: [], append(node) { this.children.push(node); }, querySelector(selector) {
      return this.children.find(node => node.className.includes(selector.slice(1))) || null;
    } };
    const row = { classes: new Set(), classList: { toggle(name, on) { if (on) row.classes.add(name); else row.classes.delete(name); } } };
    const source = app.slice(app.indexOf('    const tagInfos = pluginModule'), app.indexOf('    copy.append(nameLine);'));
    vm.runInNewContext(source, {
      pluginModule: null, provider: { provider: id, status: 'unauthorized', source: 'oauth' },
      provenance: null, id, isEnabled: true, accountGroup: {}, actions: tags, row,
      state: { settings: { limitConnectionSources: limitConnectionSourcesForRenderer() } },
      limitProviderPresentationApi: presentation,
      document: { createElement: () => ({ classList: { add() {} } }) },
      translatedLimitProviderTag: tag => tag.label, translatedLimitCapabilityTag: label => label
    });
    assert.equal(tags.children.find(node => node.className.includes('tag-status'))?.textContent, label);
    assert.equal(tags.children.filter(node => node.className.includes('tag-capability')).length, 0);
    // An action-needed status speaks for the row; the account summary is hidden.
    assert.equal(row.classes.has('has-status-tag'), true);
  }
  assert.equal(headerTags({ provider: 'opencode', status: 'unauthorized' })[0].label, 'Sign in again');
  assert.equal(headerTags({ provider: 'cline', status: 'unauthorized', source: 'oauth' })[0].label, 'Open Cline');
  for (const provider of [{ provider: 'antigravity', status: 'error', actionRequired: 'accountVerification' }, { provider: 'workbuddy', status: 'error', actionRequired: 'appSessionEncrypted' }]) {
    assert.equal(headerTags(provider)[0].label, presentation.limitProviderStatusLabel(provider).label);
  }
});

test('Grok shows the selected collection source without duplicating account summaries', () => {
  const source = app.slice(app.indexOf('    // Multi-account providers use this space'), app.indexOf('    const settings = LIMIT_PROVIDER_SETTINGS[id];', app.indexOf('    // Multi-account providers use this space')));
  const render = (accountGroup, preference = 'auto', isEnabled = true) => {
    const actions = { children: [], append(node) { this.children.push(node); } };
    vm.runInNewContext(source, { accountGroup, isEnabled, id: 'grok', state: { settings: { grokSourcePreference: preference } }, sources: LIMIT_PROVIDER_ACCOUNTS.find(entry => entry.id === 'grok').sources, document: { createElement: () => ({}) }, t: key => translate('zh-TW', key), actions });
    return actions.children;
  };
  assert.equal(render(null)[0]?.textContent, '自動偵測');
  const web = LIMIT_PROVIDER_ACCOUNTS.find(entry => entry.id === 'grok').sources.find(source => source.id === 'web');
  assert.equal(render(null, 'web')[0]?.textContent, translate('zh-TW', web.labelKey));
  assert.equal(render({}).length, 0);
  // A disabled provider's row carries no status; the switch says it all.
  assert.equal(render(null, 'auto', false).length, 0);
});

test('Alibaba connection link follows the open account editor', () => {
  const url = 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan/personal';
  const rendered = renderConnection('alibaba', {}, true, 'auto', url);
  rendered.nodes.find(node => node.className === 'inline-link connection-source-get').click();
  assert.deepEqual(rendered.opened, [url]);
});

test('connection get link remains available outside the account editor', () => {
  assert.equal(renderConnection('zed').nodes.filter(node => node.tag === 'button').length, 1);
  assert.equal(renderConnection('zed', {}, false).nodes.filter(node => node.tag === 'button').length, 1);
});

test('connection cards keep manual setup links and leave optional Claude Web setup to the account editor', () => {
  const getLink = id => renderConnection(id).nodes.find(node => node.className === 'inline-link connection-source-get');
  assert.equal(getLink('claude'), undefined);
  assert.ok(getLink('deepseek'));
  assert.ok(getLink('commandcode'));
  assert.ok(getLink('muse'));
  assert.ok(getLink('volcengine'));
});

test('all seven locales explain ordered fallback when the current source is unknown', () => {
  const expected = ['Auto · try sources in order', '自動 · 依序嘗試來源', '自动 · 按顺序尝试来源', '자동 · 소스를 순서대로 시도', '自動 · ソースを順番に試行', 'Automático · probar fuentes en orden', 'Automático · tentar fontes em ordem'];
  assert.deepEqual(Object.keys(MESSAGES).map(locale => translate(locale, 'settings.limits.sources.auto')), expected);
  const { nodes } = renderConnection('ollama');
  assert.ok(nodes.some(node => node.textContent === expected[0]));
});

test('Alibaba displays main CLI-first Cookie fallback without changing its dispatch', () => {
  const entry = require('../../src/shared/limits/registry').limitProviderEntry('alibaba');
  assert.deepEqual(entry.sources.map(({ id, relation }) => [id, relation]), [['cli', 'alternative'], ['web', 'alternative']]);
  assert.equal(entry.fetch, 'fetchAlibabaLimits');
  assert.ok(entry.accountSlots, 'Alibaba exposes the shared credential account editor');
});


test('manual API card omits the redundant disclosure and retains the credential setup form', () => {
  const { nodes } = renderConnection('deepseek', { source: 'web', status: 'ok' });
  assert.ok(!nodes.some(n => n.className === 'connection-source-method'));
  assert.equal(nodes.find(n => n.className === 'settings-item-desc').textContent, 'Paste an API key');
  assert.ok(!nodes.some(n => n.tag === 'details'));
  assert.ok(JSON.stringify(limitAccountFormsForRenderer().find(entry => entry.id === 'deepseek')).includes('settings.deepseek.webTokenNote'));
  assert.ok(!nodes.some(n => /Currently using/.test(n.textContent)));
});

test('sourceDetail takes precedence and stale/failed readings never claim a current lane', () => {
  const ok = renderConnection('codex', { source: 'rpc', sourceDetail: 'app', status: 'ok' });
  assert.ok(ok.nodes.some(n => n.tag === 'option' && n.value === 'auto' && n.textContent === 'Auto · Desktop app'));
  for (const reading of [{source:'oauth',status:'ok',stale:true}, {source:'oauth',status:'error'}]) {
    assert.equal(renderConnection('codex', reading).nodes.find(n => n.tag === 'option' && n.value === 'auto').textContent, 'Auto detect');
  }
  for (const id of ['cline','factory','opencode','volcengine']) {
    const method = renderConnection(id).nodes.find(n => n.className.split(' ').includes('connection-source-method'));
    assert.equal(method.tag === 'select' ? method.children[0].textContent : method.textContent, id === 'factory' ? 'Auto + manual' : 'Auto detect');
  }
});

for (const locale of Object.keys(MESSAGES)) {
  test(`${locale} translates every declared source selection option`, () => {
    for (const entry of limitConnectionSourcesForRenderer().filter(entry => entry.sourceSelection)) {
      for (const key of ['settings.limits.connection.title', 'settings.limits.connection.autoDetect', 'settings.limits.sources.saveFailed']) assert.ok(MESSAGES[locale][key], `${locale} ${key}`);
      const card = require('../../src/electron/renderer/limits/connectionPresentation').createConnectionCard({
        document: require('./accountOwnerDom.fixture.cjs').createDocument(),
        t: (key, params) => translate(locale, key, params), sources: entry.sources, provider: {}, label: entry.id,
        selection: entry.sourceSelection, onSelect: async () => 'auto'
      });
      const select = [...card.walk()].find(n => n.tagName === 'select');
      assert.deepEqual(select.children.map(n => n.value), ['auto', ...entry.sources.filter(s => entry.sourceSelection.sources.includes(s.id) && s.relation === 'alternative').map(s => s.id)]);
      for (const option of select.children) {
        assert.ok(option.textContent && !option.textContent.startsWith('settings.'), `${entry.id} ${option.value}`);
        const description = option.dataset.tmSelectDescription ?? translate(locale, option.dataset.selectDescription);
        assert.ok(description && !description.startsWith('settings.'), `${entry.id} ${option.value} description`);
      }
      assert.ok(![...card.walk()].some(node => node.tagName === 'details'));
    }
  });
}
test('Claude source selection saves the declared preference and restores its control', async () => {
  const h = renderConnection('claude', {}, true, 'cli');
  const select = h.nodes.find(n => n.tag === 'select');
  assert.deepEqual(select.children.map(n => n.value), ['auto', 'oauth', 'cli']);
  assert.equal(select.value, 'cli');
  select.value = 'oauth';
  const saving = select.change();
  assert.equal(select.disabled, true);
  await saving;
  assert.deepEqual(JSON.parse(JSON.stringify(h.saves)), [{ claudeSourcePreference: 'oauth' }]);
  assert.equal(select.disabled, false);
  assert.equal(select.value, 'oauth');
});

test('a rejected source preference restores the accepted selection and localized error', async () => {
  const document = require('./accountOwnerDom.fixture.cjs').createDocument();
  const entry = limitConnectionSourcesForRenderer().find(entry => entry.id === 'claude');
  const card = require('../../src/electron/renderer/limits/connectionPresentation').createConnectionCard({
    document, t: (key, params) => translate('zh-TW', key, params), sources: entry.sources,
    selection: entry.sourceSelection, preference: 'cli', provider: {}, label: 'Claude',
    onSelect: async () => { throw new Error('IPC failed'); }
  });
  const select = [...card.walk()].find(n => n.tagName === 'select');
  select.value = 'oauth';
  await select.listeners.change();
  assert.equal(select.value, 'cli');
  assert.equal(select.disabled, false);
  assert.ok(card.textContent.includes(translate('zh-TW', 'settings.limits.sources.saveFailed')));
});

for (const id of ['antigravity', 'workbuddy']) test(`${id} describes complementary manual and detected connections without a selector`, () => {
  const { nodes } = renderConnection(id);
  const entry = limitConnectionSourcesForRenderer().find(entry => entry.id === id);
  const method = nodes.find(node => node.className === 'connection-source-method');
  assert.equal(method.textContent, 'Auto + manual');
  assert.ok(!nodes.some(node => node.tag === 'select'));
  const summary = nodes.find(node => node.className === 'settings-item-desc');
  for (const source of entry.sources) assert.ok(!summary.textContent.includes(translate('en', source.descriptionKey)), source.id);
});


test('selectable connection cards keep descriptions in the menu instead of repeating them in the summary', () => {
  const { nodes } = renderConnection('claude');
  const entry = limitConnectionSourcesForRenderer().find(entry => entry.id === 'claude');
  const summary = nodes.find(node => node.className === 'settings-item-desc');
  for (const source of entry.sources) assert.ok(!summary.textContent.includes(translate('en', source.descriptionKey)));
  assert.ok(!summary.textContent.includes(translate('en', entry.sources.find(source => source.relation === 'complement').labelKey)), 'complementary Web detail stays in the source menu');
  const select = nodes.find(node => node.tag === 'select');
  assert.ok(select.children[0].dataset.tmSelectDescription.includes(translate('en', entry.sources.find(source => source.relation === 'complement').descriptionKey)));
});


test('Cursor offers three collection modes using compact menu descriptions', () => {
  const { nodes } = renderConnection('cursor');
  const select = nodes.find(node => node.tag === 'select');
  assert.deepEqual(select.children.map(option => option.value), ['auto', 'desktop', 'web']);
  assert.equal(select.children[0].textContent, 'Auto + manual');
  assert.ok(select.children[0].dataset.tmSelectDescription.includes('desktop'));
  assert.equal(select.children[1].dataset.selectDescription, 'settings.cursor.sources.desktopDescription');
  assert.equal(select.children[2].dataset.selectDescription, 'settings.cursor.sources.webDescription');
});
