# Native quota modules and manual credentials

Quota modules are independent of plugin views. Declare once; the desktop host owns native rendering, sampling and settings lifecycle. A backend-only plugin is sufficient. Existing views, placements and their lifecycle remain available for other content. This is trusted OS-user code, not credential isolation against a malicious backend or same-user process.

```json
{
  "tmApi": 1,
  "id": "example-quota",
  "name": "Example quota",
  "version": "1.0.0",
  "backend": "backend.cjs",
  "files": ["backend.cjs"],
  "limits": [
    {"id": "credits", "name": "OpenAI", "capabilities": ["web"], "credentials": {"validation": true, "fields": [{"id": "sessionBearer", "label": "Platform session Bearer", "required": true}, {"id": "organization", "label": "Organization ID", "required": true}]}},
    {"id": "local", "name": "Local budget", "capabilities": ["cli"], "tags": [{"en": "Team pool", "zh-TW": "團隊共享"}]}
  ]
}
```

`limits` accepts up to 16 modules with unique IDs (`[a-z][a-z0-9-]{0,31}`) and localized names. Modules can declare manual `credentials` independently of `settingsView`. There is no browser login adapter or login-window API. A module without credentials can implement another trusted backend data source without a core change. Capability-derived **Limits** labels and type filters coexist with Widgets, Pages, Appearance and Automation; labels grant no authority.

The validated plugin `identityIcon`, when declared, is also used by its native Limits modules. Decode failures use the existing fallback; provider names are never matched to a built-in icon whitelist.

The stable identity is `plugin:<plugin-id>:<module-id>`. Display names do not identify modules. The same identity must be used by every future native picker/composer and data consumer; no surface-specific registration, login or fetcher is needed. Removing or disabling a plugin removes its active modules, while display selection/order remain saved for re-enable/reinstall. Plugin execution/trust and module sampling/display checkboxes are independent. Native settings use the same right-side status pill as built-ins: missing readings wait for data; explicit `notConfigured` means not set up; `unauthorized` marks declared credentials as rejected; errors mean a failed read. Healthy readings use the status dot without a duplicate connected pill. These are mutually exclusive states, not author-supplied badge text.

## Capability and custom labels

Each module optionally declares `capabilities` as a duplicate-free array of `api`, `apiKey`, `oauth`, `web`, `cli`. These describe supported source/connection methods, not the source of a particular reading. They grant no permissions and do not install or enable any connection adapter. `api` describes calling an API; `apiKey` describes key authentication. The host renders them in a stable order, combines multiple sources with `/`, and omits redundant `API` when `API key` is present. Existing host translations apply, including “API 金鑰”. `Local`, `Desktop app`, `Manual`, `Manual login`, service categories and plan names are not fixed capability choices.

`tags` is an optional array of at most two author-written labels. Each accepts a plain string or the existing localized-string map, with at most 16 Unicode code points per localized value. Examples such as a team plan, relay service or a vendor-specific product name are entirely author text; the host does not maintain a list of selectable custom labels. The host localizes them with the normal plugin fallback and renders text in the existing badge style, after common sources. Custom text never selects a source, enables sampling, grants access or changes account status. Authors must not use these labels to imitate host account statuses or built-in source labels. There is no separate long-form “special capability description” underneath quota settings.

The host owns the `Auto` badge: it appears only while that selected module belongs to the native sampling runtime. Authors cannot declare `auto`, `manual` or account states as capabilities. Module labels remain available while unchecked; `Auto` disappears when sampling stops. Module enablement, visibility demand, connection state and plugin trust retain their existing independent behavior.

## Custom UI in each module's settings accordion

A module can set `settingsView` to the ID of one of the same plugin's declared views whose `surfaces` includes `settings`. This uses the existing trusted renderer UI and lifecycle, not a new renderer or backend. Modules with credential declarations and no custom view receive the shared native credential form. A custom view receives no automatically appended account controls.

```json
{
  "ui": "settings.mjs",
  "views": [{"id": "credit-options", "title": "Credit settings", "surfaces": ["settings"]}],
  "limits": [{"id": "credits", "name": "Credits", "settingsView": "credit-options"}]
}
```

Merge this into a complete manifest and include `settings.mjs` in `files`. The referenced view must be declared locally; cross-plugin references and views without the settings surface are rejected. The same settings view can serve several modules. Its mount context includes `moduleId` (author module ID), `moduleRef` (stable namespaced identity), `surface: 'settings'` and `surfaceVariant: 'limits-settings'`. Use `moduleId` to select the relevant editor. Views also shown in plugin details have their normal settings context and may have no module ID; feature-detect it.

```js
export function activate(ctx) {
  return {
    mount(container, context) {
      const input = document.createElement('input');
      input.placeholder = context.moduleId === 'credits' ? 'Display preference' : 'Preference';
      container.append(input);
      return {
        update(next) { /* Honor next.visible; reconcile data without replacing drafts. */ },
        hasUnsavedChanges() { return input.value.length > 0; },
        dispose() { container.replaceChildren(); }
      };
    }
  };
}
```

Authors own this area's DOM, layout, controls, explanatory content and handlers. The host keeps the outer module identity, selection, capability/status labels, ordering and lifecycle. Prefer existing native settings classes when appropriate. Use the existing `ctx.host.call('settings.get')` and revisioned `settings.update` for ordinary declared preferences; this is the same per-plugin store as the native plugin-management form. Multiple modules share that schema/store, so choose distinct declared fields where needed. A custom editor must report save failures and respect revision conflicts. Do not put secrets into ordinary preferences; saved credential values are available only through the backend credential API.

The view first mounts when its module is expanded in the visible quota settings section. Native row rebuilds, filtering, scrolling and collapse/reopen retain its controls and drafts. Collapsed, filtered, hidden-window or closed-settings mounts receive `visible: false` and stop requesting visible backend demand; authors must stop their own visibility-bound work. Reopening reuses the mount. Disable, uninstall, removed module/view and executable revision changes use the existing plugin cleanup and unsaved-work/recovery flow. A failed view remains contained by the existing UI host and does not replace the surrounding native module controls.

## Backend contract

```js
exports.activate = async ({ host }) => ({
  async call(method, { moduleId }) {
    if (method !== 'limits.collect') throw Error('Unknown operation');
    if (moduleId === 'local') return {status: 'ok', windows: [
      {kind: 'daily', usedPercent: 20, remainingPercent: 80}
    ]};
    const saved = await host.call('credentials.status', {moduleId});
    if (!saved.configured) return {status: 'notConfigured', windows: []};
    const {sessionBearer, organization} = await host.call('credentials.read', {moduleId});
    const response = await host.call('network.request', {
      moduleId, requestId: 'quota', url: 'https://example.com/quota',
      headers: {Authorization: `Bearer ${sessionBearer}`, 'X-Organization': organization}
    });
    // Parse response.body (text) before returning quota windows. Presence alone
    // is not server validation; never infer prepaid balance from spending.
    const status = response.status === 200 ? 'unavailable'
      : [401, 403].includes(response.status) ? 'unauthorized'
      : response.status === 429 ? 'rateLimited' : 'error';
    return {status, windows: []};
  }
});
```

`limits.collect` returns `{status, windows, plan?}`; status is `ok`, `notConfigured`, `unauthorized`, `rateLimited`, `unavailable` or `error`. Up to 16 windows use the existing native window contract (`kind`, `label`, percentages, `used`, `limit`, `remaining`, `currency`, `resetsAt`, `boundaryKind`). Money uses `metric: 'credits'`; an expiry uses `boundaryKind: 'expiry'`, never an invented monthly reset. Unknown values remain unknown. A plan is optional and must describe a real plan. The host projects declared fields, not arbitrary backend data.

For non-credit percentage windows, provide `usedPercent` or numeric `used` and a positive `limit`. A standalone `remainingPercent` is not a normalization input; if that is all the service supplies, derive `usedPercent = 100 - remainingPercent` before returning the window.

### Credit presentation

Credit windows can opt into desktop presentation with `creditsDisplay: 'percent'` or `'balance'`. Omission preserves the existing money headline and meter behavior. `balance` shows the remaining money without a meter. `percent` uses the native percentage headline and bar, with expiry/reset on the lower left and money / total on the lower right. Percentage, bar and money numerator follow the App's global used/remaining mode together. This option is projected by the desktop quota registry, not added to Hub wire data.

```js
return {status: 'ok', windows: [{
  kind: 'billing', label: 'API credits', metric: 'credits',
  creditsDisplay: 'percent', remaining: 83.25, limit: 100, currency: 'USD',
  boundaryKind: 'expiry', resetsAt: expiryIso
}]};
```

For a module named `OpenAI`, this shows `API credits` / `83% left`, a native bar, then `Expires …` / `$83.25 / $100.00`. Used mode shows `17% used` and `$16.75 / $100.00`. These are synthetic example values. Omit `plan` when no actual plan is known; do not use a plugin label as a plan.

For percent mode, `limit` must be a finite, positive, real allowance and `remaining` must lie between zero and that allowance. The host derives both percentages and the used-money numerator from these amounts, ignoring supplied percentages. It never infers a denominator from observed spend or lifetime grants. Authors must supply only a reconciled applicable total. Unknown, zero, negative or inconsistent totals fall back to the true remaining balance without a percentage, meter or ratio; zero remaining with a positive total is a valid 0% left / 100% used reading. `showMeter: false` also selects this fallback. Use `limit: null` when unknown. The expiry boundary remains an expiry in either layout.

`host.call('limits.read')` returns captured `{modules, providers}` from this desktop registry without starting collection. This formal read is available to active plugin UI/backends; it contains no credentials. Native consumers use the same runtime service, independent of the selected Hub data source. Plugin quota records do not enter DeviceRecord, Hub/Worker wire data, iCloud sync, quota history or alerts in this phase.

Sampling reuses `LimitsRuntime`: fixed/adaptive scheduling, bounded concurrency, finite deadlines, last-good/attempt retention, retry cooldowns and latest-wins cancellation. Only enabled selected modules with native visibility demand sample. The initial main Limits owner releases demand while Settings overlays it, while collapsed into Floating Bubble, or while the native window/document is hidden. Settings retains captured readings without quota polling; reopening visible main Limits resumes sampling. Local token usage does not request a refresh. Multiple native owners share the registry/runtime; the initial owner is the main Limits view. The last owner leaving stops scheduling and fences late data; a later reveal starts a fresh sample. Backend calls retain the existing manager's finite deadline and process lifetime rules.

## Manual credential contract

`limits[].credentials` declares `{fields: [...], validation?: boolean}` with 1–16 unique fields. Each field has `id` (`[a-z][a-zA-Z0-9-]{0,39}`), a localized `label`, optional `required` boolean (default false), and `control: 'input' | 'textarea'` (default input). Single-line native controls mask typed text; textarea supports cookies or other long content. All declared values are private credentials, including organization IDs. General select/preferences use the existing ordinary settings schema and API.

All calls derive the plugin ID from the host context; callers supply only their declared `moduleId`. The same module namespace serves every surface and all three UI choices:

- `credentials.status({moduleId})` returns `{revision, configured, fields, declaration, verification}`. `fields` maps each declared field ID to a presence boolean; `declaration` contains public field metadata. `configured` means at least one value exists and all required fields are present, **not** that a service has accepted them.
- `credentials.update({moduleId, expectedRevision, patch})` validates and atomically saves submitted strings, returning status only. Omitted fields retain their saved values. Explicit empty required values fail; explicit empty optional values remove that field. Partial saves are allowed; `configured` stays false until all required fields are present. An explicitly submitted empty required value is still rejected. Each string is bounded to 16,384 characters and each record to 64 KiB. No silent trimming, parsing or guessed authentication mode occurs.
- `credentials.clear({moduleId, expectedRevision})` removes that module's values and returns status. An empty revision record remains to reject stale editors; it contains no credentials. Update and clear require the exact current revision. `credentials-conflict` is never silently retried.
- `credentials.read({moduleId, expectedRevision?})` returns a map of saved declared values **to the Node backend only**. Renderer host calls are explicitly denied. Validators pass `expectedRevision` so a concurrent replacement fails with `credentials-conflict` before reading values. The host's settings, catalog and stats projections contain no saved credential values. Trusted backend code can deliberately relay data, so this is an API discipline, not a secret sandbox.

Without `settingsView`, the host mounts the native form through the existing UI lifecycle. With `settingsView`, authors choose their entire layout and may mount the same form wherever it belongs:

```js
export function activate(ctx) {
  return {
    async mount(container, context) {
      const help = document.createElement('p');
      help.textContent = context.moduleId
        ? 'Paste the credentials required by this service.'
        : 'Open AI tool quota settings to edit module credentials.';
      container.append(help);
      const editor = context.moduleId
        ? await ctx.native.credentials.mount(container, {
          moduleId: context.moduleId,
          onStateChange(state) { help.hidden = !state.editing; }
        })
        : null;
      return {
        update: value => editor?.update(value),
        hasUnsavedChanges: () => editor?.hasUnsavedChanges() === true,
        dispose() { editor?.dispose(); help.remove(); }
      };
    }
  };
}
```

The helper returns `update(context)`, `hasUnsavedChanges()` and `dispose()`. Forward these through the author view's lifecycle. It loads presence only, distinguishes untouched inputs from explicit edits, clears input only after successful save, retains drafts on failure, and preserves its base revision while dirty. After a conflict, **Reload saved status** explicitly adopts the current revision while retaining input; the user can then decide to save again. Custom DOM may call the same status/update/clear API directly; authors own validation buttons, explanatory content and service validity feedback. Do not reinsert saved secrets into renderer controls. No fixed Connect/Status/Disconnect UI is appended.

### Verification and shared summary/editor state

Opt into `credentials.validation: true` when the backend implements the explicit validation operation below. Without this declaration the host never invents connected status or calls a missing validator. `verification` is one of `unverified`, `verifying`, `valid`, `rejected`, `expired`, `unavailable`, independent of `configured`/field presence.

```js
// Inside the backend call dispatcher:
if (method === 'credentials.validate') {
  const {moduleId, revision} = args;
  const values = await host.call('credentials.read', {moduleId, expectedRevision: revision});
  // Use network.request and the service's actual authentication check here.
  // Return valid only after a successful server authentication response.
  const response = await host.call('network.request', {
    moduleId, requestId: 'credential-check', url: validationUrl,
    headers: {Authorization: `Bearer ${values.sessionBearer}`}
  });
  return {status: response.status === 200 ? 'valid'
    : [401, 403].includes(response.status) ? 'rejected' : 'unavailable'};
}
```

Return `{status: 'valid' | 'rejected' | 'expired' | 'unavailable'}` without secrets or service error bodies. The host owns state and accepts the result only for the unchanged saved credential revision and active executable revision. Update, clear, disable/re-enable, restart and code update fence old results. Verification is an in-memory last explicit check, not a permanent promise of server validity; app/runtime restart returns to unverified. Ordinary quota readings never mark credentials valid. An `unauthorized` quota attempt for the unchanged credential revision can mark it rejected; stale attempts from older revisions are ignored. Authors should classify known expiry in their validation operation.

`credentials.verify({moduleId, expectedRevision})` is available to custom UI/backends; it performs this one explicit backend call and returns the updated status. It requires complete saved credentials and the current revision. The native helper automatically verifies after a successful complete save when declared; otherwise the user can explicitly verify. This does not enable quota demand or introduce Settings polling. Use `network.request` for the probe so host proxy/cancellation policy applies. Direct custom UI must respect the same revision/conflict semantics.

The shared helper initially expands empty, partially saved or unverified credentials. Successful validation switches to a compact **Connected** summary. **Change credentials** explicitly opens editing without loading saved values; pushes do not interrupt deliberate editing or dirty drafts. **Cancel editing** discards only the draft, rereads presence/status and returns to a summary when any saved field exists. Save failures retain drafts; a failed validation keeps the saved credentials and shows its honest status. Clear appears only when `fields` contains a saved value, including partial/rejected/expired records; unsaved input alone does not count. Clear returns to the empty editor.

`mount(container, {moduleId, onStateChange?})` calls `onStateChange` after its state transitions, including the initial state. The public DTO is `{editing, hasSaved, configured, verification, pending, revision}`; it never includes raw values. Use `editing` to show/hide author instructions, as in the example above. Forward `update(context)` on host view updates and `dispose()` on cleanup; do not inspect private DOM or add a status polling loop. The callback is for presenting local UI, not starting another verification/refresh on every push.

### Backend network requests

`network.request({moduleId, requestId, url, method?, headers?, body?, timeoutMs?})` is backend-only and uses the host's injected provider transport, preserving App → environment → system proxy policy. The author owns the URL, credentials, headers and response parser. HTTP(S) URLs without embedded user/password are accepted; `Host` is rejected, cookies from browser storage are omitted, redirects fail, and cache is disabled. Supported methods are GET/HEAD/POST/PUT/PATCH/DELETE; body is optional text up to 256 KiB, headers up to 32 KiB. GET/HEAD cannot have a body. `timeoutMs` defaults to 15 seconds and must be 1–30,000. Response is `{status, headers, body}` with text body capped at 1 MiB. Non-2xx status is returned for author interpretation; transport failures use sanitized error codes. For Chromium, the existing cross-origin Referer limitation still applies.

`requestId` is a module-local concurrent request key (1–64 ASCII letters/digits/hyphens). Duplicate active IDs fail. `network.cancel({moduleId, requestId})` aborts only that module's matching request. Backend stop, disable, update, restart and uninstall cancel owned in-flight host requests; quota demand cancellation aborts requests for the sampled module; credential update/clear cancels the affected module. These APIs are convenience/lifecycle contracts for trusted Node plugins, not network permissions or a sandbox. They never perform browser login or capture authorization.

### Storage and cleanup

Host-owned records live in `userData/plugin-credentials/`, separated by exact plugin ID and a module-ID hash. They use the existing private-file/atomic JSON helpers: POSIX `0600` files and private directories, Windows userData permissions. Files are **not encrypted** and remain accessible to same-user code. They never enter ordinary plugin data/settings, code directories, built-in `credentials.json`, Hub wire or sync. No safeStorage, keyring, optional encryption or legacy-record reader is involved.

Disable/update cancels requests and retains saved credentials. Credential update/clear invalidates only the corresponding module's captured quota, including paused retained readings; siblings retain theirs. Uninstall removes all of the plugin's credential records even with keepData. The plugin details management area's **Clear saved plugin credentials** asks for confirmation and also handles disabled, invalid and missing-code records without executing author code. Other plugins and built-in credentials are untouched.

This unpublished experimental API intentionally replaces `connection: 'openai'` and `webSession.*` without aliases or migration. Plugins using that old contract, including OpenAI 0.2.0, must be updated before use. Existing old records on disk are not read, converted or proactively cleaned. Real service credentials and Windows/Linux native acceptance remain unverified; synthetic tests do not establish provider login validity.

## Native surface rollout

| Existing surface / entry point | This phase | Follow-up connection |
| --- | --- | --- |
| Main Limits, `app.js:renderLimits` | Native records and mixed built-in/module order | Same registry |
| AI tool quota settings, `renderLimitProviderCheckboxes` | Search, checkbox, disclosure, drag/keyboard mixed ordering, account controls | Same identity/preferences |
| Home quota overview, `homeOverview.js`, Home provider choices in `app.js` | Built-ins only | Project registry records into existing overview/order picker |
| Main window responsive sidebar layout, `styles.css` / `app.js` | Main Limits works in the same responsive window; no separate sidebar provider registry | Reuse native records; test compact/short-window visibility before wider rollout |
| Main window navigation/content, `pluginMainPages.js`, `main.navigation.content` outlets | Existing plugin views only | Keep navigation distinct from Edge Dock; quota selection should reference modules, not duplicate backends |
| Screen-edge rail and retained card, `edgeDock/composer.js`, `items.js`, native `cardWindow` | Built-ins and existing plugin views | Add module references to the native item composer and card demand |
| Notch pages and provider choices, `notch/pageSettings.js`, `panel.js` | Built-ins and existing plugin views | Reference shared module identity in quota pages |
| Notch summary/custom bitmap, `trayComposer.js`, `notchCustomLayout` | Existing composer behavior | Use shared records and independent summary visibility demand |
| System Tray and Floating Bubble, `trayComposer.js`, `trayBars.js`, custom layouts | Existing composer behavior | Add native quota module references to existing pickers and modes |
| Home provider selectors, subscriptions, history, alerts | Built-ins only | Review each consumer's semantics before admission |

The user's “sidebar” is not presumed to mean Edge Dock: main navigation/content and the screen-edge rail/card are separate owners. These follow-ups are planned integration points, not supported quota surfaces today. They must union visibility demand and share accounts/data instead of requiring per-page login or author-rendered quota DOM.
