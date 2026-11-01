'use strict';

// Claude limits account wiring. Leaf module: no requires — see
// src/shared/limits/accounts.js for the field schema.
module.exports = {
  id: 'claude',
  fetch: 'fetchClaudeAccountsLimits',
  fields: [
    {
      key: 'claudeManagedAccounts',
      kind: 'managed',
      contextOverride: true,
      persist: 'never',
      watch: false,
      initial: [],
      project: (value, limits) => limits.normalizeClaudeManagedAccounts(value)
    },
    {
      key: 'claudeWebCookie',
      kind: 'credential',
      storePath: ['providers', 'claude', 'webCookie'],
      resolve: 'claudeWebCookie',
      normalize: { fn: 'normalizeClaudeWebCookieInput', style: 'value' },
      envFallback: ['CLAUDE_WEB_COOKIE'],
      project: 'set'
    },
    {
      key: 'claudeWebOrganizationId',
      kind: 'setting',
      normalize: { fn: 'normalizeClaudeWebOrganizationId', style: 'value' },
      project: 'value',
      clearWithCredential: true
    },
    // Claude Desktop local-only mode (see desktopPlanUsage.js): read the
    // Desktop app's plan-usage samples and never enter the Web, OAuth or CLI
    // lanes. The env var is a fallback lane, so it also switches the mode on
    // when the stored setting is off.
    {
      key: 'claudeDesktopLocalOnly',
      kind: 'setting',
      normalize: (value) => value === true || /^(1|true|yes|on)$/i.test(String(value ?? '').trim()),
      configNormalize: (value) => value === true || /^(1|true|yes|on)$/i.test(String(value ?? '').trim()),
      envFallback: ['TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY'],
      persist: 'spread',
      initial: null
    },
    // Organization whose Desktop samples to read when several accounts have
    // used this machine. Empty: the organization of the newest sample.
    {
      key: 'claudeDesktopOrgId',
      kind: 'setting',
      normalize: 'trim',
      envFallback: ['TOKEN_MONITOR_CLAUDE_DESKTOP_ORG_ID'],
      persist: 'spread',
      initial: null
    }
  ],
  status: {
    credential: 'claudeWebCookie',
    configuredKey: 'claudeWebCookieConfigured',
    sourceKey: 'claudeWebCookieSource',
    pendingKey: 'claudePendingCheckSince'
  },
  accountStatus({ settings, env, limits }) {
    const stored = Boolean(settings?.claudeWebCookie);
    const external = Boolean(limits.claudeWebCookie(env));
    const managed = limits.normalizeClaudeManagedAccounts(settings?.claudeManagedAccounts).length > 0;
    return {
      claudeWebCookieConfigured: stored || external || managed,
      claudeWebCookieSource: stored || managed ? 'settings' : external ? 'env' : '',
      claudeWebLegacyCookieConfigured: stored || external,
      claudeWebLegacyCookieSource: stored ? 'settings' : external ? 'env' : ''
    };
  },
  form: {
    multipleAccounts: true,
    discover: { fn: 'listClaudeWebOrganizations', credential: 'claudeWebCookie', selection: 'claudeWebOrganizationId' },
    titleKey: 'settings.claude.title',
    openKey: 'settings.claude.openBrowser',
    clearKey: 'settings.claude.clearCookie',
    saveKey: 'settings.claude.saveCookie',
    emptyKey: 'settings.claude.statusNotSet',
    failedKey: 'settings.claude.saveFailed',
    fields: [
      { key: 'claudeWebCookie', input: 'textarea', placeholderKey: 'settings.claude.cookiePlaceholder', required: true },
      { key: 'claudeWebOrganizationId', input: 'select', labelKey: 'settings.claude.organization', options: [
        { value: '', labelKey: 'settings.claude.organizationChoose' }
      ] }
    ],
    top: [{ field: 'claudeWebOrganizationId' }],
    manual: [
      { note: 'settings.claude.note' },
      { steps: ['settings.claude.step1', 'settings.claude.step2', 'settings.claude.step3', 'settings.claude.step4'] },
      { field: 'claudeWebCookie' }
    ],
    openUrl: { url: 'https://claude.ai/settings/usage' },
    messages: {
      required: 'settings.claude.cookieRequired',
      invalidFormat: 'settings.claude.cookieInvalidFormat',
      rejected: 'settings.claude.cookieRejected'
    }
  },
  urlPolicy: [
    { hosts: ['claude.ai'], pathPrefixes: ['/settings'] }
  ]
};
