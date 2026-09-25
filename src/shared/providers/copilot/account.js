'use strict';

// GitHub Copilot limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'copilot',
  fetch: 'fetchCopilotLimits',
  fields: [
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
  // Copilot's sign-in flow owns its pending state, so there is no pendingKey.
  status: {
    credential: 'copilotApiToken',
    configuredKey: 'copilotApiTokenConfigured',
    sourceKey: 'copilotApiTokenSource'
  }
};
