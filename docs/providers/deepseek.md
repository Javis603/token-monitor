---
summary: "DeepSeek balance limits plus the optional console Search and Fetch fees."
ids: [deepseek]
read_when:
  - Changing DeepSeek balance handling or the optional console Search and Fetch fees
---

# DeepSeek

The API key reads the public balance endpoint; `balanceHistory.js` derives Today / Week / Month / All-time spend from its drops and is the only daily history.

The optional console token is a signed-in `platform.deepseek.com` Bearer token. It reads the current month's Search and Fetch fees from the private usage endpoint into `balance.searchSpend` and `balance.fetchSpend`; only positive fees appear in the Spend tooltip. Successful results are cached for one hour per account, token, currency and month; failures retry on the next refresh. Console months use a fixed whole-hour UTC offset, rounded down from the device's current offset. There is no env lane, and the form folds once the account is linked.

Boundaries: both fees are display-only — never in the ledger, period spend fields or meter, and stripped from public stats. Failures are silent and leave the balance row unchanged; rows match by currency only.
