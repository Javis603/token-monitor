# Contributing

Bug reports, feature requests, documentation improvements and focused fixes are welcome. English or Chinese is fine for issues.

## Where to start

- Search [open and closed issues](https://github.com/Javis603/token-monitor/issues?q=is%3Aissue) and [pull requests](https://github.com/Javis603/token-monitor/pulls?q=is%3Apr) before opening a new one. If an existing issue looks similar but your setup differs, open a new one and link it.
- Ask usage and setup questions in [Discussions Q&A](https://github.com/Javis603/token-monitor/discussions/categories/q-a).
- Use the [issue forms](https://github.com/Javis603/token-monitor/issues/new/choose) for a bug or feature request. Share minimal, sanitized evidence, not full logs, settings, databases or conversations.
- For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md); do not post exploit details or secrets in a public issue.
- Open an issue to discuss substantial new features, architecture changes or new dependencies/tooling before investing in implementation. A small, focused fix does not need a separate issue first. Discussion does not guarantee acceptance or a release date.

## Make a focused change

Keep unrelated fixes and broad refactors in separate pull requests so each change can be reviewed and validated independently.

[AGENTS.md](AGENTS.md) is the engineering guide for both people and coding agents. It covers setup commands, runtime requirements, architecture boundaries, commit and PR conventions, and validation. Read the sections relevant to your change.

To add or change a tool integration, start with the [provider notes](docs/providers/README.md): the [tracked-client](docs/providers/README.md#adding-a-tracked-client) checklist covers token usage, and the [limits-provider](docs/providers/README.md#adding-a-limits-provider) checklist covers account quotas and balances.

## Open a pull request

Use a Conventional Commit-style title and fill in the PR template. [AGENTS.md](AGENTS.md#pull-requests) has the full validation guidance. Do not include private data in fixtures or screenshots.
