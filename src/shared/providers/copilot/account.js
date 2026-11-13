'use strict';

// GitHub Copilot limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'copilot',
  fetch: 'fetchCopilotLimits',
  accountRefresh: true,
  fields: [
    { key: 'copilotProfiles', kind: 'profiles',
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
      normalize: (value) => String(value || '').trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase()
    }
  ],
  accountStatus({ settings, env, limits }) {
    const accounts = limits.configuredCopilotAccounts(settings, { env });
    return {
      copilotApiTokenConfigured: accounts.length > 0,
      copilotApiTokenSource: accounts.some(account => account.id !== 'environment') ? 'settings' : accounts.length ? 'env' : ''
    };
  },
  // Copilot's sign-in flow owns its pending state, so there is no pendingKey.
  status: {
    credential: 'copilotApiToken',
    configuredKey: 'copilotApiTokenConfigured',
    sourceKey: 'copilotApiTokenSource'
  }
};
