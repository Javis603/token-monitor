'use strict';

// Claude limits account wiring. Leaf module: no requires — see
// src/shared/limits/accounts.js for the field schema.
module.exports = {
  id: 'claude',
  fetch: 'fetchClaudeLimits',
  fields: [
    {
      key: 'claudeWebCookie',
      kind: 'credential',
      storePath: ['providers', 'claude', 'webCookie'],
      resolve: 'claudeWebCookie',
      normalize: { fn: 'normalizeClaudeWebCookieInput', style: 'value' },
      envFallback: ['CLAUDE_WEB_COOKIE'],
      project: 'set'
    }
  ],
  status: {
    credential: 'claudeWebCookie',
    configuredKey: 'claudeWebCookieConfigured',
    sourceKey: 'claudeWebCookieSource',
    pendingKey: 'claudePendingCheckSince'
  },
  urlPolicy: [
    { hosts: ['claude.ai'], pathPrefixes: ['/settings'] }
  ]
};
