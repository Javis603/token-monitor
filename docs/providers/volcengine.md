---
summary: Volcengine explicit credentials and local arkcli Agent Plan discovery.
read_when: Changing Volcengine credentials, CLI detection, or quota mapping.
---

# Volcengine

Explicit AK/SK or Ark API key configuration keeps its existing query path. When no credentials are configured, the enabled Volcengine provider can use `arkcli auth status --format json` followed by `arkcli usage plan --product agent-plan --format json`.

The authenticated profile is pinned for the quota query. No login command is run, and credentials are never exported or copied into Token Monitor. arkcli owns SSO/STS refresh. A missing executable or logged-out CLI remains unconfigured; a failed or malformed query is unavailable rather than zero quota. The existing limits runtime retains last-good quota on transient failures.

The fallback currently queries the **personal Agent Plan** only, not team seats or Coding Plan. It maps recognized 5h/daily/weekly/monthly periods returned by the CLI; it cannot display a daily period omitted by arkcli. Positive quota is required to display a window. arkcli can omit `used` and `reset_at` after a window resets. A missing `used` is zero only when `percent` is the number `0`; an absent reset time stays unknown. Other unknown or malformed amounts, including explicit `null` usage, are not treated as zero.

Account identity hashes the CLI viewer's account/user/region, not profile name or tier. The CLI and explicit credential paths are exclusive so two accounts are never silently combined; even incomplete explicit credentials block fallback.

Discovery is on by default when the Volcengine provider is enabled; no extra arkcli opt-in is required. Token Monitor checks the inherited PATH first, then common npm, Homebrew, Bun, and local-bin locations. Set `TOKEN_MONITOR_VOLCENGINE_ARKCLI=0` to disable discovery, or `TOKEN_MONITOR_ARKCLI_COMMAND` to an explicit executable path for another installation.

For a headless deployment, enable `volcengine` in `TOKEN_MONITOR_LIMIT_PROVIDERS`, run the service as the logged-in user, and preserve that user's HOME. No extra polling service is needed.

Subprocesses run without a shell or stdin, with implicit arkcli updates disabled, bounded output and execution time, and cancellation/termination handling. Raw stdout/stderr (especially auth output) must never enter logs or Hub payloads.
