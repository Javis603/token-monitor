'use strict';

// Qoder limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'qoder',
  fetch: 'fetchQoderLimits',
  fields: [
    {
      key: 'qoderCookie',
      kind: 'credential',
      storePath: ['providers', 'qoder', 'cookie'],
      resolve: 'qoderCookie',
      project: 'set'
    },
    {
      key: 'qoderSite',
      kind: 'setting',
      normalize: (value) => {
        const raw = String(value || '').trim().toLowerCase();
        if (raw === 'cn' || raw === 'china' || raw.includes('qoder.com.cn')) return 'cn';
        return 'global';
      },
      configDefault: 'global',
      persist: 'renormalize',
      persistFallback: 'global',
      initial: 'global'
    }
  ],
  status: {
    credential: 'qoderCookie',
    configuredKey: 'qoderCookieConfigured',
    sourceKey: 'qoderCookieSource',
    pendingKey: 'qoderPendingCheckSince'
  },
  form: {
    titleKey: 'settings.qoder.title',
    openKey: 'settings.qoder.openBrowser',
    clearKey: 'settings.qoder.clearCookie',
    saveKey: 'settings.qoder.saveCookie',
    emptyKey: 'settings.qoder.statusNotSet',
    failedKey: 'settings.qoder.saveFailed',
    fields: [
      {
        key: 'qoderSite',
        input: 'select',
        labelKey: 'settings.qoder.site',
        options: [
          { value: 'global', labelKey: 'settings.qoder.siteGlobal' },
          { value: 'cn', labelKey: 'settings.qoder.siteCn' }
        ],
        saveOnChange: true
      },
      { key: 'qoderCookie', input: 'textarea', placeholderKey: 'settings.qoder.cookiePlaceholder', required: true }
    ],
    manual: [
      { field: 'qoderSite' },
      {
        steps: [
          ['settings.qoder.step1Before', { code: { byField: 'qoderSite', values: { global: 'qoder.com/account/usage', cn: 'qoder.com.cn/account/usage' } } }, 'settings.qoder.step1After'],
          'settings.qoder.step2',
          'settings.qoder.step3',
          'settings.qoder.step4'
        ]
      },
      { field: 'qoderCookie' }
    ],
    openUrl: {
      byField: 'qoderSite',
      urls: { global: 'https://qoder.com/account/usage', cn: 'https://qoder.com.cn/account/usage' },
      default: 'https://qoder.com/account/usage'
    }
  },
  urlPolicy: [
    { hosts: ['qoder.com', 'www.qoder.com', 'qoder.com.cn', 'www.qoder.com.cn'] }
  ]
};
