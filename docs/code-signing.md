# Code Signing Policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org/).

## Certificate

- **Publisher:** SignPath Foundation
- **Signing method:** Authenticode, applied to both the Windows installer (`Token-Monitor-Setup-*.exe`) and portable build (`Token-Monitor-*.exe`)
- **Key custody:** the private key is generated and used inside SignPath's Hardware Security Module (HSM) and never leaves it — this repository, its CI, and its maintainers never have access to it

## How to verify

**Windows Explorer:** right-click either Windows `.exe` → Properties → Digital Signatures tab → the signer should be "SignPath Foundation".

**PowerShell:**

```powershell
Get-AuthenticodeSignature ".\Token-Monitor-Setup-<version>.exe", ".\Token-Monitor-<version>.exe" | Format-List
```

## Why SignPath Foundation

Token Monitor is a solo-maintained open-source project with no budget for a commercial EV code-signing certificate. [SignPath Foundation](https://signpath.org/) issues free certificates to eligible open-source projects, backed by the same HSM-custody and origin-verification guarantees as a commercial certificate.

## Build verification

Every signing request must originate from this repository's GitHub Actions workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)):

- SignPath verifies the request against GitHub's own record of the build (repository, workflow run, commit) — a request can't claim to be "from" this project unless GitHub itself confirms it.
- Every job in the workflow runs on GitHub-hosted runners, as required for SignPath Foundation's Open Source policy — none of the build steps run on self-hosted or third-party infrastructure.
- Signing requests against the production certificate require manual approval inside the SignPath UI before a build is actually signed (see [Team roles](#team-roles)).

The workflow submits both Windows executables together in one version-restricted archive. SignPath requires exactly one installer and one portable executable. CI then rejects missing or unexpected executables, regenerates the installer's differential-update metadata from the signed bytes, and verifies both Authenticode signatures before publishing.

The version-controlled SignPath artifact configuration is [`.github/signpath/artifact-configuration.xml`](../.github/signpath/artifact-configuration.xml). Its structure and the `initial` configuration in SignPath must remain identical.

## Team roles

Token Monitor is solo-maintained; the same person holds both roles today.

| Role | Person | Responsibility |
| --- | --- | --- |
| Committers and reviewers | [@Javis603](https://github.com/Javis603) | Writes and reviews the code and the release workflow |
| Approvers | [@Javis603](https://github.com/Javis603) | Approves each signing request in the SignPath UI |

## Privacy

Token Monitor processes usage logs locally and does not send analytics or telemetry to the project maintainer. Network requests are limited to documented product features such as update checks, public exchange-rate and service-status data, provider APIs enabled by the operator, and optional multi-device sync to an operator-configured hub. See the [Privacy section of the README](../README.md#privacy) for the complete disclosure, including the exact fields transmitted by optional sync and how third-party services are involved.

## Other platforms

| Platform | Status |
| --- | --- |
| Windows (installer) | Signed via SignPath Foundation |
| Windows (portable) | Signed via SignPath Foundation |
| macOS | Signed with an Apple Developer ID and notarized by Apple |
| Linux | Not signed (AppImage; mark it executable before running) |

## Reporting a concern

If you believe a Token Monitor build was tampered with, or you find a problem with how it's signed, please [open a GitHub issue](https://github.com/Javis603/token-monitor/issues/new).
