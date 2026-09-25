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
  urlPolicy: [
    { hosts: ['qoder.com', 'www.qoder.com', 'qoder.com.cn', 'www.qoder.com.cn'] }
  ]
};
