'use strict';

// StepFun authentication fields.
//
// Three lanes, in the order the resolver prefers them:
//   1. stepfunToken      — a pasted Oasis-Token (manual escape hatch)
//   2. stepfunUsername + stepfunPassword — the browser-driven password login
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
    },
    {
      // The device id the session was registered under. The quota endpoints
      // pair Oasis-Token with it and reject a foreign one: without it the
      // answer is 401 "oasis-token is embezzled", which the panel renders
      // identically to a wrong token, so a pasted token had no way to say
      // "this webid goes with it". Left unset, limits.js omits the header
      // rather than guessing.
      key: 'stepfunWebid',
      kind: 'credential',
      storePath: ['providers', 'stepfun', 'webid'],
      envFallback: ['TOKEN_MONITOR_STEPFUN_WEBID', 'STEPFUN_WEBID'],
      normalize: 'trim',
      project: 'set'
    },
    {
      // Whether the browser login keeps its session on disk. On (the default)
      // the sign-in survives a restart, so no window is popped again; off
      // trades that for an in-memory-only partition that is wiped on quit.
      // Stored as '1'/'0' rather than a boolean because the form framework has
      // no checkbox input — a select is the only non-secret control it renders.
      key: 'stepfunRememberLogin',
      kind: 'setting',
      initial: null,
      configDefault: '1',
      normalize: 'trim'
    }
  ],
  status: {
    // The password is the durable lane: it re-mints a token whenever the
    // current one ages out, which is what stops the quota from going stale.
    //
    // All three keys look unread, but they are a required shape rather than
    // dead configuration: configuredKey/sourceKey are what
    // defaultAccountStatus() writes the renderer (Configured / Source), and
    // assertAccountForm rejects the whole registry entry if pendingKey is
    // absent. Dropping them looks like cleanup and takes the provider out.
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
      // No `required` on any secret field. credentialCommands rejects a save
      // when a required field is empty, which would have made the pasted-token
      // escape hatch unreachable — and it is the only lane on a machine with no
      // BrowserWindow (the headless agent).
      //
      // There is still a floor, and it comes from credentialCommands itself: a
      // save is rejected unless at least one secret field holds something. So
      // "username alone" never reaches storage, while "username + password"
      // and "token alone" both do. A half-filled pair left in the form degrades
      // to notConfigured, because stepfunCredentials() needs both halves.
      { key: 'stepfunUsername', input: 'text', labelKey: 'settings.stepfun.username', placeholderKey: 'settings.stepfun.usernamePlaceholder', required: false },
      { key: 'stepfunPassword', input: 'password', labelKey: 'settings.stepfun.password', placeholderKey: 'settings.stepfun.passwordPlaceholder', required: false },
      { key: 'stepfunToken', input: 'textarea', labelKey: 'settings.stepfun.manualToken', placeholderKey: 'settings.stepfun.tokenPlaceholder', required: false },
      { key: 'stepfunWebid', input: 'text', labelKey: 'settings.stepfun.webid', placeholderKey: 'settings.stepfun.webidPlaceholder', required: false },
      {
        // A setting beside the credential: saved on its own, and left alone by
        // Clear, which must not silently opt the user back into persisting.
        key: 'stepfunRememberLogin',
        input: 'select',
        labelKey: 'settings.stepfun.rememberLogin',
        options: [
          { value: '1', labelKey: 'settings.stepfun.rememberLoginYes' },
          { value: '0', labelKey: 'settings.stepfun.rememberLoginNo' }
        ],
        saveOnChange: true,
        submitWithCredential: false,
        required: false
      }
    ],
    // Username and password sit above the fold because they are what keeps the
    // quota live; the pasted token stays below as the manual escape hatch.
    top: [{ field: 'stepfunUsername' }, { field: 'stepfunPassword' }],
    manual: [
      { steps: [
        'settings.stepfun.step1',
        ['settings.stepfun.step2Before', { code: 'QueryStepPlanRateLimit' }, 'settings.stepfun.step2After'],
        'settings.stepfun.step3',
        'settings.stepfun.step4'
      ] },
      { field: 'stepfunToken' },
      { field: 'stepfunWebid' },
      { field: 'stepfunRememberLogin' },
      // Diagnostics nobody can find are the same as diagnostics that do not
      // exist: the whole reason the log exists is that the panel reports
      // "unavailable" for a dozen different causes.
      { note: 'settings.stepfun.diagnosticHint' }
    ],
    // The `field` shorthand branch is what maps `url` onto `openUrl`; the
    // fields branch passes openUrl through untouched, so name it directly.
    // `/step-plan` is the live quota page — `/plan-usage` in older docs 404s.
    openUrl: { url: 'https://platform.stepfun.com/step-plan' }
  },
  urlPolicy: [{ hosts: ['platform.stepfun.com'], exactPaths: ['/step-plan'] }]
};