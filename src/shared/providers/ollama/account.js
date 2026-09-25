'use strict';

// Ollama limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'ollama',
  fetch: 'fetchOllamaLimits',
  fields: [
    {
      key: 'ollamaCookie',
      kind: 'credential',
      storePath: ['providers', 'ollama', 'cookie'],
      resolve: 'ollamaSessionCookie',
      project: 'set'
    }
  ],
  status: {
    credential: 'ollamaCookie',
    configuredKey: 'ollamaCookieConfigured',
    sourceKey: 'ollamaCookieSource',
    pendingKey: 'ollamaPendingCheckSince'
  },
  urlPolicy: [
    { hosts: ['ollama.com', 'www.ollama.com'], exactPaths: ['/settings', '/signin'] }
  ]
};
