// @ts-check
'use strict';

// Manual-only account declaration. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'notion',
  accountSlots: true,
  serverAccountKey: 'isNotionServerAccountKey',
  sources: [
    { id: 'web', kind: 'web', relation: 'single', products: ['notion'], labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.limits.sources.webDescription' }
  ],
  fetch: 'fetchNotionLimits',
  fields: [
    {
      key: 'notionCookie',
      kind: 'credential',
      storePath: ['providers', 'notion', 'cookie'],
      resolve: 'notionCookie',
      normalize: { fn: 'normalizeNotionCookieHeader', style: 'value' },
      envFallback: ['TOKEN_MONITOR_NOTION_COOKIE', 'NOTION_COOKIE'],
      project: 'set'
    },
    {
      key: 'notionWorkspaceId',
      kind: 'setting',
      resolve: 'notionWorkspaceId',
      normalize: { fn: 'normalizeNotionWorkspaceId', style: 'value' },
      envFallback: ['TOKEN_MONITOR_NOTION_WORKSPACE_ID', 'NOTION_WORKSPACE_ID'],
      clearWithCredential: true
    }
  ],
  status: {
    credential: 'notionCookie',
    configuredKey: 'notionCookieConfigured',
    sourceKey: 'notionCookieSource',
    pendingKey: 'notionPendingCheckSince'
  },
  form: {
    titleKey: 'settings.notion.title',
    openKey: 'settings.notion.openBrowser',
    clearKey: 'settings.notion.clearCookie',
    saveKey: 'settings.notion.saveCookie',
    emptyKey: 'settings.notion.statusNotSet',
    failedKey: 'settings.notion.saveFailed',
    messages: {
      required: 'settings.notion.required',
      invalidFormat: 'settings.notion.invalidFormat',
      rejected: 'settings.notion.rejected'
    },
    fields: [
      { key: 'notionCookie', input: 'password', placeholderKey: 'settings.notion.cookiePlaceholder', required: true },
      {
        key: 'notionWorkspaceId',
        input: 'text',
        labelKey: 'settings.notion.workspaceId',
        placeholderKey: 'settings.notion.workspaceIdPlaceholder',
        required: true,
        secret: false,
        prefill: true
      }
    ],
    manual: [
      { note: 'settings.notion.note' },
      { steps: ['settings.notion.step1', 'settings.notion.step2', 'settings.notion.step3'] },
      { field: 'notionCookie' },
      { field: 'notionWorkspaceId' }
    ],
    openUrl: { url: 'https://app.notion.com/' }
  },
  urlPolicy: [{ hosts: ['app.notion.com'] }]
});
