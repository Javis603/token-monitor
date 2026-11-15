---
summary: "Prime Agent root and RLM transcript discovery and settings precedence."
ids: [prime-agent]
read_when:
  - Changing Prime Agent source discovery, watching, or token accounting.
---

# Prime Agent

Tokscale reads the Pi-format root sessions and RLM child transcripts from
`~/.prime/agent/sessions` and the sibling `session-artifacts` tree. Attribution
and child deduplication belong to the scanner; do not count attribution records
again in Token Monitor.

`paths.js` mirrors the pinned scanner's resolution: `PRIME_AGENT_SESSION_DIR`
then the legacy `PRIME_AGENT_CODING_AGENT_SESSION_DIR` take precedence over
settings; an empty primary variable suppresses the legacy spelling. Otherwise
`PRIME_AGENT_CODING_AGENT_DIR` selects the agent directory. Project settings at
`<collector cwd>/.prime/agent/settings.json` override its `settings.json` when
`sessionDir` is a string or null. Null restores the agent default, an empty string
selects the collector working directory, and `~` or `~/` expands to the effective
Tokscale home. Artifacts are siblings of an overridden session directory, except
for the empty setting where they are children of the working directory.

Source checks use these resolved roots. Live watches retain only direct session
JSONL files and `session-artifacts/*/sub-*/*.jsonl`, excluding
`rlm-subagents.jsonl` and dependency/VCS trees. This bounds traversal when a
session override selects the home or working directory. Root creation/removal
and new RLM child directories remain observable; overlapping client sources keep
the union of their watch policies. Prime event attribution separately applies
its own policy, so another client's admitted transcript cannot trigger a Prime
scan just because it is below a broad Prime root. Full Tokscale scans still recurse through
all resolved roots, so nonstandard nested transcripts can be counted on a full
scan without becoming live watch targets. Explicit extra scan paths retain the
shared custom-root watch policy. Settings changes
are picked up when source roots are next resolved; there is no dedicated settings
file watch. WSL discovery uses the default Linux home roots, as `--home` scans
ignore host environment and project settings.

## Verification

Run `node --test tests/shared/primeAgentJcode.test.js tests/shared/primeAgentWatch.test.js tests/docs/providerGuidance.test.js`
and `node scripts/verify-vendored-tokscale.js` against the manifest-pinned binary.
The watch tests exercise native and polling traversal, root transcript updates,
and new RLM child discovery. Native WSL discovery remains a manual check.
