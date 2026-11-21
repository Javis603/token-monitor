---
summary: "DeepSeek balance limits and the optional console Search and Fetch fees."
ids: [deepseek]
read_when:
  - Changing DeepSeek balance handling or the optional console fees
---

# DeepSeek

## Data sources

The API key reads the public balance endpoint; `balanceHistory.js` derives Today / Week / Month / All-time spend from balance drops. An optional console token, a signed-in `platform.deepseek.com` Bearer token, reads the current month's Search and Fetch fees from a private usage endpoint into `balance.searchSpend` and `balance.fetchSpend`. They are display-only: positive values appear in the Spend tooltip, are never added to local spend or the ledger, and are stripped from public stats.

## Source precedence

A failed console lookup leaves the balance row unchanged and is retried on the next refresh; a successful one is cached for an hour per account, token, currency and month. Sync keeps the normal whole-row selection, so a fresher row from a device without a console token shows the balance and local spend without Search or Fetch.

## Credentials and transport

The API key can also come from `DEEPSEEK_API_KEY` or `DEEPSEEK_KEY`; the console token has no environment-variable lane. Use the account row's Replace API key action to change the key or optional console token. Environment-variable accounts are read-only; add a stored account to configure its console token.

## Invariants and known gaps

The private endpoint, its response shape and non-hour UTC offsets are not live-verified; the tests use fixtures.

## Verification

`node --test tests/shared/deepseekLimits.test.js`
