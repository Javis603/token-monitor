# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/Javis603/token-monitor/security/advisories/new). Do not open a public issue, discussion or pull request containing exploit details, credentials or private user data.

A useful report includes:

- The Token Monitor version/build or source commit, OS and affected component (desktop App, headless agent, Hub, Worker or integration).
- The impact, prerequisites and a minimal reproduction using test accounts/data you control.
- Small, sanitized supporting evidence. Remove tokens, API keys, cookies, passwords, personal paths and conversation content. Do not send full settings, databases or session logs.
- Relevant dependency versions or the bundled tokscale pin, if known. An upstream fix being merged does not establish that a shipped App includes it.

Test only systems and accounts you own or have permission to test. Avoid accessing other users' data or disrupting services.

## Scope and versions

Reports should concern Token Monitor or its bundled dependencies. Issues solely in a third-party service should go to that service's security channel; explain any Token Monitor-specific exposure separately.

Security fixes are made on the main branch and shipped in the next release; earlier releases are not patched. Update to the latest release to receive fixes. This policy does not promise response deadlines, fix dates or rewards.

## Data privacy

[Privacy and data handling](docs/privacy.md) describes the App's data behavior. It is separate from this vulnerability-reporting policy.
