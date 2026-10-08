'use strict';

// StepFun authentication fields.
//
// Three lanes, in the order the resolver prefers them:
//   1. stepfunToken      — a pasted Oasis-Token (manual escape hatch)
//   2. stepfunUsername + stepfunPassword — the three-step password login
//   3. STEPFUN_TOKEN / STEPFUN_USERNAME + STEPFUN_PASSWORD env fallbacks
//
// The password exists because an Oasis-Token is a short-lived session JWT with
// no refresh: storing only the token means the quota goes unauthorized as soon
// as the session ages out, and the user has to paste a new one by hand. With a
// password stored, limits.js re-runs the login flow on a 401 and the probe
// heals itself.
//
// The password is kind: 'credential', so it lands in credentials.json and never
// reaches settings.json or the renderer wire. The username is a plain setting —
// it is not a secret and the UI shows it next to the password field.

module.exports = {
  id: 'stepfun',
  fetch: 'fetchStepfunLimits',
  fields: [
    {
      key: 'stepfunUsername',
      kind: 'setting',
      // Resolved against env so a deployment can supply credentials without
      // touching the settings file at all.
      resolve: 'stepfunCredentials',
      envFallback: ['TOKEN_MONITOR_STEPFUN_USERNAME', 'STEPFUN_USERNAME'],
      normalize: 'trim'
    },
    {
      key: 'stepfunPassword',
      kind: 'credential',
      storePath: ['providers', 'stepfun', 'password'],
      normalize: 'secret'
    },
    {
      key: 'stepfunToken',
      kind: 'credential',
      storePath: ['providers', 'stepfun', 'token'],
      resolve: 'stepfunToken',
      envFallback: ['TOKEN_MONITOR_STEPFUN_TOKEN', 'STEPFUN_TOKEN'],
      // A manual token is a deliberate override, so it outranks the password
      // lane in the resolver. Clearing it hands control back to the login flow.
      project: 'set'
    }
  ],
  status: {
    // The password is the durable lane: it re-mints a token whenever the
    // current one ages out, which is what stops the quota from going stale.
    credential: 'stepfunPassword',
    configuredKey: 'stepfunTokenConfigured',
    sourceKey: 'stepfunTokenSource',
    pendingKey: 'stepfunPendingCheckSince'
  },
  form: {
    // No `field` shorthand here: that branch collapses to a single secret input,
    // and this form declares its own fields array, so every field has to be
    // placed in a top / manual block exactly once (assertAccountForm).
    titleKey: 'settings.stepfun.title',
    openKey: 'settings.stepfun.openBrowser',
    clearKey: 'settings.stepfun.clearToken',
    saveKey: 'settings.stepfun.saveToken',
    emptyKey: 'settings.stepfun.statusNotSet',
    failedKey: 'settings.stepfun.saveFailed',
    fields: [
      { key: 'stepfunUsername', input: 'text', labelKey: 'settings.stepfun.username', placeholderKey: 'settings.stepfun.usernamePlaceholder', required: true },
      { key: 'stepfunPassword', input: 'password', labelKey: 'settings.stepfun.password', placeholderKey: 'settings.stepfun.passwordPlaceholder', required: true },
      { key: 'stepfunToken', input: 'textarea', labelKey: 'settings.stepfun.manualToken', placeholderKey: 'settings.stepfun.tokenPlaceholder', required: false }
    ],
    // Username and password sit above the fold because they are what keeps the
    // quota live; the pasted token stays below the setup steps as the manual
    // escape hatch it has always been.
    top: [{ field: 'stepfunUsername' }, { field: 'stepfunPassword' }],
    manual: [
      { steps: [
        'settings.stepfun.step1',
        ['settings.stepfun.step2Before', { code: 'QueryStepPlanRateLimit' }, 'settings.stepfun.step2After'],
        'settings.stepfun.step3',
        'settings.stepfun.step4'
      ] },
      { field: 'stepfunToken' }
    ],
    // The `field` shorthand branch is what maps `url` onto `openUrl`; the
    // fields branch passes openUrl through untouched, so name it directly.
    // `/step-plan` is the live quota page — `/plan-usage` in older docs 404s.
    openUrl: { url: 'https://platform.stepfun.com/step-plan' }
  },
  urlPolicy: [{ hosts: ['platform.stepfun.com'], exactPaths: ['/step-plan'] }]
};
