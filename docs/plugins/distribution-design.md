# Plugin pages and distribution contracts

Token Monitor supports main-App plugin pages, optional detached windows and managed package/catalog installation. Authors share packages directly or through HTTPS catalogs; publishing a package does not install or approve it for another user.

## Installation and page placement

1. The host validates the manifest, declared permissions and supported display locations.
2. A plugin may declare `surfaces: ["page"]` and optional `layouts.page`. Only explicitly enabled page placements appear in the main app’s view menu. A detached window is an optional action within that page. Main and detached page visibility share demand; neither grants arbitrary DOM or Node access.
3. Installation previews the exact package and requires confirmation. Installed code is disabled until approved; updates are confirmed even if their permissions do not change. A previous version is retained for rollback. Uninstall provides explicit data/placement retention choices. Directory import is available for authors.
4. Installed and Discover are the two primary tabs. Discover combines official and configured community entries with search and distinct source attribution. Install from file remains directly available; Advanced options (⋯) opens Custom catalog sources for source management, refresh/update checks and offline cache status. Refresh is explicit; there is no default scheduled updater.

## Package format

A `.tmplugin` file is a version-1 JSON envelope with a required manifest, optional bundled Worker JavaScript `code`, and optional `assets` for the manifest's declared Rich UI files. A declarative plugin needs no code or web assets. The package is data: parsing and validation do not execute it. Directory import and `scripts/build-plugin-package.js` produce the same representation.

Packages are limited to 4 MiB encoded, including a 256 KiB manifest, at most 2 MiB Worker code, and at most 1 MiB of decoded assets. Rich assets use canonical base64 values, with at most 64 files and 512 KiB per file. Asset paths must match the manifest and remain package-local; symlink escapes, conflicting names and undeclared files are rejected. See [the Rich UI asset contract](author-ui-options.md#original-pages) for formats and path rules. Worker imports and arbitrary host-file access are not supported. `semver` handles compatibility/version comparison; SHA-256 binds downloaded bytes to the catalog entry.

Managed installs record source id, exact version and SHA-256 beside local transaction metadata. Downloaded bytes must match the selected catalog digest before parsing. Updates stage and validate completely, stop/flush the current owner, preserve a recoverable previous version, atomically switch directories and reload. Failed switching restores the old directory and state; a prepared/committed journal recovers process-interrupted operations at startup. Rollback preserves data but warns that application-specific data migrations cannot be automatically reversed by the host. Uninstall never silently deletes user data.

## Source trust

The user flow is browse → inspect source and permissions → install. A public key is optional; source labels and permission approval remain separate.

- App-shipped catalog entries alone get the Official source label. Community sources do not make their authors official or guarantee safety.
- An advanced source manager accepts HTTPS catalog URLs, clearly labelled Community / Unreviewed. Optional pinned signatures can strengthen source identity without becoming a mandatory installation step. Community sources are added explicitly by the user.
- Every manual install/update confirms the exact source and version. Existing permission grants survive updates; additional permissions or destinations require renewed consent before execution. No automatic update policy is enabled implicitly.
- Local packages are unverified. SHA-256 detects content mismatch; it does not establish publisher identity or prove safe code. Labels come from host-owned source records, never package claims.
- The app ships an offline browsable official catalog containing real bundled examples. Discover includes configured community entries alongside the bundled catalog; adding a source is optional.
- Authors choose where to host packages and catalogs. The App does not provide a submission backend, ratings or moderation service.

## Persistence and recovery bounds

Registry reads and writes share a 1 MB limit; the journal uses 2 MB. Next registry and journal payloads are bounded before replacement. Capacity failure leaves the prior installation intact. The journal file is fsynced, but directory/staged-file power-loss durability is not guaranteed; only process termination recovery has been exercised.

Backups may read a formerly compatible installed version after the host upgrades. A rollback target must itself satisfy current compatibility. Uninstall skips current package parsing; rescue rollback tolerates a corrupt current package and drops the unusable reverse backup. A wholly missing package remains listed in Installed for verified rollback or removal, without execution controls; a newer same-source update can also restore it. Update discovery uses the managed installed version when runtime discovery is invalid, but an existing damaged or modified package cannot be updated because it cannot supply a trustworthy reverse backup. Preview rejects it with recovery guidance, and confirmation rechecks the current package. Use a saved rollback when available, or uninstall and reinstall with the data and placement retention options selected.

Managed installs store a versioned content fingerprint separately from the original archive SHA-256. It covers the raw manifest (ignoring JSON formatting and object-key order), entry code (preserving any leading UTF-8 BOM) and declared asset bytes; preview and confirmation compare it before retaining a reverse backup. It is computed only during package management, not on every runtime discovery. Legacy records without a fingerprint remain manageable but cannot supply a trusted reverse backup: an existing directory requires verified rollback or uninstall/reinstall, while a missing-directory update remains supported. A successful install or rollback establishes the fingerprint from the accepted package, never from unchecked live files. Saved rollback archives retain their existing byte-hash verification; this cannot retroactively prove that a backup created by an older manager was originally unmodified. These checks detect drift relative to local metadata, not an attacker able to rewrite both the package and its registry. Unmanaged authoring folders remain editable.

Source and package URLs are bounded after URL normalization, before persistence. Ordinary sources are HTTPS, credential-free, fragment-free and limited to 2048 normalized characters. Downloads omit cookies, reject redirects, and enforce streamed byte/time limits. Good cache survives a refresh failure; source removal aborts downloads and invalidates pending previews.

## Catalog v1

```json
{
  "format": 1,
  "title": "Example community catalog",
  "plugins": [{
    "id": "example-plugin",
    "name": "Example plugin",
    "author": "Example author",
    "versions": [{
      "version": "1.0.0",
      "types": ["page"],
      "url": "https://example.com/example.tmplugin",
      "sha256": "replace-with-the-64-character-sha256-of-the-exact-package",
      "engines": { "tokenMonitor": ">=0.76.0" },
      "changelog": "Release description"
    }]
  }]
}
```

Each version may advertise optional `types`: `widget`, `page`, `appearance`. Unknown values are ignored; omitted metadata has no label. These are unreviewed display hints, not capabilities or trust markers. Package previews and installed entries derive labels from the validated manifest: Home/tray/Edge Dock/Notch views are Widgets; page views and model/tool/device page extensions are Pages; skins are Appearance. Settings documents and background code alone imply none of these labels. Multiple labels are allowed.

This is schema documentation, not an enrolled source. The digest placeholder must be replaced by the builder's digest. Limits are 16 sources, 128 plugin entries per index, 32 versions per plugin, 1 MB downloaded index and 4 MiB package. For an optional pinned source, serve `{ "payload": "base64 of exact catalog JSON bytes", "signature": "base64 Ed25519 signature over those bytes" }`; the user-provided PEM key verifies identity, not safety or review status.
