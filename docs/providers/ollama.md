---
summary: "Ollama Cloud API and Cookie limits: legacy windows, monthly included credits, credit wallets, and account identity."
ids: [ollama]
read_when:
  - Changing Ollama limits collection, credential lanes, or account identity
  - Reviewing legacy session/weekly windows or monthly included-credit handling
---

# Ollama

## Credentials

The API-key lane calls `https://ollama.com/api/balance` with `Authorization: Bearer <key>` and reports source `api`; the session-cookie lane scrapes `https://ollama.com/settings` and reports source `web`. The API key is preferred when both are configured; Cookie is used only when no API key is configured, never after an API failure. Saving a credential in the GUI replaces the other lane. The credential-type selector defaults to API key for an unconfigured account and initializes from the effective configured lane for an existing account. It only changes the draft: switching clears the hidden input, submits only the selected credential and does not alter stored settings until Save. API mode opens the keys page with a short usage hint and `ollama-...` as a format-hint placeholder (not a prefix validation rule); Cookie mode keeps its extraction steps. The selector names the credential type; the inputs retain accessible names without repeating visible labels. `rememberProbe` applies only to the cookie lane; API mode is stateless.

## Data sources

Both HTTP 401 and 403 from the JSON API are authentication failures. A save probe rejects that draft without changing either saved credential; it never retries with Cookie. Main explicitly clears the other settings credential for a form's mutually exclusive `credentialChoice`, while environment credentials retain their existing precedence.

`/api/balance` returns an `included` object whose shape depends on the plan.

### Legacy plans

`included.session` and `included.weekly` each carry `remaining_percent` and `resets_at`. The session window is 300 minutes and the weekly window 10080 minutes. `usedPercent = 100 - remaining_percent`, and `resets_at` supplies the window reset.

### New plans

`included.balance_usd`, `included.allowance_usd`, and `included.period` describe monthly included credits. They map to one `billing` window with `metric: "credits"` and `currency: "USD"`, using `period.until` as the reset; new plans report no 5-hour or weekly windows. Monthly credits used is the nonnegative difference between allowance and balance, reported separately as a meterless `spend` window.

`purchased.balance_usd` maps to a separate **Credit balance** window, including on legacy plans and purchased-only accounts. Never add it to the included allowance. It has no quota denominator or reset timestamp: Ollama renderers keep `showMeter: false` and explicitly disable balance inference for these wallets. A reported zero remains a real zero; absent or malformed money stays absent. See the [official balance contract](https://docs.ollama.com/api/balance).

### Cookie settings pages

The Cookie path retains Session/Hourly/Weekly meters and also accepts **Monthly usage** and **Free usage**. Monthly dollar text such as `$7.50 of $60 used` supplies the included credit amounts and utilization; percentage-only or CSS meters supply only a monthly percentage. `data-time` supplies the reset when present. Neither an allowance nor a fixed month duration is inferred from a percentage or reset alone. Complete monthly labels avoid matching explanatory prose or repeated aria descriptions.

The **Usage credits** wallet layout supplies **Credit balance**, **Monthly credits used**, and refill text. These remain independent measurements: monthly spending never substitutes for a missing balance, and a refill target is neither a quota denominator nor an exact reset date. Wallet amounts use meterless `credits`/`spend` windows and may coexist with genuine quota meters. Parse complete elements within the wallet section so adjacent sections cannot provide missing values.

Included credits precedes Credit balance on the card and Home display. Monthly credits used appears in its existing-style info tooltip, alongside refill text on the card; included usage keeps its own separate quota row. Home uses full-width Ollama readings so a wallet amount never shares a grid row with a quota bar. If no wallet balance is displayed, monthly spending remains a standalone reading, including after two legacy quotas or when the wallet is hidden. The wire retains the independent `credits`/`spend` measurements; this grouping is presentation only.

Cookie markup follows the sanitized shapes in CodexBar's [parser tests](https://github.com/steipete/CodexBar/blob/d34fbb47afe73f81dd591bae28a60f72c39a9fe4/Tests/CodexBarTests/OllamaUsageParserTests.swift) and [wallet tests](https://github.com/steipete/CodexBar/blob/d34fbb47afe73f81dd591bae28a60f72c39a9fe4/Tests/CodexBarTests/OllamaCreditWalletTests.swift). Local fixtures are bounded parser/transport/display evidence, not live-account acceptance.

## Account identity

`/api/balance` carries no identity, so API mode calls `POST https://ollama.com/api/me` (undocumented) for the account email and plan. Its fields are read case-insensitively (`Email`/`email`, `Plan`/`plan`). The email is hashed like the cookie lane's identity, so an account keeps the same `accountKey` across lanes and devices; a successful lookup is cached for six hours. If `/api/me` is unavailable, a key-derived identity keeps the reading usable and the failure is not retried for five minutes. Identity removals compare against the runtime's accepted `previousLimits` rows, not a fetcher-side record of emitted identities. A changed identity emits a `{ provider: "ollama", accountKey: <previous>, removed: true }` control row until the runtime accepts the replacement, so a superseded lookup cannot consume the removal and leave both rows behind. A save probe checks only `/api/balance`; identity resolution belongs to the poll that follows, and the probe leaves no cache behind.

## Rate limit

`/api/balance` allows 10 requests per minute per account, shared across API keys and devices. The app polls every 5 minutes.

## Verification

Run `node --test tests/shared/ollamaLimits.test.js tests/shared/ollamaCookieCredits.test.js tests/shared/limitBalanceDisplay.test.js tests/electron/edgeDockLimitCard.test.js tests/electron/homeOverview.test.js`.
