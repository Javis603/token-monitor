# iOS distribution

Use TestFlight for the first distribution, then submit the tested build to the App Store. The iOS version is independent of the Electron/Worker release. Do not run the desktop npm version/tag workflow to publish iOS.

This document describes preparation and local export. None of the commands below upload a build or publish a release.

## Current release decision

The extension currently compiles `Widgets/WidgetHostSurface.mm` into Release. It looks up private WidgetKit/CHS classes and replaces descriptor methods to force a transparent or material host in **full-color** Home Screen appearance. Its fallback does not remove those references from the binary. The archive verifier deliberately rejects this implementation.

Apple publicly supports Liquid Glass in the **system-selected Clear/Tinted appearance**, using `widgetRenderingMode`, `widgetAccentable(_:)`, image accented rendering and removable container backgrounds. That is a supported glass presentation, but it does not establish a public way to force this project's current full-color host treatment. A third-party app's appearance alone is not evidence that it uses the same private implementation.

Before distribution, choose the production Widget presentation and implement it with public API. Preserve widget kind identifiers when migrating already-placed widgets. Do not merely hide a setting, disable the bridge at runtime, or disguise private selector names. Inspect the final Release binary with the verifier after the change. The existing experimental appearance has deliberately not been changed as part of preparation.

Sources: [Apple's Widget Liquid Glass guidance](https://developer.apple.com/documentation/widgetkit/optimizing-your-widget-for-accented-rendering-mode-and-liquid-glass), [App Review Guidelines §2.5.1 and TestFlight §2.2](https://developer.apple.com/app-store/review/guidelines/).

## Freeze a candidate

1. Integrate current `main` into the iOS branch in isolation. Inspect Hub/Worker API and generated-build changes, then run `npm run verify` and native tests on the combined candidate. Regenerate shared Worker files and the Hub marker only when their source changes, following the repository guidance.
2. Review and push the intended iOS commits after approval. Uncommitted localization edits, screenshots, signing credentials and Xcode user state do not belong in the candidate automatically.
3. Freeze the commit SHA, iOS marketing version and build number. Use a new build number for the next App Store Connect upload. Keep the app and extension versions identical. Do not infer an available build number from the local project alone.

The source integration prepared on 2026-10-22 includes main `c83ee3aeb6d23505257113c29ef010040deb52f7`. This records the reviewed baseline only; resolve fresh remote SHAs and inspect subsequent changes before freezing an upload candidate.

## GitHub setup and delivery channels

Source, the Xcode project, privacy manifests, documentation and the unsigned iOS CI belong in this repository. Merging them does not require an App Store Connect account, Apple signing secrets or a GitHub Release. The root MIT license covers the iOS source; do not commit provisioning profiles or private keys.

After the workflow is pushed, check **Actions → iOS** on the PR. If branch rules require checks, select `build-and-test` only after it has run successfully; path-filtered workflows do not run on unrelated PRs, so a required check needs a matching ruleset strategy. No branch protection is changed by this preparation.

For the first beta, create the App Store Connect record and use Xcode Organizer for the reviewed signed build. GitHub Actions can later automate signed builds and App Store Connect uploads, or Xcode Cloud can perform that role; either needs a separately configured signing and credential flow. The existing Electron `v*` workflow publishes desktop installers only and must not be used as an iOS upload trigger. A GitHub Release or CI artifact is not a generally installable iPhone app.

## Signing and account setup

The existing project uses:

| Item | Identifier |
| --- | --- |
| App | `com.javis.tokenmonitor.ios` |
| Widget/Live Activity extension | `com.javis.tokenmonitor.ios.widgets` |
| Shared App Group | `group.com.javis.tokenmonitor.ios` |
| Configured team | `Z9JR236A9N` |

Confirm the owning paid Developer Program team, App Store Connect app record and identifiers. Both targets need the App Group capability and matching provisioning. The app needs Push Notifications for remote Live Activity updates. Release sets `APS_ENVIRONMENT=production`; Debug uses development. The exported distribution app's signed entitlement must agree with its production profile and the Hub's APNs environment.

Do not put certificates, `.p8` keys, provisioning profiles, Hub secrets or App Store Connect API keys into Git. Keep the APNs provider key on the selected Hub/Worker. Prefer Xcode's signing UI or the owner's established secure CI secrets when these credentials are needed.

`Config/ExportOptions.plist` is a **local export** template. Its destination is `export`, not `upload`; its team must match the final owner's setup. Automatic build-number management is disabled so the reviewed version/build remains explicit.

## Privacy and export compliance

`Config/PrivacyInfo.xcprivacy` declares this app's own preferences access to UserDefaults using `CA92.1`. Shared widget preferences are read from an App Group JSON file, not shared UserDefaults, so `1C8F.1` is not declared without an actual use. The extension has its own manifest because it is a separate bundle; its current source uses no required-reason UserDefaults API. Both manifests declare no tracking and no developer-collected data for the reviewed, self-hosted-Hub implementation. Re-audit if SDKs, analytics, managed hosting or networking destinations change. Required-reason declarations do not replace App Store Connect's privacy answers.

Data flow to review with the owner before publishing the privacy policy:

- The user selects a Hub; the app receives usage, costs, provider/account metadata, device information, history and session summaries from that Hub. It does not collect local tool logs, provider login credentials or session transcripts.
- The Hub URL/preferences stay on the device. The shared secret and pending Live Activity cleanup context use Keychain. Clearing the saved secret is an explicit operation; do not claim that uninstalling necessarily deletes Keychain items.
- Widgets read the App Group cache. Account email display labels are masked before that cache is written. The app can display account identity provided by the Hub.
- If remote Live Activities are enabled, their push token and the chosen source/account preferences are registered with the selected Hub, which sends updates through Apple Push Notification service.
- There is no analytics/advertising SDK or developer telemetry endpoint in the reviewed iOS source. A developer-operated review or production Hub would need its own data-retention and access policy and may change the store privacy answers.

Publish a real privacy-policy URL and support/contact URL, then expose the privacy policy inside the app. These public URLs and the owner's final App Store Connect privacy declaration are still pending. Answer export-compliance questions for the actual binary; current HTTPS/Keychain usage relies on OS encryption. `ITSAppUsesNonExemptEncryption` has deliberately not been guessed or pre-approved by this preparation.

Sources: [Required-reason API declarations](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api), [approved reason values](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons), [App privacy](https://developer.apple.com/help/app-store-connect/reference/app-information/app-privacy), [encryption export regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations).

## Local archive checks

Run from the repository root, choosing output paths outside the checkout. This first archive is unsigned and **cannot be uploaded**:

```sh
xcodebuild -project apps/ios/TokenMonitor.xcodeproj -scheme TokenMonitor \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath /private/tmp/token-monitor-ios-release-build \
  -archivePath /private/tmp/TokenMonitor-unsigned.xcarchive \
  CODE_SIGNING_ALLOWED=NO archive

python3 apps/ios/scripts/verify_release.py \
  /private/tmp/TokenMonitor-unsigned.xcarchive --allow-unsigned
```

The verifier checks the built device app and extension, bundled manifests, version parity, dSYMs and this project's known private WidgetKit markers. It must currently fail on the bridge until the production presentation decision is implemented. A passing scan is not an exhaustive private-API audit or App Review approval.

Once signing is configured and a candidate/version/build is frozen, create the signed archive with Xcode Organizer or:

```sh
xcodebuild -project apps/ios/TokenMonitor.xcodeproj -scheme TokenMonitor \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /private/tmp/TokenMonitor.xcarchive archive

python3 apps/ios/scripts/verify_release.py /private/tmp/TokenMonitor.xcarchive

xcodebuild -exportArchive -archivePath /private/tmp/TokenMonitor.xcarchive \
  -exportOptionsPlist apps/ios/Config/ExportOptions.plist \
  -exportPath /private/tmp/TokenMonitor-export
```

An Archive may be development-signed before export; final distribution signing belongs to the exported product. Unzip the exported IPA into a fresh directory, then check its `Payload/Token Monitor.app`:

```sh
python3 apps/ios/scripts/verify_release.py \
  '/private/tmp/TokenMonitor-export-unpacked/Payload/Token Monitor.app' --distribution
```

The distribution check also requires valid signatures, App Group entitlements, provisioning profiles, a distribution application identifier, disabled debugging entitlement and production APNs on the app. Do not use `--allow-unsigned` for that check. Use Xcode Organizer's Validate App before requesting upload approval.

## TestFlight acceptance and review access

Use the signed Release build on a physical iPhone. Check first launch/local-network permission, HTTPS and LAN Hub connection, invalid/changed secret, reconnect/offline/stale states, hidden/multiple provider accounts, every Widget size and system Clear/Tinted appearance, Lock Screen accessories, Dynamic Island and device restart. Test at least one supported iPad layout if iPad remains a target.

Verify production APNs with the app backgrounded and terminated, including a source/account change, stale expiry, disabling Live Activity and switching Hubs. A Simulator local Activity or a successful registration response is not proof of remote delivery. Keep the review Hub available throughout review and document the supported Hub build/protocol.

The Release build omits the `--sample-data` launch mode; Debug screenshots do not give App Review access. Prepare an isolated, public HTTPS review Hub with synthetic data and a dedicated read-only review credential, or explicitly implement and disclose a full review demo mode before submission. Never supply personal/provider credentials or production-user data.

Suggested beta test focus:

> Check usage, cost and quota readings against your Hub. Try multiple accounts, offline/reconnect behaviour, Home Screen widgets in each size and appearance, and Live Activities while the app is backgrounded. Report the device/OS, surface, selected provider/account and whether the source was stale.

Prepare App Store Connect name/subtitle/description, category, age-rating answers, supported languages, support/privacy URLs, feedback and review contacts, real Release screenshots, and review connection instructions. Only claim the final production Widget appearance and actually verified background-update behaviour.

After local validation and owner approval, upload through Organizer/Transporter, start internal TestFlight, then external testing (which can require Beta App Review), then submit the accepted build to App Review. Upload, tester invitations and App Store publication are separate owner actions; none have been authorized or performed by this preparation.

Sources: [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/), [TestFlight](https://developer.apple.com/testflight/), [App Review access requirements](https://developer.apple.com/app-store/review/guidelines/#before-you-submit).
