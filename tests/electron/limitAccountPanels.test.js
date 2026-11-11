'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { createCredentialPanel } = require('../../src/electron/renderer/limits/accountPanels');
const { limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
const i18n = require('../../src/electron/renderer/i18n');

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classes = new Set();
    this.value = '';
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => (force ? this.classes.add(name) : this.classes.delete(name))
    };
  }

  set className(value) { this.classes = new Set(value.split(' ').filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  append(...children) { this.children.push(...children); }
  get text() {
    return this.children.map((child) => (child instanceof Element ? child.text : String(child.textContent ?? child))).join('')
      || this.textContent || '';
  }
  *walk() {
    yield this;
    for (const child of this.children) if (child instanceof Element) yield* child.walk();
  }
  byId(id) { return [...this.walk()].find((node) => node.id === id); }
  click() { return this.listeners.click(); }
  change(value) { this.value = value; return this.listeners.change(); }
}

// A document whose lookups see the one panel under test, the way the live one
// sees it once the panel is inserted.
function panelDocument() {
  let root = null;
  return {
    setRoot: (node) => { root = node; },
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ textContent: text }),
    getElementById: (id) => root?.byId(id) || null,
    querySelectorAll: (selector) => {
      const form = selector.match(/data-credential-form="([^"]+)"/)?.[1];
      return root ? [...root.walk()].filter((node) => node.dataset.credentialForm === form && node.dataset.byField) : [];
    }
  };
}

function renderPanel(form, callbacks = {}) {
  const document = panelDocument();
  const group = createCredentialPanel(form, {
    document,
    translate: (key, params) => i18n.translate('en', key, params),
    onToggle: () => {}, onOpen: () => {}, onClear: () => {}, onRefresh: () => {}, onSave: async () => {},
    ...callbacks
  });
  document.setRoot(group);
  return { group, document };
}

const translated = (key, params) => i18n.translate('en', key, params);

test('Ollama defaults to API key and switches instructions, setup URL and draft together', async () => {
  const { resolveOpenUrl, syncCredentialFields } = require('../../src/electron/renderer/limits/accountPanels');
  const form = limitAccountFormsForRenderer().find(({ id }) => id === 'ollama');
  const drafts = [];
  const writes = [];
  const { group, document } = renderPanel(form, {
    onSave: (_, values) => drafts.push(values),
    onFieldChange: (...args) => writes.push(args)
  });
  syncCredentialFields(form, { document, settings: {} });
  const choice = group.byId('ollamaCredentialKindInput');
  const api = group.byId('ollamaApiKeyInput');
  const cookie = group.byId('ollamaCookieInput');
  const steps = [...group.walk()].find((node) => node.dataset.dependent === 'credential' && /DevTools/.test(node.text));
  assert.equal(choice.value, 'ollamaApiKey');
  assert.equal(api.placeholder, 'ollama-...');
  assert.equal(api.attributes['aria-label'], 'API key');
  assert.equal(cookie.attributes['aria-label'], 'Cookie');
  assert.equal([...group.walk()].some((node) => node.attributes.for === api.id || node.attributes.for === cookie.id), false, 'the selected type names each input accessibly without a repeated visible label');
  assert.equal(cookie.disabled, true);
  assert.equal(steps.classList.contains('hidden'), true);
  assert.equal(resolveOpenUrl(form, { document }), 'https://ollama.com/settings/keys');
  assert.equal([...group.walk()].find((node) => node.attributes.for === choice.id).text, 'Credential');
  api.value = 'fixture-api-key';
  await group.byId('ollamaCredentialSubmit').click();
  assert.deepEqual(drafts.pop(), { ollamaApiKey: 'fixture-api-key' });

  choice.change('ollamaCookie');
  assert.equal(api.value, '', 'switching discards the hidden secret like OpenCode');
  assert.equal(api.disabled, true);
  assert.equal(cookie.disabled, false);
  assert.equal(steps.classList.contains('hidden'), false);
  assert.equal(resolveOpenUrl(form, { document }), 'https://ollama.com/settings');
  cookie.value = 'wos-session=fixture';
  syncCredentialFields(form, { document, settings: {} });
  assert.equal(choice.value, 'ollamaCookie', 'a stats/settings redraw preserves the chosen draft type');
  assert.equal(cookie.value, 'wos-session=fixture');
  api.value = 'hidden-stale-key';
  await group.byId('ollamaCredentialSubmit').click();
  assert.deepEqual(drafts.pop(), { ollamaCookie: 'wos-session=fixture' }, 'only the selected lane reaches main');
  choice.change('ollamaApiKey');
  assert.equal(cookie.value, '');
  assert.equal(api.value, 'hidden-stale-key');
  assert.deepEqual(writes, [], 'changing the draft type never writes settings or clears stored credentials');
});

test('Ollama initializes from configured credential flags without receiving secrets', () => {
  const { syncCredentialFields } = require('../../src/electron/renderer/limits/accountPanels');
  const form = limitAccountFormsForRenderer().find(({ id }) => id === 'ollama');
  const { group, document } = renderPanel(form);
  const choice = group.byId('ollamaCredentialKindInput');
  syncCredentialFields(form, { document, settings: { ollamaCookieConfigured: true } });
  assert.equal(choice.value, 'ollamaCookie');
  assert.equal(group.byId('ollamaCookieInput').disabled, false);
  syncCredentialFields(form, { document, settings: { ollamaApiKeyConfigured: true, ollamaCookieConfigured: true } });
  assert.equal(choice.value, 'ollamaApiKey', 'effective API key still wins, including an env-backed key');
  syncCredentialFields(form, { document, settings: {} });
  assert.equal(choice.value, 'ollamaApiKey', 'clearing configuration restores the new-account default');
  assert.equal(group.byId('ollamaApiKeyInput').value, '');
  assert.equal(group.byId('ollamaCookieInput').value, '');
});

test('Ollama selector saves replace the stored sibling before subsequent polling', async () => {
  const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
  const { fetchOllamaLimits } = require('../../src/shared/providers/ollama/limits');
  const { syncCredentialFields } = require('../../src/electron/renderer/limits/accountPanels');
  const form = limitAccountFormsForRenderer().find(({ id }) => id === 'ollama');
  let current = { ollamaApiKey: 'ollama-fixture-old', ollamaCookie: '' };
  const patches = [];
  const requests = [];
  const html = '<span>Cloud Usage</span><span>Pro</span><section aria-label="Session usage 14.5% used"><div style="width: 14.5%"></div></section>';
  const fetch = async (url) => {
    requests.push(String(url));
    return {
      ok: true, status: 200, headers: { get: () => '' }, text: async () => html,
      json: async () => String(url).endsWith('/api/me')
        ? { Email: 'fixture@example.com', Plan: 'pro' }
        : { included: { balance_usd: 40, allowance_usd: 60 } }
    };
  };
  const commands = createCredentialCommands({
    env: {}, getSettings: () => current,
    applySettingsPatch: (patch) => { patches.push(patch); current = { ...current, ...patch }; return {}; },
    probeDeps: () => ({ probe: true, providerRuntimeState: new Map(), fetch })
  });
  const { group, document } = renderPanel(form, {
    onSave: async (_, values, clearInput) => {
      const result = await commands.saveCredential('ollama', values);
      assert.equal(result.saved, true);
      clearInput();
    }
  });
  syncCredentialFields(form, { document, settings: { ollamaApiKeyConfigured: true } });
  const choice = group.byId('ollamaCredentialKindInput');
  choice.change('ollamaCookie');
  group.byId('ollamaCookieInput').value = 'wos-session=fixture-switch';
  assert.equal(patches.length, 0, 'switching alone never changes stored credentials');
  await group.byId('ollamaCredentialSubmit').click();
  assert.equal(current.ollamaApiKey, '', 'Cookie save clears the old settings key in main');
  assert.equal(current.ollamaCookie, 'wos-session=fixture-switch');
  assert.equal((await fetchOllamaLimits(current, { env: {}, fetch })).source, 'web');
  assert.equal(requests.some((url) => url.endsWith('/api/balance')), false, 'the stored API key cannot take precedence after Cookie save');

  requests.length = 0;
  choice.change('ollamaApiKey');
  group.byId('ollamaApiKeyInput').value = 'ollama-fixture-new';
  await group.byId('ollamaCredentialSubmit').click();
  assert.equal(current.ollamaCookie, '', 'API save clears the old settings Cookie in main');
  assert.equal(current.ollamaApiKey, 'ollama-fixture-new');
  assert.equal((await fetchOllamaLimits(current, { env: {}, fetch })).source, 'api');
  assert.equal(requests.some((url) => url.endsWith('/settings')), false);
  assert.equal(patches.length, 2);
});

test('Ollama selector and API hint are translated in every locale', () => {
  for (const messages of Object.values(i18n.MESSAGES)) {
    assert.ok(messages['settings.common.credentialKind']);
    assert.ok(messages['settings.ollama.apiKeyNote']);
    assert.equal(messages['settings.ollama.apiKeyPlaceholder'], 'ollama-...');
    assert.equal(messages['settings.ollama.modeNote'], undefined);
    assert.equal(messages['settings.ollama.apiKeyStep1'], undefined);
  }
});

test('Ollama locks credential type until Save settles and restores it after success or failure', async () => {
  const form = limitAccountFormsForRenderer().find(({ id }) => id === 'ollama');
  const drafts = [];
  let finish;
  let fail;
  const { group } = renderPanel(form, {
    onSave: (_, values, clearInput) => new Promise((resolve, reject) => {
      drafts.push(values);
      finish = () => { clearInput(); resolve(); };
      fail = reject;
    })
  });
  const choice = group.byId('ollamaCredentialKindInput');
  const submit = group.byId('ollamaCredentialSubmit');
  group.byId('ollamaApiKeyInput').value = 'fixture-api-key';
  const apiSave = submit.click();
  assert.equal(choice.disabled, true, 'the user cannot switch to a new credential draft during this save');
  assert.deepEqual(drafts, [{ ollamaApiKey: 'fixture-api-key' }]);
  await submit.click();
  assert.equal(drafts.length, 1);
  finish();
  await apiSave;
  assert.equal(choice.disabled, false);
  choice.change('ollamaCookie');
  group.byId('ollamaCookieInput').value = 'wos-session=fixture';
  const cookieSave = submit.click();
  assert.equal(choice.disabled, true);
  assert.deepEqual(drafts[1], { ollamaCookie: 'wos-session=fixture' });
  fail(new Error('fixture write failed'));
  await assert.rejects(cookieSave, /fixture write failed/);
  assert.equal(choice.disabled, false);
  assert.equal(group.byId('ollamaCookieInput').value, 'wos-session=fixture');
});

test('Claude organization choice starts hidden before a cookie is checked', () => {
  const form = limitAccountFormsForRenderer().find((entry) => entry.id === 'claude');
  const { group } = renderPanel(form);
  assert.equal(group.byId('claudeWebOrganizationRow').classList.contains('hidden'), true);
});

test('StepFun setup copy points to its button, request header and save action', () => {
  const form = limitAccountFormsForRenderer().find((entry) => entry.id === 'stepfun');
  const { group } = renderPanel(form);
  const steps = form.manual[0].steps;
  assert.equal(steps.length, 4);
  assert.match(i18n.translate('zh-TW', steps[0]), /使用上方按鈕/);
  assert.match(i18n.translate('en', steps[0]), /button above/);
  assert.match(i18n.translate('en', steps[1][0]), /DevTools \(F12\) -> Network/);
  assert.match(group.text, /QueryStepPlanRateLimit/);
  assert.match(i18n.translate('en', steps[2]), /Headers -> Request Headers.*Oasis-Token/);
  assert.match(i18n.translate('zh-TW', steps[3]), /儲存 token/);
});

for (const form of limitAccountFormsForRenderer()) {
  test(`${form.id} renders a localized account panel and hands the draft to the caller`, async () => {
    const calls = [];
    let save = async (_, values) => {
      calls.push(values);
      throw new Error('test failure');
    };
    const { group } = renderPanel(form, { onSave: (...args) => save(...args) });
    const error = group.byId(`${form.id}ErrorMessage`);
    const submit = group.byId(`${form.id}CredentialSubmit`);
    const manual = group.byId(`${form.id}ManualPanel`);
    assert.equal(group.byId(`${form.id}SettingsToggle`).attributes['aria-controls'], `${form.id}SettingsDetails`);
    assert.equal(manual.className, 'credential-manual-panel');
    assert.equal(group.byId(`${form.id}SettingsToggle`).children[0].textContent, translated(form.titleKey));
    for (const field of form.fields) {
      const input = group.byId(`${field.key}Input`);
      assert.ok(input, `${field.key} control`);
      const placedInManual = [...manual.walk()].includes(input);
      assert.equal(placedInManual, form.manual.some((block) => block.field === field.key), `${field.key} placement`);
      if (field.input === 'select') {
        assert.equal(input.tagName, 'select');
        assert.deepEqual(input.children.map((option) => option.value), field.options.map((option) => option.value));
        continue;
      }
      assert.equal(input.tagName, field.input === 'textarea' ? 'textarea' : 'input');
      if (field.input === 'textarea') assert.equal(input.rows, 3);
      else assert.equal(input.type, field.input);
      if (field.placeholderKey) assert.equal(input.placeholder, translated(field.placeholderKey));
      if (field.ariaLabelKey) assert.equal(input.attributes['aria-label'], translated(field.ariaLabelKey));
      input.value = `${field.key}-draft`;
    }

    // Credential draft fields reach the caller: whether it is complete, rejected
    // or saved is the save path's call, and so is the message line.
    const expected = Object.fromEntries(form.fields.filter((field) => field.submitWithCredential !== false
      && (!form.credentialChoice?.fields.includes(field.key) || field.key === form.credentialChoice.fields[0])).map((field) => [
      field.key,
      field.input === 'select' ? field.options[0].value : `${field.key}-draft`
    ]));
    for (const field of form.fields) if (field.input === 'select') group.byId(`${field.key}Input`).value = field.options[0].value;
    await assert.rejects(submit.click(), /test failure/);
    assert.deepEqual(calls, [expected]);
    assert.equal(submit.disabled, false);
    assert.equal(submit.textContent, translated(form.saveKey));
    assert.equal(error.classList.contains('hidden'), true);
    save = async (_, values, clearInput) => {
      assert.equal(submit.textContent, translated('settings.common.checking'));
      clearInput();
    };
    await submit.click();
    // Clearing the draft empties secrets and leaves settings beside them.
    for (const field of form.fields) {
      assert.equal(group.byId(`${field.key}Input`).value,
        field.secret ? '' : field.input === 'select' ? field.options[0].value : `${field.key}-draft`, field.key);
    }
  });
}

for (const form of limitAccountFormsForRenderer()) {
  test(`${form.id} ignores a second submit while the first save is pending`, async () => {
    let finish;
    let saves = 0;
    const { group } = renderPanel(form, {
      onSave: async () => {
        saves++;
        await new Promise((resolve) => { finish = resolve; });
      }
    });
    const submit = group.byId(`${form.id}CredentialSubmit`);
    const first = submit.click();
    assert.equal(submit.disabled, true);
    await submit.click();
    assert.equal(saves, 1);
    finish();
    await first;
    assert.equal(submit.disabled, false);
  });
}

test('selects drive their dependent hints, notes and landing page before they are saved', async () => {
  const forms = Object.fromEntries(limitAccountFormsForRenderer().map((form) => [form.id, form]));
  const { resolveOpenUrl, syncCredentialFields } = require('../../src/electron/renderer/limits/accountPanels');

  const changes = [];
  const alibaba = renderPanel(forms.alibaba, { onFieldChange: (_, field, value) => changes.push([field.key, value]) });
  const variant = alibaba.group.byId('alibabaVariantInput');
  const hint = [...alibaba.group.walk()].find((node) => node.tagName === 'code' && node.dataset.byField);
  const personalNote = [...alibaba.group.walk()].find((node) => node.dataset.i18n === 'settings.alibaba.personalNote');
  syncCredentialFields(forms.alibaba, { document: alibaba.document, settings: { alibabaVariant: 'intl' } });
  assert.equal(variant.value, 'intl');
  assert.equal(hint.textContent, 'GetSubscriptionSummary');
  assert.equal(personalNote.classList.contains('hidden'), true);
  await variant.change('cn-personal');
  assert.equal(hint.textContent, '/tokenplan/personal/api/v2/usage');
  assert.equal(personalNote.classList.contains('hidden'), false);
  assert.deepEqual(changes, [['alibabaVariant', 'cn-personal']]);
  assert.match(resolveOpenUrl(forms.alibaba, { document: alibaba.document }), /token-plan\/personal$/);

  // An unknown or empty stored value falls back to the first option.
  syncCredentialFields(forms.alibaba, { document: alibaba.document, settings: { alibabaVariant: '' } });
  assert.equal(variant.value, 'cn');

  const qoder = renderPanel(forms.qoder);
  syncCredentialFields(forms.qoder, { document: qoder.document, settings: { qoderSite: 'cn' } });
  assert.equal(qoder.group.byId('qoderSiteInput').value, 'cn');
  assert.match(qoder.group.byId('qoderManualPanel').text, /qoder\.com\.cn\/account\/usage/);
  assert.equal(resolveOpenUrl(forms.qoder, { document: qoder.document }), 'https://qoder.com.cn/account/usage');

  const zai = renderPanel(forms.zai);
  syncCredentialFields(forms.zai, { document: zai.document, settings: { zaiApiRegion: 'bigmodel-cn' } });
  assert.equal(resolveOpenUrl(forms.zai, { document: zai.document }), 'https://bigmodel.cn/coding-plan/personal/usage');
  assert.equal([...zai.group.byId('zaiManualPanel').walk()].some((node) => node.id === 'zaiApiRegionInput'), false,
    'the region stays reachable once the paste panel hides');
});

test('a plain-text setting is shown again after a save, a secret never is', () => {
  const forms = Object.fromEntries(limitAccountFormsForRenderer().map((form) => [form.id, form]));
  const { syncCredentialFields } = require('../../src/electron/renderer/limits/accountPanels');
  const devin = renderPanel(forms.devin);
  syncCredentialFields(forms.devin, { document: devin.document, settings: { devinOrganization: 'org_1', devinBearerToken: 'set' } });
  assert.equal(devin.group.byId('devinOrganizationInput').value, 'org_1');
  assert.equal(devin.group.byId('devinBearerTokenInput').value, '');
  const trae = renderPanel(forms.trae);
  syncCredentialFields(forms.trae, { document: trae.document, settings: { traeDeviceId: 'set' } });
  assert.equal(trae.group.byId('traeDeviceIdInput').value, '');
});

// The save path every account panel shares, run from app.js against a fake IPC.
function accountFormSave({ result, reject } = {}) {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const slice = (from, to) => {
    const start = app.indexOf(from);
    const end = app.indexOf(to, start);
    assert.ok(start !== -1 && end !== -1, `${from} should exist`);
    return app.slice(start, end);
  };
  const calls = [];
  const state = { accountPanelMessages: {}, settingsPushRevision: 0 };
  const context = {
    state,
    LIMIT_PROVIDERS: [{ id: 'deepseek', label: 'DeepSeek' }],
    window: { tokenMonitor: { limits: {
      saveCredential: async (...args) => {
        calls.push(['saveCredential', ...args]);
        if (reject) throw reject;
        return result;
      },
      refresh: async (id) => calls.push(['refreshLimitQuota', id])
    } } },
    applyPersistedSettings: (settings) => calls.push(['applyPersistedSettings', settings]),
    renderExternalProviderStatus: () => calls.push(['render', { ...state.accountPanelMessages }]),
    markExternalProviderCheckPending: (id) => calls.push(['markPending', id]),
    refreshStats: async () => calls.push(['refreshStats']),
    setExternalAccountExpanded: (id, expanded) => calls.push(['expanded', id, expanded]),
    externalProviderAccountLinked: () => false
  };
  vm.runInNewContext(
    slice('function setAccountPanelMessage(', '\nfunction markExternalProviderCheckPending(')
      + slice('async function saveAccountCredential(', '\nfunction limitAccountForm('),
    context
  );
  let cleared = false;
  return {
    calls,
    state,
    message: () => JSON.parse(JSON.stringify(state.accountPanelMessages.deepseek ?? null)),
    run: async (values, options = {}) => {
      cleared = false;
      await context.saveAccountCredential('deepseek', values, {
        failedKey: 'settings.deepseek.saveFailed',
        clearInput: () => { cleared = true; },
        ...options
      });
      return cleared;
    }
  };
}

test('shared account actions reuse credential settings invalidation and collect once', async (t) => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
  const { classifySettingsChange, limitsConfigFromSettings } = require('../../src/electron/runtimeConfig');
  const { runLimitInvalidation, runManualDeviceRefresh, settingsLimitInvalidationPlan } = require('../../src/electron/deviceRuntimeCoordinator');
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  for (const action of ['save', 'save-unchanged', 'save-cookie', 'save-slow', 'save-refresh-fails', 'clear', 'clear-empty', 'refresh', 'startup']) {
    await t.test(action, async (t) => {
      let settings = { limitsEnabled: true, limitProviders: 'ollama,deepseek', ollamaApiKey: 'fixture-old', ollamaCookie: '' };
      if (action === 'clear-empty') settings.ollamaApiKey = '';
      if (action === 'startup') settings.limitProviders = 'ollama';
      const env = action.startsWith('clear') ? { OLLAMA_API_KEY: 'fixture-env' } : {};
      const polls = [];
      const pending = [];
      let releaseQuota;
      let quotaStarted;
      const quotaPending = new Promise((resolve) => { quotaStarted = resolve; });
      const http = async (url, probe) => {
        const quota = String(url).endsWith('/api/balance') || String(url).endsWith('/settings');
        if (!probe && quota) polls.push(String(url));
        if (action === 'save-cookie' && probe) await new Promise((resolve) => setTimeout(resolve, 5));
        if (action === 'save-slow' && !probe && quota) {
          await new Promise((resolve) => { releaseQuota = resolve; quotaStarted(); });
        }
        const status = !probe && action === 'save-refresh-fails' ? 500 : !probe && polls.length > 1 ? 429 : 200;
        return {
          ok: status === 200, status, headers: { get: () => null },
          json: async () => String(url).endsWith('/api/me')
            ? { Email: 'fixture@example.com', Plan: 'pro' }
            : { included: { balance_usd: 40, allowance_usd: 60 } },
          text: async () => '<span id="header-email">fixture@example.com</span><section aria-label="Session usage 10% used"></section>'
        };
      };
      const runtime = createLimitsRuntime(limitsConfigFromSettings(settings, { env }), {
        autoStart: false, autoRetry: false, env,
        fetch: (url) => http(url, false)
      });
      t.after(() => runtime.stop());
      const handle = { refreshLimits: runtime.refresh, clearLimits: runtime.clear };
      let commands;
      const host = {
        console: { log() {} },
        settingsForRenderer: () => ({ limitAccountForms: [form] }),
        applySettingsPatch: (patch, _onDots, limitContext) => {
          const previous = settings;
          commands.noteSettingsPatch(patch);
          settings = { ...settings, ...patch };
          const change = classifySettingsChange(previous, settings);
          if (change.limitsReconfigure) runtime.reconfigure(limitsConfigFromSettings(settings, { env }));
          for (const entry of settingsLimitInvalidationPlan(change, limitContext.ensureLimitProvider)) {
            const refresh = action === 'startup'
              ? (pending.push(entry), Promise.resolve({ queued: true }))
              : runLimitInvalidation(handle, entry.scope, entry.reason, entry.options);
            limitContext.onLimitsRefresh(entry.scope, refresh);
          }
        }
      };
      vm.runInNewContext(slice(main, '  async function applyCredentialSettingsPatch(', '\n  // The settings:update body'), host);
      commands = createCredentialCommands({
        getSettings: () => settings,
        applySettingsPatch: host.applyCredentialSettingsPatch,
        env,
        probeDeps: () => ({ probe: true, providerRuntimeState: new Map(), fetch: (url) => http(url, true) })
      });
      const form = { id: 'ollama', kind: 'credential' };
      let callbacks;
      let statsReads = 0;
      let cutoff;
      const context = {
        state: { settings: { limitAccountForms: [form] }, accountPanelMessages: {} },
        LIMIT_PROVIDERS: [{ id: 'ollama', label: 'Ollama' }],
        document: { getElementById: (id) => id === 'accountsSettingsDetails' ? { insertBefore() {} } : null },
        window: { tokenMonitor: { limits: {
          saveCredential: commands.saveCredential,
          clearCredential: commands.clearCredential,
          refresh: (id) => runLimitInvalidation(handle, { provider: id }, 'account-panel', { clear: false })
        } } },
        limitAccountPanelsApi: {
          createCredentialPanel: (_form, handlers) => { callbacks = handlers; return {}; },
          syncCredentialFields() {}
        },
        refreshStats: async (options = {}) => {
          statsReads += 1;
          if (options.force) await runManualDeviceRefresh(handle, { refreshUsage: false });
        },
        renderExternalProviderStatus() {},
        markExternalProviderCheckPending: (_id, since) => { cutoff = since; },
        clearExternalProviderCheckPending() {}, clearExternalProviderPendingStatus() {},
        setExternalAccountExpanded() {}, externalProviderAccountLinked: () => false,
        initSettingsAnimationWrappers() {}, applyPersistedSettings() {}, t: translated
      };
      vm.runInNewContext(
        slice(app, 'function setAccountPanelMessage(', '\nfunction markExternalProviderCheckPending(')
          + slice(app, 'async function saveAccountCredential(', '\nfunction limitAccountForm(')
          + slice(app, 'function setupLimitAccountPanels(', '\nfunction limitProviderAccountGroup('),
        context
      );
      if (action.startsWith('save') || action === 'startup') {
        const values = action === 'save-cookie'
          ? { ollamaApiKey: '', ollamaCookie: 'wos-session=fixture-cookie' }
          : { ollamaApiKey: action === 'save-unchanged' ? 'fixture-old' : 'fixture-new', ollamaCookie: '' };
        let settled = false;
        const saved = context.saveAccountCredential('ollama', values).then((result) => { settled = true; return result; });
        if (action === 'save-slow') {
          await quotaPending;
          assert.equal(settled, false, 'save waits for the settings write\'s authoritative check');
          releaseQuota();
        }
        assert.equal((await saved).saved, true, 'refresh failure cannot undo a successful credential write');
      } else if (action.startsWith('clear')) await context.clearAccountCredential('ollama');
      else {
        context.setupLimitAccountPanels();
        await callbacks.onRefresh();
      }
      if (action === 'startup') {
        assert.equal(polls.length, 0, 'startup queues one intent until a runtime is ready');
        assert.equal(pending.length, 1);
        runtime.start();
        await Promise.all(pending.map((entry) => runLimitInvalidation(handle, entry.scope, entry.reason, entry.options)));
      }
      assert.equal(polls.length, action === 'save-cookie' ? 0 : 1, 'save probes are separate; a Cookie poll reuses validation instead of requesting again');
      assert.equal(statsReads, 1);
      const row = runtime.getSnapshot().providers.find((entry) => entry.provider === 'ollama');
      assert.equal(row.status, action === 'save-refresh-fails' ? 'unavailable' : 'ok');
      if (cutoff !== undefined) assert.ok(Date.parse(row.updatedAt) >= cutoff, 'the completed check, including cached Cookie validation, must satisfy the save cutoff');
      assert.equal(runtime.getSnapshot().providers.some((entry) => entry.provider === 'deepseek'), false, 'account actions never refresh unrelated providers');
    });
  }
});

test('a rejected or incomplete draft keeps the draft and the current status', async () => {
  for (const [result, expected, messages] of [
    [{ saved: false, verdict: 'invalid', status: 'unauthorized' },
      { key: 'settings.common.credentialRejected', params: { provider: 'DeepSeek' } }],
    [{ saved: false, verdict: 'invalid', status: 'invalidFormat' },
      { key: 'settings.common.credentialInvalidFormat' }],
    [{ saved: false, verdict: 'invalid', status: 'required' },
      { key: 'settings.common.credentialRequired' }],
    // A panel may replace each shared message with its own guidance.
    [{ saved: false, verdict: 'invalid', status: 'unauthorized' },
      { key: 'settings.cline.validationInvalid', params: { provider: 'DeepSeek' } }, { rejected: 'settings.cline.validationInvalid' }],
    [{ saved: false, verdict: 'invalid', status: 'required' },
      { key: 'settings.devin.credentialsRequired' }, { required: 'settings.devin.credentialsRequired' }]
  ]) {
    const save = accountFormSave({ result });
    assert.equal(await save.run({ deepseekApiKey: 'sk-test' }, messages ? { messages } : {}), false);
    assert.deepEqual(
      JSON.parse(JSON.stringify(save.calls.find(([name]) => name === 'saveCredential'))),
      ['saveCredential', 'deepseek', { deepseekApiKey: 'sk-test' }]
    );
    assert.equal(save.calls.some(([name]) => name === 'markPending'), false, 'a rejected key must not drop the linked status');
    assert.deepEqual(save.message(), expected);
  }
});

test('a confirmed credential is cleared from the draft and re-checked', async () => {
  const save = accountFormSave({ result: { saved: true, verdict: 'valid', status: 'ok', settings: { next: true } } });
  assert.equal(await save.run({ deepseekApiKey: 'sk-test' }), true);
  assert.deepEqual(save.calls.map(([name]) => name), [
    'render', 'saveCredential', 'applyPersistedSettings', 'markPending', 'render', 'refreshStats', 'expanded', 'render'
  ]);
  assert.equal(save.message(), null);
});

test('a credential the probe could not confirm is saved with a notice that retires on the next check', async () => {
  for (const [status, key] of [
    ['sourceRateLimited', 'settings.common.credentialSavedRateLimited'],
    ['rateLimited', 'settings.common.credentialSavedRateLimited'],
    ['unavailable', 'settings.common.credentialSavedUnconfirmed'],
    ['error', 'settings.common.credentialSavedUnconfirmed']
  ]) {
    const save = accountFormSave({ result: { saved: true, verdict: 'indeterminate', status } });
    assert.equal(await save.run({ deepseekApiKey: 'sk-test' }), true, status);
    assert.ok(save.calls.some(([name]) => name === 'markPending'), status);
    assert.deepEqual(save.message(), { key, params: { provider: 'DeepSeek' }, tone: 'notice', untilChecked: true }, status);
  }
});

test('a superseded save changes nothing and a failed write names the error', async () => {
  const superseded = accountFormSave({ result: { saved: false, verdict: 'superseded', status: 'superseded' } });
  assert.equal(await superseded.run({ deepseekApiKey: 'sk-test' }), false);
  assert.equal(superseded.message(), null);
  assert.equal(superseded.calls.some(([name]) => name === 'markPending'), false);

  const failed = accountFormSave({ reject: new Error('disk full') });
  assert.equal(await failed.run({ deepseekApiKey: 'sk-test' }), false);
  assert.deepEqual(failed.message(), { key: 'settings.deepseek.saveFailed', params: { message: 'disk full' } });
});

test('every shared account message exists in each locale with its placeholders', () => {
  for (const [key, params] of [
    ['settings.common.credentialRequired', []],
    ['settings.common.credentialInvalidFormat', []],
    ['settings.common.credentialRejected', ['provider']],
    ['settings.common.credentialSavedRateLimited', ['provider']],
    ['settings.common.credentialSavedUnconfirmed', ['provider']]
  ]) {
    for (const [locale, messages] of Object.entries(i18n.MESSAGES)) {
      assert.ok(Object.hasOwn(messages, key), `${key} missing in ${locale}`);
      for (const param of params) assert.match(messages[key], new RegExp(`\\{${param}\\}`), `${key} ${locale}`);
    }
  }
});

test('account setting errors are reported through the persistent panel message', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
  const start = app.indexOf('function setupLimitAccountPanels()');
  const end = app.indexOf('\nfunction limitProviderAccountGroup(', start);
  const form = limitAccountFormsForRenderer().find(({ id }) => id === 'deepseek');
  const messages = [];
  const renders = [];
  let callbacks;
  const context = {
    state: { settings: { limitAccountForms: [form] } },
    document: { getElementById: (id) => id === 'accountsSettingsDetails' ? { insertBefore() {} } : null },
    limitAccountPanelsApi: { createCredentialPanel: (_, received) => { callbacks = received; return {}; } },
    LIMIT_PROVIDERS: [{ id: 'deepseek' }],
    t: translated,
    limitProviderAccountGroup: () => null,
    setExternalAccountExpanded() {},
    initSettingsAnimationWrappers() {},
    renderExternalProviderStatus: (id) => renders.push(id),
    setAccountPanelMessage: (id, message) => messages.push({ id, message })
  };
  context.limitAccountPanelsApi.syncCredentialFields = () => {};
  vm.runInNewContext(`${app.slice(start, end)}\nsetupLimitAccountPanels();`, context);
  callbacks.onFieldError(form, new Error('disk full'));
  assert.equal(messages[0].id, 'deepseek');
  assert.equal(messages[0].message.key, form.failedKey);
  assert.equal(messages[0].message.params.message, 'disk full');
  assert.deepEqual(renders, ['deepseek', 'deepseek']);
});

test('OpenDesign renders all four Cookie setup steps before its input, like TypeSafe', () => {
  const forms = limitAccountFormsForRenderer();
  const form = forms.find(({ id }) => id === 'opendesign');
  const peer = forms.find(({ id }) => id === 'typesafe');
  assert.deepEqual(form.manual.map((block) => Object.keys(block)), peer.manual.map((block) => Object.keys(block)));
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'pt-BR']) {
    const { group } = renderPanel(form, { translate: (key) => i18n.translate(locale, key) });
    const manual = group.byId('opendesignManualPanel');
    const steps = manual.children[0];
    assert.deepEqual([...steps.walk()].filter((node) => node.tagName === 'strong').map((node) => node.textContent), ['1.', '2.', '3.', '4.']);
    for (const step of form.manual[0].steps) {
      for (const part of Array.isArray(step) ? step : [step]) {
        if (typeof part === 'string') assert.ok(steps.text.includes(i18n.translate(locale, part)));
      }
    }
    assert.equal(group.byId('opendesignCookieInput').placeholder, 'Cookie: ...');
    assert.deepEqual([...steps.walk()].filter((node) => node.tagName === 'code').map((node) => node.textContent), ['coding-plan-usage', 'amr-api.open-design.ai']);
    assert.equal(i18n.translate(locale, 'settings.opendesign.step4'), locale === 'ja'
      ? '下に貼り付けて「Cookie を保存」をクリックします。'
      : i18n.translate(locale, 'settings.commandcode.step4'));
    assert.equal(manual.children[1].id, 'opendesignCookieInput');
    assert.equal(manual.children[2].children[0].id, 'opendesignCredentialSubmit');
    assert.ok(!group.text.includes('settings.opendesign.'), `${locale}: untranslated key`);
  }
});

test('OpenDesign Cookie instructions match the existing browser, DevTools and request-header flow', () => {
  const t = (key) => i18n.translate('en', 'settings.opendesign.' + key);
  assert.match(t('step1'), /browser \(button above\).*sign in.*workspace/);
  assert.match(t('step2'), /DevTools \(F12\) -> Network.*subscription usage.*reload/);
  assert.match(t('step3After'), /full Cookie value from Headers -> Request Headers/);
  assert.match(t('step4'), /click Save cookie/);
});

test('OpenDesign save failures retain the underlying error in every locale', () => {
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja', 'pt-BR']) {
    const text = i18n.translate(locale, 'settings.opendesign.saveFailed', { message: 'fixture disk failure' });
    assert.ok(text.includes('fixture disk failure'), locale);
  }
});


test('Mistral setup renders both the allowance note and cookie-copy steps', () => {
  const form = limitAccountFormsForRenderer().find(({ id }) => id === 'mistral');
  const { group } = renderPanel(form);
  assert.match(group.text, /Included API/);
  assert.match(group.text, /DevTools/);
  assert.match(group.text, /ory_session_/);
  assert.ok(group.byId('mistralCookieInput'));
});
