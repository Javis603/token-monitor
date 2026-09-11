# Privacy Policy

Token Monitor is local-first. It processes AI-tool usage logs on the device and does not send analytics or telemetry to the project maintainer. The project does not operate a hosted data-collection service.

## Network features

Token Monitor makes network requests only for documented or user-enabled features:

- Packaged builds check GitHub Releases for updates.
- Exchange-rate and service-status views fetch their public data sources.
- Enabled AI Tool Limits integrations contact the corresponding provider. Credentials are sent only to that provider.
- Discord Rich Presence sends the selected activity details to Discord when explicitly enabled.
- Multi-device sync sends data to the hub URL configured by the operator, or (when explicitly selected on macOS) writes sync snapshots to the user's iCloud Drive.

These requests are processed under the privacy policy of the service receiving them, including the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) for update checks and the [Discord Privacy Policy](https://discord.com/privacy) for Rich Presence. Review the applicable provider's privacy policy before enabling a provider-backed integration.

## Multi-device sync

Multi-device sync is optional and has no Token Monitor-operated default server. The operator chooses and controls the destination hub, whether it runs in the app, on a self-hosted Node server, or on Cloudflare Workers.

When enabled, sync can send device identifiers and metadata; aggregate token and cost totals; client, model, session, and project attribution; retained usage history; and normalized provider-limit status. Project attribution can include an opaque project identifier and workspace-folder label, but never an absolute workspace path. Provider limits can include a hashed account identifier, account email, and plan label so the authenticated hub can distinguish accounts.

Sync also carries manually recorded subscription metadata when any exists: the plan name, amount, currency, billing cadence, dates you entered, and the account each record is bound to. These are values you typed in, never read from a provider, and they are stored once per hub rather than per device. The public stats endpoints never expose them.

Sync does not send raw AI logs, prompts, source code, conversation content, OAuth credentials, access or refresh tokens, provider cookies, API keys, or raw provider responses. See the [API documentation](API.md) for the current wire format and public-endpoint redactions.

Data retention and access on a synchronized deployment are controlled by the operator of that hub and its infrastructure provider.

### iCloud Drive sync

iCloud Drive sync is an opt-in macOS feature and does not use a Token Monitor-operated server, CloudKit, or Apple Developer service. Token Monitor writes usage summaries, limits, retained history, device metadata, and manually entered subscription metadata to `iCloud Drive/Token Monitor/sync-v1/` so other Macs using the same Apple ID can aggregate them. The files are per-device/per-writer snapshots and iCloud Drive may propagate them with a delay.

Credentials are excluded: provider API keys, cookies, OAuth access or refresh tokens, authorization headers, and raw provider responses are not written to iCloud by this feature. iCloud storage, access, retention, and deletion are governed by Apple's iCloud terms and the user's Apple ID/device permissions.
