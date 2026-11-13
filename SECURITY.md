# Security policy

> DRAFT — not ready to publish. The maintainer must confirm a working private reporting channel before this policy and the issue-form security link are published. No reporting address or private-reporting availability has been verified for this draft.

## Reporting a vulnerability

**Private reporting channel: pending maintainer confirmation.** Do not open a public issue containing exploit details, credentials or private user data. This draft does not establish a working reporting route.

When a private channel is confirmed, a useful report includes:

- The Token Monitor version/build or source commit, OS and affected component (desktop App, headless agent, Hub, Worker or integration).
- The impact, prerequisites and a minimal reproduction using test accounts/data you control.
- Small, sanitized supporting evidence. Remove tokens, API keys, cookies, passwords, personal paths and conversation content. Do not send full settings, databases or session logs.
- Relevant dependency versions or the bundled tokscale pin, if known. An upstream fix being merged does not establish that a shipped App includes it.

Test only systems and accounts you own or have permission to test. Avoid accessing other users' data or disrupting services.

## Scope and versions

Reports should concern Token Monitor or its bundled dependencies. Issues solely in a third-party service should go to that service's security channel; explain any Token Monitor-specific exposure separately.

**Supported-version policy: pending maintainer confirmation.** This draft does not promise backports, response deadlines, fix dates or rewards.

## Data privacy

[Privacy and data handling](docs/privacy.md) describes the App's data behavior. It is separate from this vulnerability-reporting policy.
