# Native quota modules and host connections

Quota modules are independent of plugin views. Declare once; the desktop host owns native rendering, sampling and account controls. A backend-only plugin is sufficient. Existing views, placements and their lifecycle remain available for other content. This is trusted OS-user code, not credential isolation against a malicious backend or same-user process.

```json
{
  "tmApi": 1,
  "id": "example-quota",
  "name": "Example quota",
  "version": "1.0.0",
  "backend": "backend.cjs",
  "files": ["backend.cjs"],
  "limits": [
    {"id": "credits", "name": "OpenAI", "connection": "openai"},
    {"id": "local", "name": "Local budget", "capabilities": ["cli"], "tags": [{"en": "Team pool", "zh-TW": "團隊共享"}]}
  ]
}
```

`limits` accepts up to 16 modules with unique IDs (`[a-z][a-z0-9-]{0,31}`) and localized names. The optional `connection` selects a host login adapter; currently only `openai` exists. A module without a connection can implement any other trusted backend data source without a core change. There is no arbitrary-site login API. Capability-derived **Limits** labels and type filters coexist with Widgets, Pages, Appearance and Automation; labels grant no authority.

The stable identity is `plugin:<plugin-id>:<module-id>`. Display names do not identify modules. The same identity must be used by every future native picker/composer and data consumer; no surface-specific registration, login or fetcher is needed. Removing or disabling a plugin removes its active modules, while display selection/order remain saved for re-enable/reinstall. Plugin execution/trust and module sampling/display checkboxes are independent. Native settings use the same right-side status pill as built-ins: missing readings wait for data; explicit `notConfigured` means not set up; `unauthorized` requests reconnect only for a declared host connection; errors mean a failed read. Healthy readings use the status dot without a duplicate connected pill. These are mutually exclusive states, not author-supplied badge text.

## Capability and custom labels

Each module optionally declares `capabilities` as a duplicate-free array of `api`, `apiKey`, `oauth`, `web`, `cli`. These describe supported source/connection methods, not the source of a particular reading. They grant no permissions and do not install or enable any connection adapter. `api` describes calling an API; `apiKey` describes key authentication. The host renders them in a stable order, combines multiple sources with `/`, and omits redundant `API` when `API key` is present. OpenAI's host adapter derives `web`, deduplicated against author declarations. Existing host translations apply, including “API 金鑰”. `Local`, `Desktop app`, `Manual`, `Manual login`, service categories and plan names are not fixed capability choices.

`tags` is an optional array of at most two author-written labels. Each accepts a plain string or the existing localized-string map, with at most 16 Unicode code points per localized value. Examples such as a team plan, relay service or a vendor-specific product name are entirely author text; the host does not maintain a list of selectable custom labels. The host localizes them with the normal plugin fallback and renders text in the existing badge style, after common sources. Custom text never selects a source, enables sampling, grants access or changes account status. Authors must not use these labels to imitate host account statuses or built-in source labels. There is no separate long-form “special capability description” underneath quota settings.

The host owns the `Auto` badge: it appears only while that selected module belongs to the native sampling runtime. Authors cannot declare `auto`, `manual` or account states as capabilities. Module labels remain available while unchecked; `Auto` disappears when sampling stops. Module enablement, visibility demand, connection state and plugin trust retain their existing independent behavior.

## Custom UI in each module's settings accordion

A module can set `settingsView` to the ID of one of the same plugin's declared views whose `surfaces` includes `settings`. This uses the existing trusted renderer UI and lifecycle, not a new renderer or backend. Modules without a custom view retain the host's account controls.

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

Authors own this area's DOM, layout, controls, explanatory content and handlers. The host keeps the outer module identity, selection, capability/status labels, ordering and account controls. Prefer existing native settings classes when appropriate. Use the existing `ctx.host.call('settings.get')` and revisioned `settings.update` for ordinary declared preferences; this is the same per-plugin store as the native plugin-management form. Multiple modules share that schema/store, so choose distinct declared fields where needed. A custom editor must report save failures and respect revision conflicts. Do not put secrets into ordinary preferences; host connection commands still never expose raw authorization to renderer code.

The view first mounts when its module is expanded in the visible quota settings section. Native row rebuilds, filtering, scrolling and collapse/reopen retain its controls and drafts. Collapsed, filtered, hidden-window or closed-settings mounts receive `visible: false` and stop requesting visible backend demand; authors must stop their own visibility-bound work. Reopening reuses the mount. Disable, uninstall, removed module/view and executable revision changes use the existing plugin cleanup and unsaved-work/recovery flow. A failed view remains contained by the existing UI host and does not replace the surrounding native module controls.

## Backend contract

```js
exports.activate = async ({ host }) => ({
  async call(method, { moduleId }) {
    if (method !== 'limits.collect') throw Error('Unknown operation');
    if (moduleId === 'local') return {status: 'ok', windows: [
      {kind: 'daily', usedPercent: 20, remainingPercent: 80}
    ]};
    const connection = await host.call('webSession.status', {key: moduleId});
    if (connection.state === 'notConnected') return {status: 'notConfigured', windows: []};
    const response = await host.call('webSession.request', {key: moduleId});
    // Parse response.body into quota windows before returning ok. This skeleton
    // has no parser yet; never infer prepaid balance from spending.
    const status = response.status === 200 ? 'unavailable'
      : [401, 403].includes(response.status) ? 'unauthorized'
      : response.status === 429 ? 'rateLimited' : 'error';
    return {status, windows: []};
  }
});
```

`limits.collect` returns `{status, windows, plan?}`; status is `ok`, `notConfigured`, `unauthorized`, `rateLimited`, `unavailable` or `error`. Up to 16 windows use the existing native window contract (`kind`, `label`, percentages, `used`, `limit`, `remaining`, `currency`, `resetsAt`, `boundaryKind`). Money uses `metric: 'credits'`; an expiry uses `boundaryKind: 'expiry'`, never an invented monthly reset. Unknown values remain unknown. A plan is optional and must describe a real plan. The host projects declared fields, not arbitrary backend data.

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

## Host-managed accounts

The module ID is also its connection ID within the plugin namespace. Backend-only operations are `webSession.connect/status/request/disconnect`, each with `{key: moduleId}`. The module must declare a supported `connection`. Renderer host calls cannot invoke these operations; native settings provide separate account commands returning only connection state. Raw bearer tokens, scope headers and cookies are never returned by the host account API.

OpenAI connection requires explicit host consent, opens an ephemeral isolated login window and captures authorization only after a successful exact GET to `https://api.openai.com/v1/dashboard/billing/credit_grants`, including its organization header. Requests use the injected desktop provider transport, honoring the current App/env/system proxy route, and that fixed URL with GET, cookies omitted, redirects refused, a 15-second timeout and a 256 KiB response cap. The ephemeral login session also applies and awaits the current App proxy and socket cleanup before opening the page; a failed setup aborts login without a direct-route fallback. Login times out after three minutes; closing it cancels. The host destroys the window and clears its ephemeral storage after completion/cancellation. Captured JWT expiry is a reconnect hint, not token verification: known-expired authorization is not sent. Opaque tokens have unknown expiry; HTTP 401/403 reports reconnect required through status. Native settings offer Connect, Connection status and Disconnect; successful login automatically refreshes connection status independently of quota sampling.

Records live under `userData/plugin-credentials`, keyed by plugin and connection identity, outside code, `plugin-data` and ordinary settings. Credentials are stored as ordinary private JSON, not encrypted. Reads and atomic writes reuse the same private-file helpers as the built-in Limits CredentialStore: regular files without symlink following, owner-only file permissions on POSIX, and private creation of the namespace directory. No keyring or Electron safeStorage API is required. This is the only supported storage format; there is no older-format reader, migration or optional encryption mode. Existing built-in `credentials.json` is separate and unchanged.

Disable/restart/update cancels login and outstanding host requests but retains private connection records. Cancelling a reconnect preserves a confirmed authorization rejection until replacement authorization is successfully saved. Disconnect removes only that connection and invalidates its module's captured quota, including while sampling is paused; sibling modules retain their readings. Uninstall removes all of that plugin's credentials even with keepData; other plugins remain untouched. The installed plugin card's **Remove saved plugin connections** also works for disabled, invalid or missing-code records without executing author code. Deleting saved connections is separate from deleting plugin data/placements; the existing uninstall choices still own those operations.

Real provider login and Windows/Linux native acceptance remain required before release. Synthetic account capture and private-file tests are not real-account acceptance.

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
