# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/Javis603/token-monitor/security/advisories/new). Do not open a public issue, discussion or pull request containing exploit details, credentials or private user data.

A useful report includes:

- The Token Monitor version/build or source commit, OS and affected component (desktop app, headless agent, Hub, Worker or integration).
- The impact, prerequisites and a minimal reproduction using test accounts/data you control.
- Small, sanitized supporting evidence. Remove tokens, API keys, cookies, passwords, personal paths and conversation content. Do not send full settings, databases or session logs.
- Relevant dependency versions, including the bundled tokscale version, if known.

Test only systems and accounts you own or have permission to test. Avoid accessing other users' data or disrupting services.

## Scope and versions

Reports should concern Token Monitor or its bundled dependencies. Issues solely in a third-party service should go to that service's security channel. If the issue also exposes Token Monitor users, report that part here.

Security fixes are made on the main branch and shipped in the next release; earlier releases are not patched. Update to the latest release to receive fixes. This policy does not promise response deadlines, fix dates or rewards.

## Data privacy

For what data the app reads, stores and sends, see [Privacy and data handling](docs/privacy.md).
