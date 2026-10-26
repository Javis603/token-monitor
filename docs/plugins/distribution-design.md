# Packages, trust and recovery

## Package format

A `.tmplugin` is JSON `{format:2, manifest, files}`. `files` maps each manifest-declared relative filename to base64 bytes. Maximum encoded envelope is 64 MiB; maximum manifest is 256 KiB. All files are explicit, including prebuilt dependencies. Path traversal, symlinks, case-insensitive collisions and file/directory-prefix collisions are rejected. Exact code/asset bytes, including UTF-8 BOM, survive packing and unpacking. Installing never executes dependency installation or package scripts.

The package SHA-256 verifies downloaded bytes. A separate canonical manifest-plus-exact-files digest identifies installed content, because serializing a directory does not reproduce arbitrary original envelope formatting. Neither hash proves code safety or identity. An installed package changed outside management is not accepted as a trusted rollback backup. Missing directories remain recoverable; symlink replacements remain rejected.

## Trust and activation

Install records the package but leaves it disabled. Enablement trusts the discovered content revision. An update or Reload with changed bytes requires a new explicit trust decision; version and id alone are insufficient. Optional `engines.tokenMonitor` and required `tmApi:2` identify compatibility. API 1 is rejected, not adapted.

There is no granular capability consent. UI can change the shared renderer; a Node backend can access local files, credentials, network and subprocesses available to the OS user. Display location and background toggles control lifecycle, not containment. The App continues protecting its ordinary external interfaces and renderer secret projections, but these are not a security barrier against trusted local code.

Executable updates, Reload, disable and removal warn about affected renderer reloads and possible unsaved state. A disabled backend loses demand and is stopped before package files move. The host requests cooperative cleanup, then terminates if needed. Arbitrary external side effects or child processes created by an unrestricted plugin are the author's responsibility; package rollback is not an OS transaction.

## Atomic management

The registry and prepared/committed journal remain authoritative. A prepared transaction recovers the previous package, registry, management settings and owned data copies. A committed transaction completes cleanup. Before replacement, the current managed directory and content digest are rechecked. Invalid registry/journal bytes block mutations and remain intact for diagnosis.

One verified previous compatible package is retained for rollback. Rollback swaps code; it does not reverse backend data migrations. Missing managed directories retain management-only entries, with rollback/uninstall available and execution forbidden. A corrupt existing package is rejected early with repair guidance; uninstall/reinstall with retention is the recovery route.

Uninstall can retain plugin data/preferences and display locations independently. Without retention, it removes the owned backend data directory, author settings and selected content replacements alongside ordinary placements. Files an unrestricted backend created elsewhere are not automatically discovered or deleted. Skin presets already applied are host snapshots; switching/resetting the App theme clears them.

## Catalogs

Discover combines the App-distributed offline official catalog with user-configured HTTPS catalogs. The official catalog is currently empty: no production example plugin ships. Only packages distributed with the App receive official attribution; this is provenance, not a safety guarantee. Official package updates arrive with an App update and use the same explicit preview, disabled installation, revision trust and rollback workflow. Install from file and folder remain available for private unpublished plugins. Catalog refresh and update preview do not execute code; installation is always explicit.

The existing catalog index schema, bounded downloads, source pins, package hashes and optional Ed25519 signatures remain. A source is a configured catalog URL, not a GitHub repository crawler. Source changes cannot silently replace another installation's origin. Community labels and author descriptions are publisher claims, never an audit badge. Experimental API compatibility is checked against the downloaded package before installation.

## Recovery outside the renderer

Use the native tray menu **Restart without plugins**, `--plugins-safe-mode`, or `TOKEN_MONITOR_PLUGINS_SAFE_MODE=1`. Safe mode enumerates and manages packages without loading their UI or backend. This is necessary because trusted same-page code can block its entire renderer. A package cannot be individually killed out of that shared JavaScript realm while preserving the rest of it. Safe mode does not undo arbitrary local changes previously made by code.
