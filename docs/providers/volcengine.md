---
summary: "Volcengine explicit credentials and local arkcli personal-plan discovery."
ids: [volcengine]
read_when:
  - Changing Volcengine credentials, CLI detection or quota mapping
---

# Volcengine

Explicit AK/SK or Ark API key configuration keeps its existing query path. When no credentials are configured, the enabled Volcengine provider can use `arkcli auth status --format json`, then `arkcli plans get --format json` to learn which personal plans the account owns, then `arkcli usage plan --product <plan> --format json` for each owned plan.

The subscription list is authoritative. `usage plan --product` answers `subscribed: true` with all-zero periods for a plan the account never bought, so querying both products unconditionally would display a phantom plan with a full bar. Only `Effective` and `Running` establish an active personal subscription; `Pending` and `Expired` do not. Unknown states or entries with `error` mean unknown ownership, not an owned or absent plan. Failed or malformed discovery is unavailable and never falls back to unverified quota queries; CLI builds without `plans get` must be upgraded. Successful sibling plans remain available.

The [official plans-get documentation](https://github.com/volcengine/ark-cli/blob/e277b20ba5be85312ebf625f59e8ccbc05951432/skills/arkcli-plans/references/arkcli-plans-get.md) lists personal `Effective`/`Pending`/`Expired` and team `Running`. Personal `Running` remains accepted because the [PR author's real-account report](https://github.com/Javis603/token-monitor/pull/1211#issuecomment-6409808802) observed `plans get` listing `coding-plan` (pro, Running), followed by a working Coding Plan quota row. This is a reported observation, not a captured JSON fixture proving the exact `scope` field or a complete upstream status enum; the documentation alone is insufficient reason to reject that observed working status.

The authenticated profile is pinned for the quota query. No login command is run, and credentials are never exported or copied into Token Monitor. arkcli owns SSO/STS refresh. A missing executable or logged-out CLI remains unconfigured; a failed or malformed query is unavailable rather than zero quota. The existing limits runtime retains last-good quota on transient failures. Partial failures return an identity-keyed unavailable result using the viewer established by a successful sibling response, so the shared retry policy sees the failure without downgrading the healthy plan. With no verified viewer, a generic unavailable result preserves the existing lane failure behavior.

The fallback queries the **personal Agent Plan and Coding Plan**, not team seats. Each plan has its own account identity and is queried independently, so a failed sibling cannot hide a successful reading. Transient failures retain last-good data as unavailable. An explicit `subscribed: false`, or a successful subscription list that excludes a product, removes only the previously observed CLI identity matching that viewer and product through the existing runtime removal mechanism. The list itself has no viewer: an owned plan's valid usage response establishes identity; when none is available and cached CLI identities exist, one bounded usage query for a confirmed absent product supplies identity only, and its quota is ignored. If identity cannot be verified, cached data stays unavailable. No cached account is removed merely because the current CLI profile name or another account's subscription list matches. An account with no personal plans and no cached CLI identities needs no usage query.

Recognized windows are 5h/session, daily, weekly and monthly; a period omitted by arkcli cannot be displayed. Percentage-only periods (including Coding Plan) use the reported `percent` without inventing absolute used/total amounts. Absolute-quota periods require a positive total; arkcli can omit `used` after a window resets, but a missing `used` is zero only when `percent` is the number `0`. An absent reset time stays unknown. Other unknown or malformed amounts, including explicit `null` usage, are not treated as zero.

Account identity hashes the CLI viewer's account/user/region and product, not profile name or tier. Existing Agent Plan identities stay unchanged. The CLI and explicit credential paths are exclusive so two accounts are never silently combined; even incomplete explicit credentials block fallback. To use CLI discovery, clear any saved Volcengine keys and corresponding credential environment variables, then run `arkcli auth login` as the same local user. An Ark inference API key alone is not equivalent to a logged-in CLI subscription query and does not guarantee the console's session/weekly/monthly quota windows.

Discovery is on by default when the Volcengine provider is enabled; no extra arkcli opt-in is required. Token Monitor checks the inherited PATH first, then common npm, Homebrew, Bun, and local-bin locations. Set `TOKEN_MONITOR_VOLCENGINE_ARKCLI=0` to disable discovery, or `TOKEN_MONITOR_ARKCLI_COMMAND` to an explicit executable path for another installation.

For a headless deployment, enable `volcengine` in `TOKEN_MONITOR_LIMIT_PROVIDERS`, run the service as the logged-in user, and preserve that user's HOME. No extra polling service is needed.

Subprocesses run without a shell or stdin, with implicit arkcli updates disabled, bounded output and execution time, and cancellation/termination handling. Raw stdout/stderr (especially auth output) must never enter logs or Hub payloads.
