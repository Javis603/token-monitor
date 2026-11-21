// @ts-check
'use strict';

// GitHub Copilot limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'copilot',
  fetch: 'fetchCopilotLimits',
  accountSlots: true,
  serverAccountKey: 'isCopilotServerAccountKey',
  dedupeAccounts: true,
  environmentWhenSaved: false,
  sources: [
    { id: 'oauth', kind: 'oauth', relation: 'single', products: ['copilot'], labelKey: 'settings.limits.sources.oauth', descriptionKey: 'settings.limits.sources.oauthDescription' }
  ],
  accountRefresh: true,
  accountStatus: ({ settings, env, limits }) => {
    const stored = Object.keys(limits.copilotProfiles(settings, env)).length > 0;
    const environment = Boolean(limits.copilotToken(env));
    return { copilotApiTokenConfigured: stored || environment,
      copilotApiTokenSource: stored ? 'settings' : environment ? 'env' : '' };
  },
  fields: [
    { key: 'copilotProfiles', kind: 'setting', rendererOmit: true, config: false, watch: false,
      storePath: ['providers', 'copilot', 'profiles'], configDefault: {}, persist: 'never' },
    {
      key: 'copilotApiToken',
      kind: 'credential',
      storePath: ['providers', 'copilot', 'apiToken'],
      resolve: 'copilotToken'
    },
    {
      key: 'copilotEnterpriseHost',
      kind: 'setting',
      envFallback: ['COPILOT_ENTERPRISE_HOST', 'GITHUB_ENTERPRISE_HOST'],
      normalize: (value) => String(value || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase()
    }
  ],
  form: {
    titleKey: 'settings.copilot.title', openKey: 'settings.copilot.signIn',
    clearKey: 'settings.slots.remove', saveKey: 'settings.copilot.saveToken',
    emptyKey: 'settings.copilot.statusNotSet', failedKey: 'settings.copilot.loginFailed',
    loginAction: { labelKey: 'settings.copilot.signIn' },
    fields: [
      { key: 'copilotApiToken', input: 'password', placeholderKey: 'settings.copilot.apiTokenPlaceholder', required: true },
      { key: 'copilotEnterpriseHost', input: 'text', secret: false, placeholder: 'github.com', submitWithCredential: true }
    ],
    manual: [{ note: 'settings.copilot.note' }, { field: 'copilotApiToken' }, { field: 'copilotEnterpriseHost' }],
    openUrl: { url: 'https://github.com/settings/tokens' }
  },
  urlPolicy: [{ hosts: ['github.com'], pathPrefixes: ['/settings/tokens'] }],
  status: {
    credential: 'copilotApiToken',
    configuredKey: 'copilotApiTokenConfigured',
    sourceKey: 'copilotApiTokenSource', pendingKey: 'copilotPendingCheckSince'
  }
});
