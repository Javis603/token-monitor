---
summary: "Provider-note routing and registration checklists for tracked clients and limits providers."
read_when:
  - Changing code under src/shared/providers or src/electron/providers
  - Adding or renaming a tracked client or limits provider
  - Deciding whether provider behavior needs a durable note
---

# Provider notes

This directory is the exception manual and authoring guide for providers. Before changing a provider, look for `<id>.md` beside this file and update it when the documented contract moves.

Most ids route directly to the same filename. Product families may share one note when splitting it would hide a coupled contract. The current alias is:

| Code id | Read |
|---|---|
| `factory` | `droid.md` |

If neither a direct note nor an alias exists, this README and the code/tests are authoritative. Do not create an empty placeholder.

## When a provider needs a note

A note is warranted when a provider has one or more of these properties:

- separate usage, session and limits data planes that must not be conflated;
- non-trivial account identity or cross-device aggregation;
- ordered credential, endpoint or process fallbacks;
- local file parsing with bounded reads, caches or privacy constraints;
- a transport or security boundary that differs from shared limits behavior;
- multiple provider/client ids representing one product family.

Do not create a page that merely lists an endpoint or repeats a small `limits.js`. Code and tests remain the authority. State every non-obvious id relationship inside the family note and in the alias table above.

Keep cross-provider runtime rules in `AGENTS.md` and `docs/architecture.md`; do not duplicate them in each provider note.

## Adding a tracked client

Tracked-client identity lives in `CLIENT_CATALOG` in `src/shared/clientCatalog.js`. It measures local token activity and is not automatically a limits provider.

| Touch point | Contract |
|---|---|
| Identity | Insert one catalog entry at the intended display position with id, label and applicable `defaultTracked` / `locallyParsed` flags; do not maintain derived client lists by hand. |
| Provider code | Put transcript readers, path resolvers and self-sync code under `src/shared/providers/<id>/`. Most tokscale-native clients need none. |
| Session metadata | Register only data tokscale cannot supply in `src/shared/sessionMetadata.js`; keep storage discovery, parsing and caches provider-local. |
| Roots and health | Add the authoritative root to `clientSourceRoots()`, register each `checkId` in alphabetical `CLIENT_SOURCE_CHECK_IDS`, then sync the Worker copy. |
| Path semantics | Mirror tokscale's source implementation. Do not infer XDG behavior from binary strings or `tokscale clients`. |
| Normalization | Keep canonical ids, tokscale aliases and filters aligned; run the client partition-invariant tests. |
| Product surfaces | Update renderer/tray/chart maps, Discord, CSS, artwork and WSL marker attribution where applicable. |
| Docs and guards | Update every README locale, `.env.example` and pinned client-list/settings tests deliberately. |

Session resolvers return a `Map` keyed by bare session id. `contextTokens` and `contextWindow` form one live pair: read it only through `shouldReadSessionContext()` and normalize through `src/shared/sessionContext.js`. Use an explicitly reported capacity or a tightly bounded provider mapping; unknown values stay absent. Put model mappings and transcript edge cases in the provider note.

Self-synced clients also register in `SELF_SYNCED_CLIENTS`; parse-local clients must not. Explain source roots versus generated cache roots in the provider note so watch behavior remains loop-free.

## Adding a limits provider

Limits-provider identity lives in `LIMIT_PROVIDER_CATALOG` in `src/shared/limitProviders.js`. Catalog order is the fresh-install default and must not overwrite a saved custom order.

| Touch point | Contract |
|---|---|
| Identity | Insert one catalog entry at the intended fresh-install position with id, label and optional `settingsLabel`; do not maintain derived id or label lists separately. |
| Collection | Register `providerFetchers()` and implement `src/shared/providers/<id>/limits.js`. |
| Settings and secrets | Register runtime setting keys in `LIMIT_PROVIDER_SETTING_KEYS`; add fixed GUI credentials to `CREDENTIAL_SETTING_PATHS`. Automatic providers that persist nothing belong in neither list. |
| Account UI | Register account/status ids or a connection-detail key and add matching DOM nodes. |
| Manual panel | Use either the shared plain-panel animation path or an add-form child with `accordion-animated-container`; do not mix the two shapes. |
| Presentation | Add capability tags, source-label overrides only when needed, CSS marks and tray artwork. |
| Other surfaces | Add the explicit macOS widget provider case and all locale strings. |
| Docs and env | Update README locales and `.env.example` when credentials are configurable; add a note for non-obvious identity, fallback or security rules. |

Normalize results through the shared limits core, keep display-only derivations out of the wire shape, use the injected transport unless a documented custom transport is required, and never expose raw credentials to the renderer.

`limitProviders.js` is part of the portable Hub core. Adding, reordering or renaming a provider changes the registered Hub build even when collection is desktop-only; update the build registry after the final shared change.
