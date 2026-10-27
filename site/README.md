# Website maintenance

Run `npm ci --prefix site`, `npm run build --prefix site`, then `npm test --prefix site`. Serve `_site/` with any local static server to inspect the production output, including generated references. The build does not publish; `.github/workflows/pages.yml` handles deployment from main.

The landing page and six-language guides are editable HTML under `site/`; shared documentation navigation, language and copy behavior live in `scripts/docs.js`. Keep the guide examples executable and describe the supported product behavior. Do not add research history or inspiration comparisons to user-facing instructions.

## Reading routes

App usage, plugin usage and plugin development are separate topics. The author guide at `docs/plugin-quickstart.html` introduces manifest, UI, data/settings and distribution in one continuous article, with detailed contracts and catalog-authoring steps in the linked canonical references. The left navigation shows chapter links and expands subsection links for the chapter being read; scrolling updates the active section without hiding a focused link. The six-language agent prompt is static, selectable HTML so it remains useful without JavaScript; JavaScript adds a copy button with a selection fallback. The App’s Build a plugin page reuses the same localized prompt in renderer i18n; `tests/electron/pluginAuthorPrompt.test.js` enforces exact parity with both website entry points. Update all three copies together when changing the prompt. The older UI/data/share routes retain language and section redirects for existing bookmarks. Keep these compatibility mappings aligned when renaming guide anchors.

## Canonical plugin references

`build-docs.mjs` renders `docs/plugins/README.md`, `author-ui-options.md` and `distribution-design.md` directly into the API, same-page UI integration and distribution reference pages. Edit those Markdown sources, not generated `_site` files. Their English content is intentionally labelled as canonical; translated guide prose and navigation do not imply translated API specifications. Each generated page also exports the exact source Markdown for agent consumption.

Marked is a pinned **build-only** dev dependency; it is not bundled into the website or the App. Rendering escapes raw HTML, keeps code literal and allows only HTTP(S), fragment or repository-relative links. Relative links between the three reference documents remain on the website; implementation/example links retain their repository context. The site tests verify source/output parity, cross-reference anchors and rendering boundaries.

The Pages workflow watches all three canonical sources as well as `site/**`. When adding a canonical reference, update the source mapping and workflow triggers together. Build tests should fail before upload when a mapped section link no longer resolves.

Published source links use `main`. Document actual API and App-version compatibility requirements rather than pull-request numbers or development-branch availability. Previewing this site locally does not publish it.
