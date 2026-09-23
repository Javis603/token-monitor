# AGENTS.md

This is the entry point for project guidance shared by every coding agent (Claude Code, Codex, Cursor, …). It is loaded automatically; the documents it routes to are not, so anything an unrelated change can break is listed under [Tripwires](#tripwires) here, with the full reasoning in the linked document.

## Commands

```bash
npm start          # launch the Electron widget (= npm run widget / npm run dev)
npm run hub        # start the Node hub on port 17321
npm run agent      # start the headless collector→hub agent
npm run agent:once # one-shot collect+post, then exit (useful for cron/launchd)
npm test           # run the node:test suite (node --test "tests/**/*.test.js")
npm run lint       # ESLint flat config (eslint.config.js)
npm run verify     # lint + test (single local entry point)
```

Automated verification is `npm run verify`; CI (`.github/workflows/ci.yml`) runs lint + test on push/PR across Node 22 & 24. The toolchain (ESLint 10 + the node:test glob) needs Node 22.13+ and DSH session decoding needs `zlib.zstdDecompressSync` (Node 22.15+), which is why `engines.node` is `>=22.15.0`.

To dry-run the agent without posting: `npm run agent:once -- --dry-run`.

## Where guidance lives

| Changing… | Read first |
|---|---|
| a boundary shared by the widget, agent, Hub or Worker; the collector, limits runtime, credentials or wire record | `docs/architecture.md` |
| anything under `src/shared/providers/<id>/` or `src/electron/providers/<id>/` | `docs/providers/README.md`, then the note whose `ids:` front matter lists that id if one exists — `grep -lE '^ids:.*[[, ]<id>[],]' docs/providers/*.md`. Most providers have no note; the README and the code/tests are then authoritative |
| adding or renaming a tracked client or limits provider | `docs/providers/README.md` (both registration checklists) |
| the device wire shape or Hub endpoints | `docs/API.md` |

Update the matching document in the same change when its contract moves, and delete stale claims rather than preserving history.

## Tripwires

Each line is a constraint that a change elsewhere has broken before, or would break silently.

- **Worker isolation.** `worker/` cannot import above itself. Edit `src/shared/`, never the `@generated` copies under `worker/src/shared/`, then run `npm run sync:worker`; CI fails on drift. Modules in that closure stay free of Node built-ins. → `docs/architecture.md` (Entry points)
- **Hub build marker.** Run `npm run update:hub-build` once after the final Hub/shared change; never hand-edit generated Worker metadata. `limitProviders.js` is in the Hub core, so adding, reordering or renaming a limits provider moves the marker too. → `docs/architecture.md` (Generated and registered state)
- **tokscale binary.** Only app, agent and packaging entry points run `ensure:tokscale`; install, hub, lint, test and verify must never download it. → `docs/architecture.md` (Generated and registered state)
- **Serial scans, exact deltas.** Full ticks scan today/month/allTime serially; watch ticks scan `--today` only and apply an exact delta. Do not parallelise the scans or turn the delta into an estimate. → `docs/architecture.md` (Collector pipeline)
- **No watch cooldown.** The product promises 3–5 s updates; a mid-tick watch event re-arms the debounce. Do not add a cooldown, and do not watch the self-synced tokscale cache dirs (they re-trigger forever). → `docs/architecture.md` (Watching)
- **Client ids are partition keys.** Each tracked-client id must be a fixed point of `normalizeClientName()`, every tokscale alias must filter back to its parent, and the filter must never emit `synthetic`. → `docs/providers/README.md` (Partition invariants)
- **Limits refresh triggers.** Local token usage never triggers a limits refresh, and `burn-rate` stays out of `COOLDOWN_BYPASS_REASONS`. → `docs/architecture.md` (Limits collector)
- **Electron transport.** Provider calls take the injected transport. Under Chromium never set a `Host` header, keep `credentials: 'omit'`, and expect a cross-origin `Referer` with a path to be cancelled. → `docs/architecture.md` (Outbound transport)
- **Credentials stay in main.** Renderer settings are default-deny; a raw credential crosses only through an explicit allowlist. New fixed credentials go in `CREDENTIAL_SETTING_PATHS`, never a provider-specific store. → `docs/architecture.md` (Settings and credentials)
- **Public stats stay public.** The subscription version stamp is added by `statsWithSubscriptionVersion()` on authenticated paths only; folding it into `getStats()` leaks through the unauthenticated route. → `docs/architecture.md` (Subscriptions)
- **Balance quotas.** Key money display off `windows[].metric === 'credits'` through `limitBalanceDisplay.js`, never a provider whitelist; display-only percentages stay out of the wire shape. → `docs/architecture.md` (Balance quotas)
- **Compatibility surfaces.** Settings keys, env vars, CLI flags, Hub endpoints and the wire shape have external users. Treat changes as breaking and plan the migration.

## Conventions

- **Consider best practices first.** When picking an approach — library vs hand-roll, pattern vs custom, framework default vs override — start by checking the ecosystem convention, not by optimizing for "fewer deps" or "less code". If a hand-rolled solution is genuinely better, argue that *after* weighing the convention.
- **Don't add dependencies or new tooling without discussing it first** (in the issue or PR description).
- **Keep documentation close to its scope and current.** This file holds cross-cutting commands, tripwires and conventions; subsystem reasoning belongs in `docs/architecture.md` and provider knowledge in `docs/providers/`. Document non-obvious constraints and gotchas, not descriptions the code already makes obvious. Avoid hardcoded counts and exhaustive lists (prefer a command like `ls src/shared/` over a hand-maintained one); verify claims against the code before writing them; delete anything that has gone stale — an outdated note is worse than none.

### Commit messages

Format: `<type>(<scope>): <subject>` — conventional-commit types (`feat` / `fix` / `refactor` / `docs` / `chore` / `perf` / `test` / …), with a scope when the change targets a clear subsystem (`fix(hermes):`, `fix(collector):`, `feat(limits):`); leave it off for cross-cutting or general changes. When a change belongs to a single provider, scope it by that provider (`fix(opencode):`, `fix(codex):`) rather than by the subsystem it happens to live in. Aim for a subject ≤ ~72 chars that describes the actual change. Add a **body** only when the diff doesn't make the *why* obvious — rationale, rejected alternatives, behaviour-preserving notes, linked issues; trivial changes stay single-line. Write body paragraphs as continuous lines, not hard-wrapped.

**Do:**

```
fix(dashboard): balance stat card widths
feat(wsl): scan usage from running WSL distros
docs(i18n): add Japanese README
```

**Don't** — vague subjects, or internal review/agent jargon (`P0`/`P1`, "review findings", "hardening pass"):

```
fix: address P0 review findings   ❌
fix: hardening pass round 2       ❌
fix: various improvements         ❌
```

Never add an AI `Co-Authored-By` trailer. **Do** keep the genuine human `Co-authored-by:` trailer on a multi-author squash (e.g. a maintainer follow-up on a contributor PR) and keep the `(#NN)` PR-number suffix GitHub appends to squash subjects.

### Pull requests

- PR titles follow the commit-message convention above — they become the squash-merge subject.
- In the description: summarize the behaviour change, note the commands you ran (`npm run verify` at minimum), attach screenshots/GIFs for UI changes, and link the related issue.

### Authoring GitHub content via `gh`

Write PR/issue bodies and comments to a file and pass it, rather than inline heredocs: `gh issue comment --body-file <path>`, `gh api -X PATCH … -F body=@<path>`. Inline `--body "$(cat <<EOF … EOF)"` mangles backtick escaping and renders as a literal `` \` `` in GitHub markdown. Same spirit for prose: write paragraphs as continuous lines and let GitHub wrap them — don't hard-wrap at 80 columns.
