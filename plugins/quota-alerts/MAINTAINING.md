# Quota alerts maintenance

Javis603 maintains this adaptation. Original contribution and license provenance are documented in [NOTICE.md](NOTICE.md). Keep Matheus Rosendo's verified human co-author trailer on the implementation commit and squash; the verified source identity is `Matheus Rosendo <matheus.rosendo@my-oli.com>` from source commit `ba4e3c52ebe4b64136fdb086991b65bb412eccbc`. The prepared implementation/squash trailer is `Co-authored-by: Matheus Rosendo <matheus.rosendo@my-oli.com>`. Distribution notices remain required alongside Git credit.

## Build and focused checks

Use the repository's supported Node version and existing dependencies:

```sh
node --test --test-concurrency=2 tests/plugin-quota-alerts/*.test.js
node scripts/build-plugin-package.js plugins/quota-alerts /tmp/quota-alerts-0.1.0.tmplugin
```

The output archive must not already exist. List every distributed file in the manifest. `identityIcon` embeds the static 128 × 128 PNG in `assets/icon.png`; retain the editable `assets/icon.svg`. The original icon and source notices use the bundled MIT license.

## Host display dependencies

This candidate targets the current experimental `tmApi: 1` host with the accompanying metadata/data patches. The baseline checkout is `b3f633200b775389e92a418163efacde11c0ea08`; it does not include these uncommitted dependencies on its own. The optional `category: "automation"` identifies purpose and supplies the localized version-adjacent label without granting execution authority.

Formal limits rows provide `providerLabel` from the canonical App tool-name catalog and each window's `displayLabel` from the App's shared display helper. Preserve `provider` for identity/deduplication. Display names such as Codex, OpenCode, Session, Weekly, Monthly, 5-hour and explicit provider pool names remain consistent with the App, independently of the notification language. The original nullable window `label` and underlying wire data remain unchanged. The plugin imports no private host helpers and supports only this current data contract.

## Alert evaluation

The backend queries captured limits every five seconds while demanded and at least one alert type is selected. It performs no provider probes or direct network requests and reads no credentials. Snapshot freshness/coverage must be complete and fresh. Row status must be ok with a public account identity; missing percentages, readings older than 15 minutes and elapsed/invalid reset times cannot prove recovery. A reset countdown alone is never evidence of full quota.

Group duplicate provider/account rows before evaluating; use the lowest session percentage. Incomplete duplicates may warn about known low readings but cannot confirm recovery. Fresh complete observations must advance their timestamps; reordered/replayed observations cannot rearm or notify. Weekly/billing values supplement low notifications; recovery/full messages describe session windows only.

The two independent opt-ins are `lowQuota` and `recovery`, both off by default. Below-threshold crossings produce low events. A complete session reading crossing from below the threshold back to it or above produces restored; a reading rising from below 100 to exactly 100 produces full instead. Unrounded values decide the event. Notification percentages truncate to at most two decimals, so 99.999 cannot be described as 100%.

Recovery observations stay in memory. The first complete reading after backend start, source change or policy change establishes a silent baseline, preventing startup/re-enable full-quota spam. No catch-up recovery notification is promised while the backend is stopped. Persistent low-episode keys are saved before notification attempts; there is no automatic delivery retry. A policy change can rearm low warnings. Bound both low keys and recovery observations at 4096 and each scan at 4000 rows, failing visibly rather than dropping state.

## Settings and lifecycle

This is the initial unpublished 0.1.0 schema: `lowQuota`, `threshold`, `recovery`. There are no preview migrations, deprecated aliases or old-host fallbacks. Missing/unknown persisted fields fail visibly. Use a fresh disposable development profile rather than carrying incompatible settings forward. Successful saves are atomic with revision checks; failure restores confirmed UI values.

The settings-only UI has three controls and one manual desktop test button. Switches save immediately; threshold saves on blur/Enter. Enabling an alert type permits automatic desktop delivery without an extra test-mode switch. A manual test works with both automatic alert switches off, does not read quota data and never changes saved preferences, deduplication or recovery baselines. It uses localized test wording through formal `notify`. Development fixtures replace the host notification operation with mocks; the distributed plugin has no dry-run setting.

Use `background: true`, `defaults.background: true` and the six-language purpose text. The user confirms this suggestion; updates preserve their choice. Token Monitor must remain running. The plugin does not duplicate or hide the native background control. Source/preference changes fence pending work; source changes immediately clear old receipts/active output and recovery baselines. Disposal aborts pending delivery and timers. OS notifications already submitted cannot be recalled.

## Distribution and native acceptance

Rebuild `src/electron/plugins/catalog/quota-alerts.tmplugin` after changes; the official-catalog test checks source/archive equality. `readmes.json` selects all six plugin READMEs. Official identity comes from the bundled source. The unnumbered archive filename is independent of `manifest.id` and installation origin. Rollback restores code, not sent notifications or arbitrary data changes.

No final GUI screenshot or successful real notification delivery is claimed. The reported desktop-notification failure remains unresolved by mocks. Native Settings layout, Automation badge layout, notification permissions/display, background behavior, current-host GUI install/update, Windows/Linux and packaged-host operation still need acceptance. Add only real, current-package screenshots to the PR; the README can use one representative settings screenshot after verification. Text fixtures are not OS delivery evidence.

When the serialized GUI slot is available, from the primary checkout:

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-quota-alerts.cjs
```

The fixture uses one temporary profile/window, synthetic quotas and mocked notifications with blocked network. It exercises the production runtime/author adapter in a synthetic settings shell, writes to `artifacts/quota-alerts/0.1.0/`, removes its profile and exits. It does not prove the actual host catalog badge layout or real OS notification rendering. Do not stop unrelated App processes or run concurrent GUI suites.

Whole-window visuals, mobile push and guaranteed delivery are omitted. Recovery/full behavior is new plugin code; it was not copied from CodexBar. Do not claim complete PR #538 parity or close that PR based only on local checks.
