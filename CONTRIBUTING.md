# Contributing

Bug reports, feature requests, documentation improvements and focused fixes are welcome. English or Chinese is fine for issues.

## Start with the right place

- Search [open and closed issues](https://github.com/Javis603/token-monitor/issues?q=is%3Aissue) and [pull requests](https://github.com/Javis603/token-monitor/pulls?q=is%3Apr) before opening a new one. Similar symptoms alone do not establish the same cause.
- Use the [issue forms](https://github.com/Javis603/token-monitor/issues/new/choose) for a bug or feature request. Share minimal, sanitized evidence, not full logs, settings, databases or conversations.
- For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md); do not post exploit details or secrets in a public issue.
- Discuss substantial new features, architecture changes or new dependencies/tooling before investing in implementation. A small, focused fix does not need a separate issue first. Discussion does not guarantee acceptance or a release date.

## Make a focused change

Keep unrelated fixes or app-wide changes in separate pull requests so each change can be reviewed and validated independently.

[AGENTS.md](AGENTS.md) is the shared engineering guide for people and coding agents: setup commands, runtime requirements, architecture boundaries, commit/PR conventions and validation. Read the guidance relevant to your change rather than duplicating it here.

Keep token usage, session metadata/activity, and account limits distinct. For an integration, use the [provider notes](docs/providers/README.md), especially the [tracked-client](docs/providers/README.md#adding-a-tracked-client) and [limits-provider](docs/providers/README.md#adding-a-limits-provider) checklists. Fork-only token readers belong in the tokscale fork and reach the App through its vendor pin; do not add a second parser here. Verify the pinned binary's buckets and the App's normalized totals, including cache/reasoning and duplicate-source behavior where relevant.

## Open a pull request

Use a Conventional Commit-style title and the PR template. Explain what changed and why, link related work, and record checks and results. Follow [the validation guidance](AGENTS.md#pull-requests): include before/after regression evidence for fixes, relevant UI evidence, and untested platforms or remaining manual checks. For documentation-only edits, guidance and link checks are sufficient. Do not include private data in fixtures or screenshots.
