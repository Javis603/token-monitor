# AGENTS.md

This is the entry point for project guidance shared by every coding agent (Claude Code, Codex, Cursor, …). Keep global contracts here and provider-specific knowledge in `docs/providers/`.

## Commands

```bash
npm start          # launch the Electron widget (= npm run widget / npm run dev)
npm run hub        # start the Node hub on port 17321
npm run agent      # start the headless collector→hub agent
npm run agent:once # one-shot collect+post, then exit
npm test           # run the node:test suite
npm run lint       # ESLint flat config
npm run verify     # lint + test
```

Use Node 22.15 or newer. CI runs `npm run verify` on Node 22 and 24. To exercise the agent without posting, run `npm run agent:once -- --dry-run`.

## Provider notes

Before changing `src/shared/providers/<id>/` or `src/electron/providers/<id>/`, read `docs/providers/README.md` and the matching `docs/providers/<id>.md` when it exists. The README owns provider-family aliases and the tracked-client and limits-provider registration checklists.

Update the provider note in the same change when its contract moves. Do not copy detailed parsing, identity, fallback or security rules into this file. A provider without a note follows the shared contracts and needs no empty placeholder page.

## Architecture contracts

Four runtime entry points share `src/shared/`:

- `src/electron/main.js` — desktop widget, IPC and local/client/host mode orchestration.
- `src/hub/server.js` — Node HTTP Hub and persisted device records.
- `src/agent/agent.js` — headless collector that posts the same device shape.
- `worker/src/index.js` — Cloudflare Worker implementation of the Hub protocol.

Preserve these boundaries:

- `src/shared/` is the source of truth for portable logic. The Worker cannot import above `worker/`; `npm run sync:worker` vendors the closure declared by `WORKER_SHARED_MODULES` into `worker/src/shared/`. Edit the source, never generated copies, and sync after a relevant change.
- Usage and limits are independent runtimes composed by `DeviceState`. Provider credentials stay at the collector edge; Hub and Worker receive normalized records only.
- Provider-specific code belongs in `src/shared/providers/<id>/`, with app-layer code in `src/electron/providers/<id>/` when needed. Cross-provider helpers stay outside provider folders.
- A tracked client and a limits provider are different identities even when they share an id. Their catalogs and registration checklists are separate.
- Shared code that enters the Worker closure must remain portable. Do not add Node-only built-ins to portable modules such as `src/shared/usage.js`.
- Public compatibility surfaces include settings keys, environment variables, CLI flags, Hub endpoints and the device wire shape. Plan migrations before changing them.
- Renderer settings are default-deny for secrets. Raw provider credentials stay in the main process and may cross that boundary only through an explicit allowlist.

`docs/architecture.md` records the longer cross-runtime rationale. Keep it concise and update it only when one of those boundaries changes.

## Generated and registered state

- Run `npm run sync:worker` after changing a shared module in the Worker closure. CI rejects drift.
- Remote Hub update checks use `src/shared/hubBuildRegistry.json`, not the product version. After the final Hub/shared implementation is stable, run `npm run update:hub-build` once; do not hand-edit generated Worker metadata.
- The tokscale manifest at `scripts/vendor/tokscale.json` controls binary provenance. App, agent and packaging entry points may ensure the binary; install, Hub, lint, test and verify must not download it.

## Conventions

- Start with ecosystem best practice before choosing a custom implementation.
- Do not add dependencies or new tooling without discussing it first in the issue or PR.
- Keep documentation close to its scope. Root guidance is for cross-cutting contracts; provider exceptions and registration details belong in provider notes.
- Document non-obvious constraints and failure modes, not a prose duplicate of the code. Avoid hardcoded counts and exhaustive inventories where a source catalog or command is authoritative.
- Verify documentation against the current code. Delete stale claims instead of preserving history in operational guidance.

### Commit messages

Use `<type>(<scope>): <subject>` with a conventional-commit type and a scope when the change targets a clear subsystem. Scope single-provider changes by provider (`fix(opencode):`, `fix(codex):`) rather than by the subsystem that happens to contain them. Aim for a subject no longer than roughly 72 characters.

Add a body only when the diff does not make the reason clear. Keep body paragraphs as physical long lines rather than hard-wrapping them. Avoid vague subjects and internal review jargon such as “P0”, “review findings” or “hardening pass”.

Never add an AI `Co-Authored-By` trailer. Preserve genuine human `Co-authored-by:` trailers on multi-author squashes and keep the `(#NN)` suffix GitHub appends to squash subjects.

### Pull requests and GitHub content

- PR titles follow the commit-message convention because they become squash subjects.
- Summarize final behavior, list verification commands, attach visuals for UI changes and link the related issue.
- Write issue/PR bodies and comments to a file and pass it with `--body-file` or `-F body=@<path>`. Do not use inline command substitution or heredocs that can mangle Markdown escaping.
