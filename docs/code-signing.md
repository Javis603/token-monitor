# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Signed artifacts

The current release workflow Authenticode-signs Token Monitor's Windows application executable, installer (`Token-Monitor-Setup-*.exe`), and portable build (`Token-Monitor-*.exe`). The expected publisher is **SignPath Foundation**.

## Verify a download

In Windows Explorer, right-click the `.exe`, select **Properties**, then open **Digital Signatures**. The signer should be SignPath Foundation and Windows should report that the signature is valid.

You can also inspect both downloads in PowerShell:

```powershell
Get-AuthenticodeSignature ".\Token-Monitor-Setup-<version>.exe", ".\Token-Monitor-<version>.exe" | Format-List Path, Status, SignerCertificate, TimeStamperCertificate
```

A genuine Token Monitor release should show `Valid` status, SignPath Foundation as the signer, and timestamp information.

After installation, the same check can be run against `Token Monitor.exe` in the application's installation directory.

## Signing controls

- Signing requests originate from the repository's [release workflow](../.github/workflows/release.yml), which builds on GitHub-hosted runners.
- Every production signing request requires manual approval in SignPath.
- The version-controlled [application](../.github/signpath/application-artifact-configuration.xml) and [release artifact](../.github/signpath/artifact-configuration.xml) configurations restrict signed files by exact path, product name, and product version.
- The application executable is signed before packaging; the resulting installer and portable wrapper are signed afterward.
- Before publishing, the release workflow verifies all three signatures, their signer, and their timestamps.

## Team roles

- Committers and reviewers: [@Javis603](https://github.com/Javis603)
- Approvers: [@Javis603](https://github.com/Javis603)

## Privacy

- Privacy policy: [Token Monitor privacy policy](privacy.md)
