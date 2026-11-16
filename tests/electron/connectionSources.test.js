'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { LIMIT_PROVIDER_ACCOUNTS } = require('../../src/shared/limits/accounts');
const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limits/providers');
const { MESSAGES, translate } = require('../../src/electron/renderer/i18n');
const { connectionTag } = require('../../src/electron/renderer/limits/providerPresentation');
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
    const tags = vm.runInNewContext(expression + '\ntagInfos;', { pluginModule: null, limitProviderPresentationApi: { connectionTag }, id, state: { settings: { limitConnectionSources: limitConnectionSourcesForRenderer() } } });
    assert.equal(tags.length, 1);
    const tag = tags[0];
    assert.equal(tag.kind, 'capability');
    assert.ok(tag.parts.length);
    assert.equal(new Set(tag.parts).size, tag.parts.length);
    assert.doesNotMatch(tag.label, /Plan|Pay-as|Auto|Manual/);
  }
  const render = app.slice(app.indexOf('function renderLimitProviderCheckboxes('), app.indexOf('function limitProviderConnectionDetail('));
  assert.match(render, /: \[limitProviderPresentationApi.connectionTag\(id,/);
  assert.ok(render.indexOf('optionsInner.append(limitProviderConnectionDetail') < render.indexOf('optionsInner.append(limitProviderSettingsList'));
});

function renderConnection(id, reading = {}) {
  const nodes = [];
  const document = { createElement(tag) { const node = { tag, children: [], textContent: '', append(...children) { this.children.push(...children); }, addEventListener(event, callback) { this[event] = callback; } }; nodes.push(node); return node; } };
  const source = app.slice(app.indexOf('function limitProviderConnectionDetail('), app.indexOf('// Single entry point for the provider options'));
  const opened = [];
  const form = limitAccountFormsForRenderer().find(entry => entry.id === id);
  const context = { LIMIT_PROVIDERS: [{ id, label: id === 'zed' ? 'Zed' : id }], document, t: (key, params) => translate('en', key, params), limitAccountForm: () => form,
    externalProviderForAccount: () => reading, limitAccountPanelsApi: require('../../src/electron/renderer/limits/accountPanels'),
    window: { tokenMonitor: { openExternal: url => opened.push(url) } } };
  vm.runInNewContext(source + '\nthis.renderConnection = limitProviderConnectionDetail;', context);
  const panel = context.renderConnection(id, LIMIT_PROVIDER_ACCOUNTS.find(entry => entry.id === id).sources, reading);
  return { panel, nodes, opened };
}

test('alternative connection row uses existing provenance, never invents detection', () => {
  const { panel, nodes } = renderConnection('ollama', { source: 'api', status: 'ok' });
  assert.equal(panel.className, 'settings-item');
  assert.ok(nodes.some(node => node.textContent === 'Auto · currently using API key'));
  assert.equal(nodes.filter(node => node.className === 'settings-item-desc').length, 3);
  const unknown = renderConnection('ollama', { source: 'api', status: 'unavailable' });
  assert.ok(unknown.nodes.some(node => node.textContent === 'Auto'));
  assert.ok(!unknown.nodes.some(node => /currently using|not detected/i.test(node.textContent)));
});

test('single connection row reuses the form URL and existing link style', () => {
  const { nodes, opened } = renderConnection('zed');
  const link = nodes.find(node => node.tag === 'button');
  assert.equal(link.className, 'inline-link');
  assert.equal(link.textContent, 'Get from Zed ↗');
  link.click();
  assert.deepEqual(opened, ['https://dashboard.zed.dev/']);
});

test('retired provider tag and connection tables stay unused', () => {
  const presentation = fs.readFileSync('src/electron/renderer/limits/providerPresentation.js', 'utf8');
  for (const name of ['CAPABILITY_TAGS', 'PROVIDER_SOURCE_LABELS', 'LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS']) {
    assert.ok(!app.includes(name) && !presentation.includes(name), name);
  }
});
