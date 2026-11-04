---
summary: "Estimated ChatGPT Pro API credit from the published allowance minus organization Costs since the renewal date."
ids: [openai]
read_when:
  - Changing the OpenAI API-credit estimate or its Costs query
  - Explaining why the OpenAI row is not the billing-page balance
  - Distinguishing the openai limits provider from Codex usage windows
---

# OpenAI

## Identity and ids

`openai` is a limits-only provider. It is separate from `codex`: Codex windows are ChatGPT/Codex usage quotas, and a Codex plan name is not an API-credit allowance. This provider reads no local Codex session and does not infer a quota multiplier from `prolite`, `pro`, or `promax`.

## Data sources

OpenAI publishes no remaining-credit endpoint. The official Costs API, `GET /v1/organization/costs`, returns daily billed `amount.value` for an organization. The allowance is the configured ChatGPT Pro tier, not a value read from the API:

| Plan | Allowance per monthly period |
| --- | --- |
| `pro5x` | $100 |
| `pro20x` | $200 |
| `pro50x` | $500 |

`pro-5x`, `5x`, and `pro100` normalize to `pro5x`; the same pattern applies to the $200 and $500 tiers. The renewal field is a real `YYYY-MM-DD`. Only its day of month is the anchor. The current period is the UTC month `[start, end)` that contains now. A shorter month clamps that one occurrence, so a 31st anchor runs Jan 31 → Feb 28/29 → Mar 31. Costs are queried from the period start through the earlier of the period end and the next UTC midnight, so the in-progress day is included. Daily USD `amount.value` rows whose bucket starts inside the period are summed. The query is organization-wide: a project filter would undercount.

The window is `API credit`, with `used` equal to that sum, `limit` equal to the full published allowance, and `remaining` equal to the difference floored at zero. `resetsAt` is the period end and `boundaryKind` is `expiry`, because unused credit expires instead of rolling over. The balance amount is the same remaining figure.

## Source precedence

An explicit saved value wins over the environment for each field. Admin-key aliases are `TOKEN_MONITOR_OPENAI_ADMIN_KEY`, then `OPENAI_ADMIN_KEY`. Plan aliases are `TOKEN_MONITOR_OPENAI_SUBSCRIPTION_PLAN`, then `OPENAI_SUBSCRIPTION_PLAN`. Renewal aliases are `TOKEN_MONITOR_OPENAI_SUBSCRIPTION_RENEWAL`, then `OPENAI_SUBSCRIPTION_RENEWAL`. A missing key, plan, or renewal date is `notConfigured` and does not call the API.

## Credentials and transport

The require-free `account.js` declares the Admin key as a password, the plan as a select, and the renewal date as plain text. The key is stored at `providers.openai.apiKey`. The plan and date are settings, stay visible after linking, and save when changed. Requests use the injected limits transport and `Authorization: Bearer`. HTTP 401 and 403 are `unauthorized`. The account key is a hash of the Admin key; the key itself is not returned.

The panel opens only `https://platform.openai.com/settings/organization/billing`.

## Invariants and known gaps

This is an estimate. It can disagree with the billing page. Costs are billed usage, not a credit ledger: promotional credit, purchased credit, and other grants are not visible here, and reported cost is not necessarily a draw on the subscription grant. The first grant is not prorated; the full tier amount is used for every period, including a partial first period. Codex usage that is not billed through this organization is not included. Non-USD amounts, malformed pages, and a Costs response that still has another page after the page cap are `unavailable` rather than a remaining balance of the full allowance. A negative remainder is shown as zero remaining with the meter at 100%.

## Verification

```bash
node --test tests/shared/openaiLimits.test.js
```

A live check needs an organization Admin key (`sk-admin-...`), the Pro tier, and the renewal date. Compare the row with the billing page only as a rough check; an exact match is not the contract.
