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
selects the collector working directory, and only `~/` expands to the effective
Tokscale home. Artifacts are siblings of an overridden session directory, except
for the empty setting where they are children of the working directory.

Source checks and transcript watches use these resolved roots. Settings changes
are picked up when source roots are next resolved; there is no dedicated settings
file watch. WSL discovery uses the default Linux home roots, as `--home` scans
ignore host environment and project settings.
