---
summary: "DeepSeek balance limits plus the optional console Search and Fetch fees."
ids: [deepseek]
read_when:
  - Changing DeepSeek balance handling or the optional console Search and Fetch fees
---

# DeepSeek

## Identity and ids

`deepseek` is a limits provider. Token Monitor does not collect DeepSeek token usage.

## Data sources

The API key reads the public balance endpoint. `balanceHistory.js` derives Today / Week / Month / All-time spend from its drops and is the only daily history.

The optional console token is a signed-in `platform.deepseek.com` Bearer token. It reads the current month's Search and Fetch fees from the private usage endpoint into `balance.searchSpend` and `balance.fetchSpend`. Only positive fees appear in the Spend tooltip, labeled Search and Fetch. Console months use the device's current UTC offset, including 30- and 45-minute offsets. Official acceptance of non-hour offsets has not been live-verified.

## Source precedence

The balance row stays authoritative when the optional console lookup fails: those failures are silent, are not cached, and leave the row unchanged. The next refresh retries the console request. A successful console result is cached for one hour per account, token, currency, and month. Both requests use the shared fetch timeout and error handling. Rows match by currency only.

Search and Fetch belong to the row of the device that read them; sync uses the normal whole-row selection. A synced view shows them only when the selected row came from a device with a console token, so a fresher row from a device without one shows the balance and local spend without them. Add the token on every device that reports this account to keep them visible.

## Credentials and transport

The API key is required in the form. It can also be supplied by `DEEPSEEK_API_KEY` or `DEEPSEEK_KEY`. The console token is optional, has no environment-variable lane, and is stored only when pasted. Stored credentials stay in the shared main-process credential store on this device and are never echoed back to the renderer. Requests use the injected transport.

Once the account is linked and `ok`, the paste fields hide. Clearing a Settings-stored account removes the stored API key and the console token. Adding or replacing the optional console token then means pasting the API key again with the token if wanted. There is no independent token-only update. If an environment-variable API key remains in effect, the account can stay linked, the paste fields stay hidden, and Settings has no Clear action, so the console token cannot be added from Settings.

## Invariants and known gaps

Search and Fetch fees are display-only: they are never added to the ledger, period spend fields, or meter, and the public surface strips them with `quotaGroup`/`tranches`.

## Verification

`node --test tests/shared/deepseekLimits.test.js` covers balance history, console fee mapping, successful cache reuse, month-change invalidation, and uncached failures. The tests use fixtures, not a live endpoint. A real API key and a current console token are still needed to confirm the private usage endpoint, including non-hour time zones.
