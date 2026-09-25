'use strict';

// DeepSeek limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'deepseek',
  fetch: 'fetchDeepSeekLimits',
  fields: [
    {
      key: 'deepseekApiKey',
      kind: 'credential',
      storePath: ['providers', 'deepseek', 'apiKey'],
      resolve: 'deepseekToken',
      resolveStyle: 'explicit'
    }
  ],
  // DeepSeek keeps its own pending-check lane, so there is no pendingKey.
  status: {
    credential: 'deepseekApiKey',
    configuredKey: 'deepseekApiKeyConfigured',
    sourceKey: 'deepseekApiKeySource'
  },
  urlPolicy: [
    { hosts: ['platform.deepseek.com'], pathPrefixes: ['/api_keys'] }
  ]
};
