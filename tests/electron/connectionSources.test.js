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
      assert.ok(Object.keys(source).every(key => ['id', 'kind', 'relation', 'labelKey', 'descriptionKey', 'products'].includes(key)));
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

function renderConnection(id, readings = [], rowLanes = new Set()) {
  const nodes = [];
  const document = { getElementById: () => null, createTextNode(textContent) { return { textContent }; }, createElement(tag) { const node = { tag, children: [], dataset: {}, attributes: {}, textContent: '', append(...children) { this.children.push(...children); }, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(event, callback) { this[event] = callback; } }; nodes.push(node); return node; } };
  const source = app.slice(app.indexOf('function limitProviderConnectionDetail('), app.indexOf('// Single entry point for the provider options'));
  const opened = [];
  const state = { settings: { limitConnectionSources: limitConnectionSourcesForRenderer() } };
  const context = { state, document, t: (key, params) => translate('en', key, params),
    window: { TokenMonitorConnectionPresentation: require('../../src/electron/renderer/limits/connectionPresentation'), TokenMonitorAccountSlotsPanel: { liveSourceIds: () => rowLanes, onLiveSourcesChange() {} }, tokenMonitor: { openExternal: url => opened.push(url) } } };
  vm.runInNewContext(source + '\nthis.renderConnection = limitProviderConnectionDetail;', context);
  const panel = context.renderConnection(id, LIMIT_PROVIDER_ACCOUNTS.find(entry => entry.id === id).sources, readings);
  const list = nodes.find(node => node.className.split(' ').includes('connection-source-list'));
  const items = nodes.filter(node => node.className.split(' ').includes('connection-source-item'));
  return { panel, nodes, opened, list, items,
    names: items.map(item => item.children.find(child => child.className === 'connection-source-name')?.textContent || null),
    live: items.filter(item => item.className.includes('is-live')).map(item => item.dataset.kind),
    joints: nodes.filter(node => node.className === 'connection-source-joint').map(node => node.textContent),
    summary: nodes.find(node => node.className === 'settings-item-desc')?.textContent };
}

test('connection cards never offer a source choice', () => {
  for (const { id } of LIMIT_PROVIDER_ACCOUNTS) {
    const { nodes } = renderConnection(id, [{ status: 'ok', source: 'oauth' }]);
    assert.ok(!nodes.some(node => ['select', 'option', 'details'].includes(node.tag)), id);
  }
});

test('a fresh reading names its lane; the other sources shrink to icons but stay in the accessible label', () => {
  const { live, names, list, joints } = renderConnection('ollama', [{ source: 'api', status: 'ok' }]);
  assert.deepEqual(live, ['apiKey']);
  assert.deepEqual(names, ['API key', null]);
  assert.deepEqual(joints, ['›']);
  assert.equal(list.className.includes('is-idle'), false);
  assert.equal(list.attributes.role, 'img');
  assert.equal(list.attributes['aria-label'], 'API key › Web · Reading: API key', 'the highlight is spoken, not only coloured');
});

test('without a fresh reading every source is named and the list is idle', () => {
  for (const readings of [[], [{ source: 'api', status: 'ok', stale: true }], [{ source: 'api', status: 'unauthorized' }]]) {
    const { live, names, list } = renderConnection('ollama', readings);
    assert.deepEqual(live, []);
    assert.deepEqual(names, ['API key', 'Web']);
    assert.ok(list.className.includes('is-idle'), JSON.stringify(readings));
  }
});

test('a connected reading whose lane is unknown names every source without claiming one', () => {
  // Cursor reads desktop and manual accounts through the same Web API.
  const { live, names, list } = renderConnection('cursor', [{ source: 'web', status: 'ok' }]);
  assert.deepEqual(live, []);
  assert.deepEqual(names, ['Desktop app', 'Web']);
  assert.equal(list.className.includes('is-idle'), false);
});

test('lanes the account rows attribute light the card even when readings cannot', () => {
  const { live, names } = renderConnection('cursor', [{ source: 'web', status: 'ok' }], new Set(['desktop', 'manual']));
  assert.deepEqual(live, ['desktop', 'web']);
  assert.deepEqual(names, ['Desktop app', 'Web']);
  // Only declared ids count; a row lane alone is enough to leave the idle state.
  const rowOnly = renderConnection('cursor', [], new Set(['desktop', 'unknown']));
  assert.deepEqual(rowOnly.live, ['desktop']);
  assert.equal(rowOnly.list.className.includes('is-idle'), false);
});

test('the card and account rows share one short source vocabulary', () => {
  const { names, list } = renderConnection('ollama');
  assert.deepEqual(names, ['API key', 'Web']);
  assert.equal(list.attributes['aria-label'], 'API key › Web');
  assert.equal(translate('zh-TW', 'settings.limits.sources.apiKey'), 'API Key');
  assert.equal(translate('zh-TW', 'settings.limits.sources.web'), 'Web');
});

test('sourceDetail takes precedence and several accounts can light several lanes', () => {
  assert.deepEqual(renderConnection('codex', [{ source: 'rpc', sourceDetail: 'app', status: 'ok' }]).live, ['desktop']);
  assert.deepEqual(renderConnection('codex', [{ source: 'oauth', sourceDetail: 'managed', status: 'ok' }]).live, ['oauth']);
  const both = renderConnection('codex', [{ source: 'oauth', status: 'ok' }, { source: 'rpc', sourceDetail: 'app', status: 'ok' }]);
  assert.deepEqual(both.live, ['oauth', 'desktop']);
  assert.deepEqual(both.names, ['OAuth', 'Desktop app', null]);
});

test('a single-source provider is live on any fresh reading', () => {
  // Copilot readings report `api` provenance for its OAuth token.
  const { live, names, joints } = renderConnection('copilot', [{ source: 'api', status: 'ok' }]);
  assert.deepEqual(live, ['oauth']);
  assert.deepEqual(names, ['OAuth']);
  assert.deepEqual(joints, []);
});

test('complements follow the ordered alternatives and join with +', () => {
  assert.deepEqual(renderConnection('claude').joints, ['›', '+']);
  const opencode = renderConnection('opencode');
  assert.deepEqual(opencode.items.map(item => item.dataset.kind), ['apiKey', 'file', 'web']);
  assert.deepEqual(opencode.joints, ['›', '+']);
  assert.deepEqual(renderConnection('antigravity').joints, ['+']);
});

test('summaries describe ordered, detected, mixed and manual collection', () => {
  assert.equal(renderConnection('ollama').summary, 'Auto · try sources in order');
  assert.equal(renderConnection('kiro').summary, translate('en', 'settings.limits.sources.detectSummary'));
  for (const id of ['antigravity', 'workbuddy', 'cursor']) assert.equal(renderConnection(id).summary, translate('en', 'settings.limits.sources.mixedSummary'), id);
  assert.equal(renderConnection('deepseek', [{ source: 'web', status: 'ok' }]).summary, 'Paste an API key');
  assert.ok(JSON.stringify(limitAccountFormsForRenderer().find(entry => entry.id === 'deepseek')).includes('settings.deepseek.webTokenNote'));
});

test('all seven locales explain ordered fallback', () => {
  const expected = ['Auto · try sources in order', '自動 · 依序嘗試來源', '自动 · 按顺序尝试来源', '자동 · 소스를 순서대로 시도', '自動 · ソースを順番に試行', 'Automático · probar fuentes en orden', 'Automático · tentar fontes em ordem'];
  assert.deepEqual(Object.keys(MESSAGES).map(locale => translate(locale, 'settings.limits.sources.auto')), expected);
});

test('connection cards carry no credential link; the add-account editor owns it', () => {
  for (const { id } of LIMIT_PROVIDER_ACCOUNTS) assert.equal(renderConnection(id).nodes.some(node => node.tag === 'button'), false, id);
  // Every provider that used to link from the card keeps an open-URL action in its credential editor.
  for (const form of limitAccountFormsForRenderer().filter(form => form.openUrl && form.id !== 'claude')) assert.equal(form.kind, 'credential', form.id);
});

test('provider header pill always reports automatic detection', () => {
  const source = app.slice(app.indexOf('    // Multi-account providers use this space'), app.indexOf('    const settings = LIMIT_PROVIDER_SETTINGS[id];', app.indexOf('    // Multi-account providers use this space')));
  const render = (accountGroup, settings = {}, isEnabled = true) => {
    const actions = { children: [], append(node) { this.children.push(node); } };
    vm.runInNewContext(source, { accountGroup, isEnabled, id: 'grok', state: { settings }, sources: LIMIT_PROVIDER_ACCOUNTS.find(entry => entry.id === 'grok').sources, document: { createElement: () => ({}) }, t: key => translate('zh-TW', key), actions });
    return actions.children;
  };
  assert.equal(render(null)[0]?.textContent, '自動偵測');
  assert.equal(render(null, { grokSourcePreference: 'web' })[0]?.textContent, '自動偵測', 'a stale preference is ignored');
  assert.equal(render({}).length, 0);
  // A disabled provider's row carries no status; the switch says it all.
  assert.equal(render(null, {}, false).length, 0);
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

test('Alibaba displays CLI-first Cookie fallback without changing its dispatch', () => {
  const entry = require('../../src/shared/limits/registry').limitProviderEntry('alibaba');
  assert.deepEqual(entry.sources.map(({ id, relation }) => [id, relation]), [['cli', 'alternative'], ['web', 'alternative']]);
  assert.equal(entry.fetch, 'fetchAlibabaLimits');
  assert.ok(entry.accountSlots, 'Alibaba exposes the shared credential account editor');
});
