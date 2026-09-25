'use strict';

// Alibaba Cloud limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'alibaba',
  fetch: 'fetchAlibabaLimits',
  fields: [
    {
      key: 'alibabaCookie',
      kind: 'credential',
      storePath: ['providers', 'alibaba', 'cookie'],
      resolve: 'alibabaCookie',
      normalize: { fn: 'normalizeAlibabaCookieHeader', style: 'value' },
      project: 'set'
    },
    {
      key: 'alibabaVariant',
      kind: 'setting',
      // Env is consulted here, not just in the collector: resolving it in only
      // one of the two leaves the settings UI showing a different console than
      // the one the quota request actually goes to.
      normalize: { fn: 'alibabaVariant', style: 'optionsEnv' },
      project: (value, limits, env) => limits.alibabaVariant({ alibabaVariant: value }, env),
      // Empty, not 'cn': defaults are merged into settings before any read, so
      // a concrete value here would satisfy the `options || env` fallback and
      // make ALIBABA_TOKEN_PLAN_VARIANT unreachable in both the UI and the
      // collector. The effective variant is resolved at use, never stored.
      initial: ''
    }
  ],
  status: {
    credential: 'alibabaCookie',
    configuredKey: 'alibabaCookieConfigured',
    sourceKey: 'alibabaCookieSource',
    pendingKey: 'alibabaPendingCheckSince'
  },
  urlPolicy: [
    // Token Plan lives behind a hash route, so the console's region path is all
    // there is to match on. Kept host-scoped rather than opening the whole
    // console, in line with every other entry here.
    { hosts: ['bailian.console.aliyun.com'], pathPrefixes: ['/cn-beijing'] },
    { hosts: ['modelstudio.console.alibabacloud.com'], pathPrefixes: ['/ap-southeast-1'] }
  ]
};
