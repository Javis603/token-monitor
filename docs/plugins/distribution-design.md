# Packages, trust and recovery

For release naming, GitHub discovery, README presentation and an author checklist, see the [publishing guide](publishing.md).

## Package format

A `.tmplugin` is JSON `{format:2, manifest, files}`. `files` maps each manifest-declared relative filename to base64 bytes. Maximum encoded envelope is 64 MiB; maximum manifest is 256 KiB. All files are explicit, including prebuilt dependencies. Path traversal, symlinks, case-insensitive collisions and file/directory-prefix collisions are rejected. Exact code/asset bytes, including UTF-8 BOM, survive packing and unpacking. Installing never executes dependency installation or package scripts.

The package SHA-256 verifies downloaded bytes. A separate canonical manifest-plus-exact-files digest identifies installed content, because serializing a directory does not reproduce arbitrary original envelope formatting. Neither hash proves code safety or identity. An installed package changed outside management is not accepted as a trusted rollback backup. Missing directories remain recoverable; symlink replacements remain rejected.

## Trust and activation

The package preview approves the exact content revision and can enable it in one transaction with the confirmed first-use settings for locations, content sources, background execution and appearance. Author suggestions are preselected for review; install-only retains them for first enable. Existing user choices are preserved on updates. Official packages use Install and enable / Update, with a short explanation of the resulting enabled state. Other sources use Trust, install and enable / Trust and update and display the third-party code warning. These labels share the same revision approval and integrity checks; official attribution does not grant automatic execution. Install only records the package disabled and untrusted. When the master switch is off or safe mode is active, installation remains disabled and untrusted. An update or Reload with changed bytes requires a new explicit decision; version and id alone are insufficient. Optional `engines.tokenMonitor` and required `tmApi:1` identify compatibility. Other `tmApi` values are rejected, not adapted.

There is no granular capability consent. UI can change the shared renderer; a Node backend can access local files, credentials, network and subprocesses available to the OS user. Display location and background toggles control lifecycle, not containment. The App continues protecting its ordinary external interfaces and renderer secret projections, but these are not a security barrier against trusted local code.

Package updates and removal cooperatively release affected UI before moving files. The package review’s explicit update action approves only the previewed content revision and preserves enabled/background choices; disabled plugins remain off. Unsaved mounts prompt first. Discovery Reload and rollback still warn before reloading affected hosts. Normal disable preserves revision trust and cooperatively releases only that plugin; re-enabling unchanged code does not ask for trust again. Unsaved mounts prompt before disable. Failed cleanup leaves the plugin disabled and offers affected-window recovery; declining recovery does not re-enable partially disposed code. A disabled backend loses demand and is stopped before package files move. The host requests cooperative cleanup, then terminates if needed. Arbitrary external side effects or child processes created by an unrestricted plugin are the author's responsibility; package rollback is not an OS transaction.

## Updates, rollback and uninstall

Transactions pause and rediscover only their target plugin, including during rollback; unrelated mounts, drafts and backends stay live. An explicit discovery Reload remains a full reload.

One verified previous compatible package is retained for rollback. Rollback swaps code; it does not reverse backend data migrations. Missing managed directories retain management-only entries, with rollback/uninstall available and execution forbidden. A corrupt existing package is rejected early with repair guidance; uninstall/reinstall with retention is the recovery route.

Uninstall can retain plugin data/preferences and display locations independently. Without retention, it removes the owned backend data directory, author settings and selected content replacements alongside ordinary placements. Files an unrestricted backend created elsewhere are not automatically discovered or deleted. Skin presets already applied are host snapshots; switching/resetting the App theme clears them.

## Catalogs

Discover shows one Featured plugins group: official catalogs/packages first, then App-designated maintainer catalogs branded Token Monitor Community. Both brands show a shield identifying distribution provenance, not a safety audit. Their package actions use the simplified Install and enable / Update flow with the same exact-revision approval underneath. Other HTTPS catalogs stay in Custom sources and retain the third-party trust warning. In-app GitHub discovery is not yet available; when available, its separate Unofficial plugins · GitHub group shows repository owners without a shield.

Featured placement and official attribution are host-assigned, not catalog fields authors can request. Custom URLs, author/title metadata and signing keys do not grant featured status. The App designates its official remote catalog separately from the community catalog. Both use the same package validation, compatibility, preview and same-source update checks. Compatible official plugin updates do not require an App update; users still explicitly choose and approve installation. Offline bundled packages, when present, update with the App.

Install from file and folder remains available for private unpublished plugins. Catalog refresh and update preview do not execute code; installation is always explicit. The collapsed Plugins settings summary shows compatible updates from the installation's existing source, even while plugins are disabled. It reads local catalog state at startup and after catalog changes; it does not install updates automatically or introduce remote polling.

Catalogs use bounded downloads, source pins, package hashes and optional Ed25519 signatures. A source is a configured catalog URL, not a GitHub repository crawler. Source changes cannot silently replace another installation's origin. Community labels and author descriptions are publisher claims, never an audit badge. Experimental API compatibility is checked against the downloaded package before installation.

## Official catalog releases

Official plugin source stays in this repository under `plugins/`. The App's designated source is `https://raw.githubusercontent.com/Javis603/token-monitor/dist/catalog.json`; the community catalog remains in `token-monitor-plugins`. Source branding is assigned by the App, independently of catalog titles or manifest authors.

The **Publish official plugins** workflow validates and packages changes on pull requests. Only its main-branch publish job has write permission and updates `dist`; it uses the same run's artifact, skips stale source revisions and publishes the catalog and packages together. All main pushes run the workflow so a newer unrelated commit cannot leave a skipped publication without a replacement run. Unchanged distributions do not create a commit. The workflow does not create GitHub Releases or release a new App.

To prepare local artifacts from a checkout with dependencies installed, use fresh output directories:

```sh
node scripts/official-plugin-distribution.cjs build /tmp/token-monitor-official-plugins
node scripts/official-plugin-distribution.cjs stage /tmp/token-monitor-official-plugins /tmp/token-monitor-plugin-dist
```

These commands only write local files. The builder validates the declared target range without requiring this checkout's product version to satisfy it; installation still enforces the range on the user's App. The script's `PLUGINS` list selects maintained packages. Each package declares its own compatibility range and includes localized README and CHANGELOG files. Catalog release notes come from the matching version section in the packaged CHANGELOG bytes. To publish an update, increase the plugin version and add its localized notes. Published versions are immutable; identical reruns are allowed, while changed bytes under the same version stop publication. The catalog retains the newest 32 versions in SemVer order for selection and recovery; older package files remain in `dist` and cannot be overwritten. An incoming release outside that retained range is rejected before any distribution files change. Full release history stays in the source CHANGELOG files.

## Repository details and README

In-app GitHub discovery is not yet available. A repository topic does not register an installable package. Use local import or an HTTPS catalog and document that route in your README.

Catalog entries may set a GitHub `repository` URL and an optional `readmePaths` locale-to-path map, for example `{"en":"plugins/example/README.md","zh-TW":"plugins/example/README.zh-TW.md"}`. Paths must be repository-relative Markdown files, with no traversal, URL/query syntax or encoded separators. The host selects the current locale, then its language, English, or the first declared path. Without a map, it uses the repository default README without guessing localized filenames. Relative links and images resolve from the selected file's directory. Without a repository, basic description and package actions remain available.

Keep release notes in each version's `changelog`. General details and first-install previews use the README; same-source update previews show retained catalog notes newer than the installed version and up to the selected target, newest first. Retain intervening versions so users skipping releases can read their notes.

See the [README and image requirements](publishing.md#readme-content-and-images) for supported Markdown, image paths, formats and budgets. These requirements are shared by all catalog sources; source branding does not change image validation or grant trust.

## Create a community catalog

Build from your plugin source directory in a Token Monitor checkout using Node 22.15 or newer:

```sh
node scripts/build-plugin-package.js /path/to/my-panel /path/to/my-panel.tmplugin
```

The output must not already exist. The builder validates the package and prints its SHA-256. Host that exact file at a direct HTTPS URL; do not change its bytes after computing the digest. Catalog format **1** is separate from package format **2** and manifest `tmApi: 1`.

Save this template as `catalog-template.json`. Replace the URL and metadata to match your package. The zero digest is a placeholder, replaced by the next script; do not publish it unchanged.

```json
{
  "format": 1,
  "title": { "en": "My plugins", "zh-TW": "我的外掛" },
  "plugins": [{
    "id": "my-panel",
    "name": "My panel",
    "description": "My own same-page panel",
    "author": "Your name",
    "versions": [{
      "version": "1.0.0",
      "types": ["widget", "page"],
      "url": "https://example.com/plugins/my-panel-1.0.0.tmplugin",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "engines": { "tokenMonitor": ">=0.80.0" },
      "changelog": "Initial release"
    }]
  }]
}
```

Save as `make-catalog.cjs`, then run `node make-catalog.cjs /path/to/my-panel.tmplugin catalog-template.json catalog.json`. It fills the digest from the actual archive and checks the template identity. Use a fresh output filename when rerunning.

```js
const fs = require('node:fs');
const crypto = require('node:crypto');
const [archive, template, output] = process.argv.slice(2);
const bytes = fs.readFileSync(archive);
const manifest = JSON.parse(bytes).manifest;
const catalog = JSON.parse(fs.readFileSync(template, 'utf8'));
const entry = catalog.plugins.find(item => item.id === manifest.id);
const version = entry?.versions.find(item => item.version === manifest.version);
if (!version) throw new Error('Catalog id/version must match the package');
version.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(output, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
```

Required fields are `format`, `title`, `plugins`, each entry's unique `id`, `name`, and nonempty `versions`, and each version's unique SemVer `version`, direct HTTPS `url` and lowercase 64-character `sha256`. Optional entry fields are `description`, `author`, the manifest-compatible `identityIcon`, and the `repository`/`readmePaths` presentation fields described above; optional version fields are `types`, `engines.tokenMonitor` (a SemVer range) and `changelog`. Title/name/description/changelog can be strings or locale-to-string maps. `types` accepts `widget`, `page`, `appearance`, `automation`; unknown values are ignored. These are display hints, not capabilities. Downloaded manifests determine actual installed types and API compatibility; keep catalog and package engine ranges aligned.

Limits: 16 configured sources, 128 entries per index, 32 versions per entry, a 1 MiB downloaded index and 64 MiB package envelope. URLs must be HTTPS without credentials or fragments, at most 2048 normalized characters. Downloads omit cookies, reject redirects and have a 15-second request deadline. Serve actual file bytes, not a repository web page or a redirecting download link.

Host `catalog.json`, then in Settings → Plugins → Discover → More actions → Custom catalog sources, add its URL without a public key. Refresh, inspect the package preview, choose Trust, install and enable, or Install only to leave it disabled. This is a configured source, not an automatic marketplace. To offer an update, build a higher version, add its matching URL/digest to the same entry and refresh that same source. Source identity is pinned to the installation; changing catalogs is not a silent migration. Prefer stable releases: discovery chooses the newest compatible stable version before prereleases.

## Optional Ed25519 signing

A pinned source needs an Ed25519 SPKI PEM public key supplied by the user. The server returns an envelope `{ "payload": "base64", "signature": "base64" }`, where the signature covers the **exact decoded payload bytes** (the complete catalog JSON), not the envelope or a parsed/reserialized object. An unpinned source expects plain catalog JSON, not this envelope.

For a self-created test key, save as `create-catalog-key.cjs` and run `node create-catalog-key.cjs private.pem public.pem`. Keep the private key outside the hosted directory and never bundle it with a plugin; reuse a securely stored key for later versions rather than generating a new identity each time.

```js
const fs = require('node:fs');
const crypto = require('node:crypto');
const [privatePath, publicPath] = process.argv.slice(2);
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
```

Save as `sign-catalog.cjs`; run `node sign-catalog.cjs catalog.json private.pem catalog-signed.json`:

```js
const fs = require('node:fs');
const crypto = require('node:crypto');
const [input, privatePath, output] = process.argv.slice(2);
const payload = fs.readFileSync(input);
const key = crypto.createPrivateKey(fs.readFileSync(privatePath));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 key');
const envelope = {
  payload: payload.toString('base64'),
  signature: crypto.sign(null, payload, key).toString('base64')
};
fs.writeFileSync(output, JSON.stringify(envelope) + '\n', { flag: 'wx' });
```

Host `catalog-signed.json` and configure its URL together with the contents of `public.pem` in the optional public-key field. The 1 MiB download bound includes base64/envelope overhead. Distribute the public key through a channel the user trusts. A valid signature identifies the pinned key; neither it nor SHA-256 audits the code, grants official attribution, or limits its local authority.

## Test before sharing

Use a disposable profile and self-authored data. Check unsigned and pinned-source refresh, a tampered payload/signature, an incorrect package digest, and mismatched package id/version. Preview and Install only must not execute code. Exercise explicit enablement, higher-version update with renewed trust, rollback and uninstall retention. See the [author self-check](validation.md#author-self-check) for lifecycle checks and the separate [maintainer section](validation.md#maintainer-platform-acceptance) for host acceptance; a successful build alone does not establish plugin safety or platform support.

## Recovery outside the renderer

Use the native tray menu **Restart without plugins**, `--plugins-safe-mode`, or `TOKEN_MONITOR_PLUGINS_SAFE_MODE=1`. Safe mode enumerates and manages packages without loading their UI or backend. This is necessary because trusted same-page code can block its entire renderer. A package cannot be individually killed out of that shared JavaScript realm while preserving the rest of it. Safe mode does not undo arbitrary local changes previously made by code.
