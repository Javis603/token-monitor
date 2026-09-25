'use strict';

// Devin limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'devin',
  fetch: 'fetchDevinLimits',
  fields: [
    {
      key: 'devinBearerToken',
      kind: 'credential',
      storePath: ['providers', 'devin', 'bearerToken'],
      resolve: 'devinBearerToken',
      project: 'set'
    },
    {
      key: 'devinOrganization',
      kind: 'setting',
      normalize: { fn: 'normalizeDevinOrganization', style: 'value' },
      project: 'value'
    }
  ],
  // The bearer token alone is not enough: Devin also needs an organization,
  // which may come from settings or the env lanes the resolver reads.
  status: {
    configuredKey: 'devinBearerTokenConfigured',
    sourceKey: 'devinBearerTokenSource',
    pendingKey: 'devinPendingCheckSince'
  },
  accountStatus: ({ settings, env, limits }) => ({
    devinBearerTokenConfigured: Boolean(
      (settings?.devinBearerToken || limits.devinBearerToken(env))
      && limits.normalizeDevinOrganization(
        settings?.devinOrganization
        || env.TOKEN_MONITOR_DEVIN_ORGANIZATION
        || env.DEVIN_ORGANIZATION
        || env.DEVIN_ORG
      )
    ),
    devinBearerTokenSource: settings?.devinBearerToken
      ? 'settings'
      : limits.devinBearerToken(env)
        ? 'env'
        : ''
  }),
  urlPolicy: [
    { hosts: ['app.devin.ai'], pathPrefixes: ['/settings/usage'] }
  ]
};
