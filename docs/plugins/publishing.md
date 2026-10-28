# Publishing a Token Monitor plugin

Use this guide when sharing a plugin with users. Start with the [development guide](author-quickstart.md) for implementation and the [API contract](README.md) for runtime behavior. This page distinguishes requirements enforced by the App from publishing conventions for authors.

## Choose how users find and install it

| Route | What the author provides | What users can do |
| --- | --- | --- |
| GitHub discovery | A public repository with the `token-monitor-plugin` topic and a README | Find the repository in Discover, read its README and follow its installation instructions |
| File or folder | A built `.tmplugin` file or a complete plugin source folder | Import it through Settings → Plugins |
| HTTPS catalog | A catalog index and package files at direct HTTPS URLs | Preview and install a package, then discover compatible updates from the same source |

These routes can be combined. A GitHub topic does not register a package or define how to install it. Discovery does not infer a version, compatibility or a downloadable asset from repository names, tags or GitHub Releases. Authors must describe an actual installation route in their README.

GitHub discovery is nonofficial and unreviewed. Adding a topic, serving a catalog, providing a hash or signing an index does not grant official attribution or a safety review. Official attribution is assigned by Token Monitor's distribution mechanism, not by author metadata. See [distribution and trust](distribution-design.md).

## Naming and identity

The App requires a stable manifest `id` of 2–40 characters matching `^[a-z0-9][a-z0-9-]{1,39}$`, a valid SemVer `version`, and `tmApi: 1`. See the [manifest contract](README.md#manifest) for the complete schema.

Choose any repository name; no Token Monitor prefix is required. GitHub discovery matches the `token-monitor-plugin` topic, not the repository name. The repository name, display name and manifest id may differ.

Recommended conventions:

- Keep the manifest id stable across releases. Do not change it to include a version or release channel; the id identifies installed data, settings and placements.
- Use a readable display name and a short repository description explaining the plugin's purpose. Keep compatibility and installation details in the README.
- Set manifest `author` and an HTTPS `homepage` pointing to the project. GitHub discovery displays the repository owner's login below the name; this may differ from the manifest author of an installed package.

Do not identify a community plugin as official. Document original authors, artwork and dependency licenses in the repository and retain required notices in distributed files. UI attribution and GitHub contribution history do not replace license obligations.

## README content and images

The App reads the repository's default README when details open. Maintain the detailed introduction and screenshots there rather than duplicating them in catalog fields. A catalog entry can set `repository` to its GitHub repository URL to use the same details. The README is the current project description, not a history of screenshots for individual releases.

Include the plugin's purpose, supported App versions and platforms, installation steps, usage, local/network/data access, and a license. Add screenshots when they help explain the UI. The template below is a recommended structure, not a parser requirement; headings do not need exact names or a fixed order.

Use standard Markdown for headings, lists, links, tables, code and images:

```markdown
![Plugin overview](docs/images/overview.png)
```

Image paths are resolved relative to the README's actual directory. Commit images to the repository or use direct HTTPS image URLs. Place each image where it helps explain the surrounding text; there are no four fixed slots or a separate gallery field. Images can be opened larger in the App.

Use PNG, JPEG or WebP, at most 4 MiB per image, no larger than 8192 pixels on either side or 16 million pixels in total. Keep screenshots focused and remove credentials or personal data before committing them. The App resizes previews to at most 1600 pixels. Raw HTML (including `<img>`, `<picture>` and `<details>`), SVG images, embedded video and animated playback are not supported. Use Markdown images rather than HTML layout or GitHub-only presentation features. Only HTTPS links and image URLs are active. An unsupported or unavailable image does not block installation; essential instructions should remain readable as text.

### Copyable README template

Replace the bracketed text and omit the image until you have one:

```markdown
# [Plugin name]

[One sentence explaining what the plugin does for Token Monitor users.]

![Overview](docs/images/overview.png)

## Compatibility

- Token Monitor: [tested versions or supported version range]
- Platforms: [tested OS and architecture; distinguish untested platforms]

## Install

[Link to the release and identify the .tmplugin file to download, or explain
which catalog to configure. Then give the corresponding App import steps.]

Review the package warning. Choose “Trust, install and enable” to run it,
or “Install only” to keep it disabled. With plugins globally off or safe
mode active, installation stays disabled.

## Usage

[Explain configuration, available views and how to select their locations.]

## Data and access

[Disclose local files, network services, subprocesses, credentials and data
storage actually used. State whether anything is sent outside the device.]

## Updates

[Explain where releases and release notes are published and how to update.
Mention any data migration or rollback limitation.]

## License and credits

[License, authors, and required artwork or dependency notices.]
```

## Build and release a package

The App validates package contents. Build the plugin and its dependencies before packing; include every runtime file in the manifest's `files` list. The installer does not run npm or build scripts. Use `engines.tokenMonitor` to declare an App version range when needed; README compatibility claims should agree with it. Test native dependencies against the actual supported OS, architecture and Electron runtime.

From a Token Monitor checkout, using the project's supported Node version:

```sh
node scripts/build-plugin-package.js /path/to/my-plugin /path/to/my-plugin-1.0.0.tmplugin
```

The output must not already exist. The builder validates the package and prints its SHA-256. Package format is `2`, the manifest API is `tmApi: 1`, and the plugin version is its own SemVer: these are three different values. See [package format](distribution-design.md#package-format).

For each release:

1. Bump the manifest version, complete the build, and test the exact package in a disposable profile. Check installation, explicit trust, views/settings, disablement, and update from the previous release. Use the [validation guide](validation.md) for relevant checks.
2. Publish the source revision and the tested artifact together. A Git tag `v<version>` and asset `<manifest-id>-<version>.tmplugin` are recommended naming conventions, not auto-discovery rules. The asset should be identifiable from the README's installation instructions.
3. Include release notes covering visible changes, compatibility changes and any newly used local or network access. Never replace the bytes of an already published version; publish a new version instead.
4. If distributing through a catalog, add that exact version, package URL and SHA-256 under the same plugin id. Keep catalog and manifest compatibility ranges aligned. Refreshing the catalog exposes the update; it does not silently install or trust it.

GitHub Release assets are suitable for manual download and import. Do not assume their browser download URLs work as catalog package URLs: the App rejects redirects. Catalogs need URLs that directly return the actual file bytes over HTTPS. See [creating a community catalog](distribution-design.md#create-a-community-catalog) for the index format, hosting limits and optional signing.

Keep users on the same catalog source for updates; changing sources is not a silent migration. Explain breaking settings/data changes and rollback limitations in the release notes. A rollback restores code, not arbitrary data migrations or external side effects.
