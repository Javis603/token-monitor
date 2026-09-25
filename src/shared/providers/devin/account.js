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
  form: {
    titleKey: 'settings.devin.title',
    openKey: 'settings.devin.openBrowser',
    clearKey: 'settings.devin.clearCredentials',
    saveKey: 'settings.devin.saveCredentials',
    emptyKey: 'settings.devin.statusNotSet',
    failedKey: 'settings.devin.saveFailed',
    fields: [
      {
        key: 'devinBearerToken',
        input: 'password',
        labelKey: 'settings.devin.bearerToken',
        placeholderKey: 'settings.devin.bearerTokenPlaceholder',
        required: true
      },
      {
        key: 'devinOrganization',
        input: 'text',
        labelKey: 'settings.devin.organization',
        placeholderKey: 'settings.devin.organizationPlaceholder',
        required: true,
        // Not a secret: shown again so a token rotation needs only the token.
        prefill: true
      }
    ],
    manual: [
      { steps: ['settings.devin.step1', 'settings.devin.step2', 'settings.devin.step3', 'settings.devin.step4'] },
      { field: 'devinBearerToken' },
      { field: 'devinOrganization' }
    ],
    openUrl: { url: 'https://app.devin.ai/settings/usage' },
    messages: { required: 'settings.devin.credentialsRequired' }
  },
  urlPolicy: [
    { hosts: ['app.devin.ai'], pathPrefixes: ['/settings/usage'] }
  ]
};
