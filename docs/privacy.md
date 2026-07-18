# Privacy Policy

Token Monitor is local-first. It processes AI-tool usage logs on the device and does not send analytics or telemetry to the project maintainer. The project does not operate a hosted data-collection service.

## Network features

Token Monitor makes network requests only for documented or user-enabled features:

- Packaged builds check GitHub Releases for updates.
- Exchange-rate and service-status views fetch their public data sources.
- Enabled AI Tool Limits integrations contact the corresponding provider. Credentials are sent only to that provider.
- Discord Rich Presence sends the selected activity details to Discord when explicitly enabled.
- Multi-device sync sends data to the hub URL configured by the operator.

These requests are processed under the privacy policy of the service receiving them, including the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) for update checks and the [Discord Privacy Policy](https://discord.com/privacy) for Rich Presence. Review the applicable provider's privacy policy before enabling a provider-backed integration.

## Multi-device sync

Multi-device sync is optional and has no Token Monitor-operated default server. The operator chooses and controls the destination hub, whether it runs in the app, on a self-hosted Node server, or on Cloudflare Workers.

When enabled, sync can send device identifiers and metadata; aggregate token and cost totals; client, model, session, and project attribution; retained usage history; and normalized provider-limit status. Project attribution can include an opaque project identifier and workspace-folder label, but never an absolute workspace path. Provider limits can include a hashed account identifier, account email, and plan label so the authenticated hub can distinguish accounts.

Sync does not send raw AI logs, prompts, source code, conversation content, OAuth credentials, access or refresh tokens, provider cookies, API keys, or raw provider responses. See the [API documentation](API.md) for the current wire format and public-endpoint redactions.

Data retention and access on a synchronized deployment are controlled by the operator of that hub and its infrastructure provider.
