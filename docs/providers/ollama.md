---
summary: "Ollama Cloud limits from an API key or session cookie, covering legacy usage windows, monthly included credits, and account identity."
ids: [ollama]
read_when:
  - Changing Ollama limits collection, credential lanes, or account identity
  - Reviewing legacy session/weekly windows or monthly included-credit handling
---

# Ollama

## Credentials

The API-key lane calls `https://ollama.com/api/balance` with `Authorization: Bearer <key>` and reports source `api`; the session-cookie lane scrapes `https://ollama.com/settings` and reports source `web`. The API key is preferred when both are configured, and the cookie lane is the fallback. Saving a credential in the GUI replaces the other lane. `rememberProbe` applies only to the cookie lane; API mode is stateless.

## Data sources

`/api/balance` returns an `included` object whose shape depends on the plan.

### Legacy plans

`included.session` and `included.weekly` each carry `remaining_percent` and `resets_at`. The session window is 300 minutes and the weekly window 10080 minutes. `usedPercent = 100 - remaining_percent`, and `resets_at` supplies the window reset.

### New plans

`included.balance_usd`, `included.allowance_usd`, and `included.period` describe monthly included credits. They map to one `billing` window with `metric: "credits"` and `currency: "USD"`, using `period.until` as the reset; new plans report no 5-hour or weekly windows. Only the included allowance is displayed: `purchased.balance_usd` is not shown.

## Account identity

`/api/balance` carries no identity, so API mode calls `POST https://ollama.com/api/me` (undocumented) for the account email and plan. Its fields are read case-insensitively (`Email`/`email`, `Plan`/`plan`). The email is hashed like the cookie lane's identity, so an account keeps the same `accountKey` across lanes and devices; a successful lookup is cached for six hours. If `/api/me` is unavailable, a key-derived identity keeps the reading usable and the failure is not retried for five minutes. When the real identity is resolved later, the provider emits a `{ provider: "ollama", accountKey: <fallback>, removed: true }` control row so the fallback row is retired. A save probe uses no cache and leaves none behind.

## Rate limit

`/api/balance` allows 10 requests per minute per account, shared across API keys and devices. The app polls every 5 minutes.

## Verification

Run `node --test tests/shared/ollamaLimits.test.js`.
