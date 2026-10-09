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
      // `trim`, NOT left to the resolver. The registry derives a write-time
      // normalizer from `resolve` whenever the field declares none
      // (registry.js: `bound.normalize = normalize || bound.resolverNormalize`),
      // and `stepfunToken` is exactly the function that squeezes a pasted
      // cookie string down to its token field. So a bare `resolve` silently
      // threw away Oasis-Webid on the way to storage — the device id the
      // endpoint answers 401 without — and the manual lane was broken by the
      // act of saving it. Declaring the normalizer explicitly wins over the
      // derived one, and the stored value stays the whole paste for
      // normalizeOasisCookie to take apart at probe time.
      normalize: 'trim',
      // A manual token is a deliberate override, so it outranks the password
      // lane in the resolver. Clearing it hands control back to the login flow.
      //
      // `resolve` is `stepfunToken` and NOT `stepfunSession`: the framework hands
      // a resolver's return value straight back as this key's effective value
      // (currentAccountField), and then compares it against a string, so
      // returning the parsed pair here would put an object where a credential
      // belongs. The pair is assembled inside fetchStepfunLimits, which sees the
      // untouched paste and can take both halves out of it.
      //
      // There used to be a separate `stepfunWebid` field for the device id, and
      // it was a trap in three ways — it is declared as a text input, which this
      // form framework marks `secret: true` (accountPanels maps every non-select
      // field that way), so it alone satisfied credentialCommands' "at least one
      // secret holds something" floor and let "username alone" be saved as a
      // working login; it was re-masked on every save so the panel could never
      // read it back; and a token and a webid saved in separate actions can be a
      // rotation apart, which the endpoint rejects as a mismatched pair.
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
      {
        // The pasted Cookie header. BOTH halves of the pair live in this one
        // field: `oasis-webid` has to match the token or the endpoint answers
        // 401 "oasis-token is embezzled", and keeping them apart in the UI only
        // makes it possible to save one without the other.
        key: 'stepfunToken',
        input: 'textarea',
        labelKey: 'settings.stepfun.manualToken',
        placeholderKey: 'settings.stepfun.tokenPlaceholder',
        required: false
      },
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
    //
    // "Remember this login" is up here too, not down with the manual escape
    // hatch. It is a setting about the automatic login, so a user who cannot
    // find it under a heading about pasting tokens has no way to discover that
    // the option they want — do not log in again every launch — is a select
    // parked three rows under the diagnostic note.
    top: [
      { field: 'stepfunUsername' },
      { field: 'stepfunPassword' },
      { field: 'stepfunRememberLogin' }
    ],
    manual: [
      { steps: [
        'settings.stepfun.step1',
        ['settings.stepfun.step2Before', { code: 'QueryStepPlanRateLimit' }, 'settings.stepfun.step2After'],
        'settings.stepfun.step3',
        'settings.stepfun.step4'
      ] },
      { field: 'stepfunToken' },
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