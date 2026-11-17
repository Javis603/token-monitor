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
      assert.ok(Object.keys(source).every(key => ['id', 'kind', 'relation', 'labelKey', 'descriptionKey', 'getUrlFromForm'].includes(key)));
      if (source.getUrlFromForm) assert.ok(limitAccountFormsForRenderer().find(form => form.id === id)?.openUrl, id);
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);
});

test('headers derive exactly one connection tag regardless of reading state', () => {
  for (const id of LIMIT_PROVIDER_IDS) {
    const expression = app.slice(app.indexOf('    const tagInfos = pluginModule ?'), app.indexOf('    if (pluginModule) tagInfos.push'));
    const tags = vm.runInNewContext(expression + '\ntagInfos;', { pluginModule: null, limitProviderPresentationApi: presentation, provider: { provider: id }, provenance: null, id, state: { settings: { limitConnectionSources: limitConnectionSourcesForRenderer() } } });
    assert.equal(tags.length, 1);
    const tag = tags[0];
    assert.equal(tag.kind, 'capability');
    assert.ok(tag.parts.length);
    assert.equal(new Set(tag.parts).size, tag.parts.length);
    assert.doesNotMatch(tag.label, /Plan|Pay-as|Auto|Manual/);
  }
  const render = app.slice(app.indexOf('function renderLimitProviderCheckboxes('), app.indexOf('function limitProviderConnectionDetail('));
  assert.match(render, /limitProviderPresentationApi.connectionTag\(id,/);
  assert.ok(render.indexOf('optionsInner.append(limitProviderConnectionDetail') < render.indexOf('optionsInner.append(limitProviderSettingsList'));
});

function renderConnection(id, reading = {}, hasOpenControl = true) {
  const nodes = [];
  const document = { getElementById: () => hasOpenControl ? {} : null, createTextNode(textContent) { return { textContent }; }, createElement(tag) { const node = { tag, children: [], textContent: '', append(...children) { this.children.push(...children); }, setAttribute() {}, addEventListener(event, callback) { this[event] = callback; } }; nodes.push(node); return node; } };
  const source = app.slice(app.indexOf('function limitProviderConnectionDetail('), app.indexOf('// Single entry point for the provider options'));
  const opened = [];
  const form = limitAccountFormsForRenderer().find(entry => entry.id === id);
  const context = { LIMIT_PROVIDERS: [{ id, label: id === 'zed' ? 'Zed' : id }], document, t: (key, params) => translate('en', key, params), limitAccountForm: () => form,
    externalProviderForAccount: () => reading, limitAccountPanelsApi: require('../../src/electron/renderer/limits/accountPanels'),
    window: { TokenMonitorConnectionPresentation: require('../../src/electron/renderer/limits/connectionPresentation'), tokenMonitor: { openExternal: url => opened.push(url) } } };
  vm.runInNewContext(source + '\nthis.renderConnection = limitProviderConnectionDetail;', context);
  const panel = context.renderConnection(id, LIMIT_PROVIDER_ACCOUNTS.find(entry => entry.id === id).sources, reading);
  return { panel, nodes, opened };
}

test('alternative connection row uses existing provenance, never invents detection', () => {
  const { panel, nodes } = renderConnection('ollama', { source: 'api', status: 'ok' });
  assert.equal(panel.className, 'limit-provider-connection-sources');
  assert.ok(nodes.some(node => node.className === 'connection-source-card'));
  assert.ok(nodes.some(node => node.tag === 'details'));
  assert.ok(nodes.some(node => node.textContent === 'Currently using API key'));
  assert.equal(nodes.filter(node => node.className === 'settings-item-desc').length, 4);
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
  const expression = app.slice(app.indexOf('    const tagInfos = pluginModule ?'), app.indexOf('    if (pluginModule) tagInfos.push'));
  return vm.runInNewContext(expression + '\ntagInfos;', { pluginModule: null, limitProviderPresentationApi: presentation, provider, provenance: null, id: provider.provider, state: { settings: { limitConnectionSources: limitConnectionSourcesForRenderer() } } });
}

test('all provider headers retain state/action tags separately from the connection tag', () => {
  for (const id of LIMIT_PROVIDER_IDS) {
    for (const status of ['unauthorized', 'notConfigured', 'unavailable', 'rateLimited', 'sourceRateLimited', 'error', 'disabled', 'noSyncedData']) {
      const provider = { provider: id, status };
      assert.deepEqual(JSON.parse(JSON.stringify(headerTags(provider).filter(tag => tag.kind === 'status'))), presentation.limitProviderSettingsTags(provider).filter(tag => tag.kind === 'status'), `${id} ${status}`);
    }
  }
  for (const [id, label] of [['opencode', 'Sign in again'], ['cline', 'Open Cline']]) {
    const tags = { children: [], append(node) { this.children.push(node); } };
    const source = app.slice(app.indexOf('    const tagInfos = pluginModule ?'), app.indexOf('    copy.append(nameLine, tags);'));
    vm.runInNewContext(source, {
      pluginModule: null, provider: { provider: id, status: 'unauthorized', source: 'oauth' },
      provenance: null, id, isEnabled: true, accountGroup: {}, tags,
      state: { settings: { limitConnectionSources: limitConnectionSourcesForRenderer() } },
      limitProviderPresentationApi: presentation,
      document: { createElement: () => ({ classList: { add() {} } }) },
      translatedLimitProviderTag: tag => tag.label, translatedLimitCapabilityTag: label => label
    });
    assert.equal(tags.children.find(node => node.className.includes('tag-status'))?.textContent, label);
    assert.equal(tags.children.filter(node => node.className.includes('tag-capability')).length, 1);
  }
  assert.equal(headerTags({ provider: 'opencode', status: 'unauthorized' })[0].label, 'Sign in again');
  assert.equal(headerTags({ provider: 'cline', status: 'unauthorized', source: 'oauth' })[0].label, 'Open Cline');
  for (const provider of [{ provider: 'antigravity', status: 'error', actionRequired: 'accountVerification' }, { provider: 'workbuddy', status: 'error', actionRequired: 'appSessionEncrypted' }]) {
    assert.equal(headerTags(provider)[0].label, presentation.limitProviderStatusLabel(provider).label);
  }
});

test('Grok retains its automatic-detection right-side pill without duplicating account summaries', () => {
  const source = app.slice(app.indexOf('    // Multi-account providers use this space'), app.indexOf('    const settings = LIMIT_PROVIDER_SETTINGS[id];', app.indexOf('    // Multi-account providers use this space')));
  const render = (accountGroup) => {
    const actions = { children: [], append(node) { this.children.push(node); } };
    vm.runInNewContext(source, { accountGroup, sources: LIMIT_PROVIDER_ACCOUNTS.find(entry => entry.id === 'grok').sources, document: { createElement: () => ({}) }, t: key => translate('zh-TW', key), actions });
    return actions.children;
  };
  assert.equal(render(null)[0]?.textContent, '自動偵測');
  assert.equal(render({}).length, 0);
});

test('connection get link remains available outside the account editor', () => {
  assert.equal(renderConnection('zed').nodes.filter(node => node.tag === 'button').length, 1);
  assert.equal(renderConnection('zed', {}, false).nodes.filter(node => node.tag === 'button').length, 1);
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
  assert.equal(entry.accountSlots, undefined);
});


test('manual API card keeps optional Web complement instructions in its disclosure', () => {
  const { nodes } = renderConnection('deepseek', { source: 'web', status: 'ok' });
  assert.equal(nodes.find(n => n.className === 'connection-source-method').textContent, 'API key');
  assert.ok(nodes.some(n => n.textContent === 'Paste an API key'));
  const details = nodes.find(n => n.tag === 'details');
  assert.ok(details.children.some(n => n.textContent.includes(translate('en', 'settings.deepseek.webTokenNote'))));
  assert.ok(!nodes.some(n => /Currently using/.test(n.textContent)));
});

test('sourceDetail takes precedence and stale/failed readings never claim a current lane', () => {
  const ok = renderConnection('codex', { source: 'rpc', sourceDetail: 'app', status: 'ok' });
  assert.ok(ok.nodes.some(n => n.textContent === 'Currently using Desktop app'));
  for (const reading of [{source:'oauth',status:'ok',stale:true}, {source:'oauth',status:'error'}]) {
    assert.ok(!renderConnection('codex', reading).nodes.some(n => /Currently using/.test(n.textContent)));
  }
  for (const id of ['cline','factory','opencode','volcengine']) {
    assert.equal(renderConnection(id).nodes.find(n => n.className === 'connection-source-method').textContent, 'Auto detect');
  }
});
