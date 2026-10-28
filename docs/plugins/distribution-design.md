# Packages, trust and recovery

For release naming, GitHub discovery, README presentation and an author checklist, see the [publishing guide](publishing.md).

## Package format

A `.tmplugin` is JSON `{format:2, manifest, files}`. `files` maps each manifest-declared relative filename to base64 bytes. Maximum encoded envelope is 64 MiB; maximum manifest is 256 KiB. All files are explicit, including prebuilt dependencies. Path traversal, symlinks, case-insensitive collisions and file/directory-prefix collisions are rejected. Exact code/asset bytes, including UTF-8 BOM, survive packing and unpacking. Installing never executes dependency installation or package scripts.

The package SHA-256 verifies downloaded bytes. A separate canonical manifest-plus-exact-files digest identifies installed content, because serializing a directory does not reproduce arbitrary original envelope formatting. Neither hash proves code safety or identity. An installed package changed outside management is not accepted as a trusted rollback backup. Missing directories remain recoverable; symlink replacements remain rejected.

## Trust and activation

The package preview offers Trust, install and enable, approving the exact content revision and enabling it in one transaction with background execution off. Install only records the package disabled and untrusted. When the master switch is off or safe mode is active, installation remains disabled and untrusted. An update or Reload with changed bytes requires a new explicit trust decision; version and id alone are insufficient. Optional `engines.tokenMonitor` and required `tmApi:1` identify compatibility. Other `tmApi` values are rejected, not adapted.

There is no granular capability consent. UI can change the shared renderer; a Node backend can access local files, credentials, network and subprocesses available to the OS user. Display location and background toggles control lifecycle, not containment. The App continues protecting its ordinary external interfaces and renderer secret projections, but these are not a security barrier against trusted local code.

Package updates and removal cooperatively release affected UI before moving files. The package review’s Trust and update action approves only the previewed content revision and preserves enabled/background choices; disabled plugins remain off. Unsaved mounts prompt first. Discovery Reload and rollback still warn before reloading affected hosts. Normal disable preserves revision trust and cooperatively releases only that plugin; re-enabling unchanged code does not ask for trust again. Unsaved mounts prompt before disable. Failed cleanup leaves the plugin disabled and offers affected-window recovery; declining recovery does not re-enable partially disposed code. A disabled backend loses demand and is stopped before package files move. The host requests cooperative cleanup, then terminates if needed. Arbitrary external side effects or child processes created by an unrestricted plugin are the author's responsibility; package rollback is not an OS transaction.

## Atomic management

Transactions pause and rediscover only their target plugin, including during rollback; unrelated mounts, drafts and backends stay live. An explicit discovery Reload remains a full reload.

The registry and prepared/committed journal remain authoritative. A prepared transaction recovers the previous package, registry, management settings and owned data copies. A committed transaction completes cleanup. Before replacement, the current managed directory and content digest are rechecked. Invalid registry/journal bytes block mutations and remain intact for diagnosis.

One verified previous compatible package is retained for rollback. Rollback swaps code; it does not reverse backend data migrations. Missing managed directories retain management-only entries, with rollback/uninstall available and execution forbidden. A corrupt existing package is rejected early with repair guidance; uninstall/reinstall with retention is the recovery route.

Uninstall can retain plugin data/preferences and display locations independently. Without retention, it removes the owned backend data directory, author settings and selected content replacements alongside ordinary placements. Files an unrestricted backend created elsewhere are not automatically discovered or deleted. Skin presets already applied are host snapshots; switching/resetting the App theme clears them.

## Catalogs

Discover separates the App-distributed offline official catalog, GitHub topic discovery and user-configured HTTPS catalogs. The official catalog is currently empty: no production example plugin ships. Only packages distributed with the App receive official attribution; this is provenance, not a safety guarantee. Official package updates arrive with an App update and use the same explicit preview, installation choice, revision trust and rollback workflow. Install from file and folder remain available for private unpublished plugins. Catalog refresh and update preview do not execute code; installation is always explicit.

Catalogs use bounded downloads, source pins, package hashes and optional Ed25519 signatures. A source is a configured catalog URL, not a GitHub repository crawler. Source changes cannot silently replace another installation's origin. Community labels and author descriptions are publisher claims, never an audit badge. Experimental API compatibility is checked against the downloaded package before installation.

## GitHub discovery and details

Opening Discover immediately displays the local catalog snapshot, then searches public GitHub repositories tagged `token-monitor-plugin` when due, ordered by stars, with at most 100 results. A notice identifies truncated results. The topic is author-selected: entries remain nonofficial and unreviewed. Repository discovery supplies a source link and lazily loaded Markdown README, not an installable package or inferred version. No GitHub Release asset naming convention is assumed. Package installation still requires a configured catalog or local package.

Successful search results are cached on disk for six hours and retained when offline or rate-limited. Failed searches have a five-minute retry cooldown; explicit Refresh bypasses the cache interval and refreshes custom sources, with at most four custom-source requests in flight. These network requests do not lock the settings UI; search, navigation and open package reviews stay usable. Results update without replacing the search input or an open review, and failed sources remain identified alongside cached entries. No periodic GitHub polling runs. Stars appear only on GitHub discovery cards and details, never installed management rows; downloads are not counted. Cached metadata is informational and cannot confer trust.

Catalog entries may provide a GitHub `repository` URL. Both catalog and discovered repositories use that repository's README for detailed descriptions and inline images, preserving Markdown order. There is no separate screenshot gallery or per-version image history. Version-specific changelogs remain in the catalog. Without a repository, basic description and package actions remain available.

README Markdown is rendered by `markdown-it` with raw HTML disabled; headings, lists, tables, code and HTTPS links are supported. Relative image paths resolve against the README's actual location returned by GitHub, including nested README directories. Only main-generated document image indices cross the renderer bridge. Opening details fetches only the README. Images load sequentially after the user chooses Load README images. Only direct HTTPS images in the same repository on `raw.githubusercontent.com`, using the standard HTTPS port and no credentials, query or fragment, are eligible; redirects and other hosts are rejected before any image request. Only the first eight eligible image occurrences receive preview slots. Main shares repeated requests for an image and owns per-document cancellation and budgets: four MiB per image, eight MiB cumulative download, eight MiB cumulative PNG output, and 16 million cumulative decoded pixels. Failed attempts consume budget reservations, so retrying cannot reset the limits. Requests have a 15-second deadline; decodes across all documents run serially. Only PNG and JPEG are decoded. `image-size` checks their header dimensions before native decoding, with an 8192-pixel per-dimension limit and the remaining document pixel budget. The decoded size is checked again, then resized to at most 1600 pixels and returned as PNG. WebP, SVG, animated playback and author HTML are not supported. A failed image does not block installation. Details and enlarged images close with their close button, an outside click, or Escape; an enlarged image closes before its parent details. Images appear at their positions in the README. Blocked or excess images retain their alt text; users can view the full README on GitHub. Closing or replacing details aborts pending README/image requests and releases the document cache. Official and community entries use identical image rules.


This does not add an official remote catalog or automatic package installation. Selecting official hosting and its release process remains a separate product decision.

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

Required fields are `format`, `title`, `plugins`, each entry's unique `id`, `name`, and nonempty `versions`, and each version's unique SemVer `version`, direct HTTPS `url` and lowercase 64-character `sha256`. Optional entry fields are `description`, `author`, the manifest-compatible `identityIcon`, and the `repository` presentation field described above; optional version fields are `types`, `engines.tokenMonitor` (a SemVer range) and `changelog`. Title/name/description/changelog can be strings or locale-to-string maps. `types` accepts `widget`, `page`, `appearance`; unknown values are ignored. These are display hints, not capabilities. Downloaded manifests determine actual installed types and API compatibility; keep catalog and package engine ranges aligned.

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

Use a disposable profile and self-authored data. Check unsigned and pinned-source refresh, a tampered payload/signature, an incorrect package digest, and mismatched package id/version. Preview and installation must not execute code. Exercise explicit enablement, higher-version update with renewed trust, rollback and uninstall retention. See [validation](validation.md) for lifecycle and native acceptance; a successful build alone does not establish plugin safety or platform support.

## Recovery outside the renderer

Use the native tray menu **Restart without plugins**, `--plugins-safe-mode`, or `TOKEN_MONITOR_PLUGINS_SAFE_MODE=1`. Safe mode enumerates and manages packages without loading their UI or backend. This is necessary because trusted same-page code can block its entire renderer. A package cannot be individually killed out of that shared JavaScript realm while preserving the rest of it. Safe mode does not undo arbitrary local changes previously made by code.
