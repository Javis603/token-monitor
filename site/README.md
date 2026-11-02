# Website maintenance

Run `npm ci --prefix site`, `npm run build --prefix site`, then `npm test --prefix site`. Serve `_site/` with any local static server to inspect the production output, including generated references. The build does not publish; `.github/workflows/pages.yml` handles deployment from main.

The landing page and six-language guides are editable HTML under `site/`; shared documentation navigation, language and copy behavior live in `scripts/docs.js`. Keep the guide examples executable and describe the supported product behavior. Do not add research history or inspiration comparisons to user-facing instructions.

## Reading routes

App usage, plugin usage and plugin development are separate topics. The author guide at `docs/plugin-quickstart.html` introduces manifest, UI, data/settings and distribution in one continuous article, with detailed contracts and catalog-authoring steps in the linked canonical references. The left navigation shows chapter links and expands subsection links for the chapter being read; scrolling updates the active section without hiding a focused link. The six-language agent prompt is static, selectable HTML so it remains useful without JavaScript; JavaScript adds a copy button with a selection fallback. The App’s Build a plugin page reuses the same localized prompt in renderer i18n; `tests/electron/pluginAuthorPrompt.test.js` enforces exact parity with both website entry points. Update all three copies together when changing the prompt. The older UI/data/share routes retain language and section redirects for existing bookmarks. Keep these compatibility mappings aligned when renaming guide anchors.

## Canonical plugin references

`build-docs.mjs` maps canonical documents under `docs/plugins/` to reference pages, including data/settings examples, publishing and testing. Its `references` array is the source-to-route registry. Edit those Markdown sources, not generated `_site` files. Their English content is intentionally labelled as canonical; translated guide prose and navigation do not imply translated API specifications. Each generated page links agents to its canonical raw GitHub Markdown at the original repository path, so relative document links keep their source context. Existing `.md` website routes remain as small compatibility pointers with absolute canonical links. Do not relocate raw Markdown under renamed website routes without rewriting its links.

Marked is a pinned **build-only** dev dependency; it is not bundled into the website or the App. Rendering escapes raw HTML, keeps code literal and allows only HTTP(S), fragment or repository-relative links. Relative links between mapped reference documents remain on the website; implementation/example links retain their repository context. The site tests verify source/output parity, cross-reference anchors and rendering boundaries.

The Pages workflow builds and tests pull requests and main pushes affecting mapped sources, the quickstart used by parity checks, or `site/**`; only main can deploy. Concurrency is scoped by ref so PR validation cannot replace a queued main deployment. When adding a canonical reference, update the source mapping and workflow triggers together. Build tests should fail before upload when a mapped section link no longer resolves.

Published source links use `main`. Document actual API and App-version compatibility requirements rather than pull-request numbers or development-branch availability. Previewing this site locally does not publish it.

Keep translated author chapters concise and link to the canonical data/settings examples, publishing checklist and author self-check. The testing reference separates author checks from maintainer platform acceptance; do not present the host fixture matrix as an onboarding requirement. Preserve existing guide routes and section redirects.
