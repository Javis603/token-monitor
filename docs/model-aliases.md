# Model aliases

Token Monitor automatically groups model IDs that are demonstrably the same model in the data it is displaying. Common examples are a provider-qualified ID next to its bare form, or names that differ only by case and separators:

```text
anthropic/claude-opus-5       → claude-opus-5
claude-opus-5-cc              → claude-opus-5
openrouter/anthropic/Claude.Sonnet_4.5
                               → claude-sonnet-4-5
```

Automatic grouping is evidence-based: it runs only when at least two equivalent IDs are present. It compares the terminal model ID, ignores case and `.`, `_`, spaces, or `-`, and folds the Claude Code `-cc` suffix only when the matching base ID is also present. Dated builds, reasoning tiers, model sizes, quantization labels and other suffixes remain separate.

Open **Settings → Collection → Model aliases → Add alias** when two names refer to the same model but cannot be matched by those conservative rules. The left side is the reported model ID; the right side is the group to display it under. A direct manual mapping overrides automatic matching for that reported ID. Mapping the automatically selected canonical name changes the whole duplicate group. Resolution remains single-hop, so `a → b` and `b → c` display original `a` rows as `b` and original `b` rows as `c`.

Aliases apply to model, tool, session and project breakdowns, the macOS widget, trends, retained history and usage received from other devices. Tokens, already-calculated costs and token components are added within the resulting model group. Tool, device and provider identities are not renamed, and no model is re-priced.

Both automatic and manual grouping are presentation-only. Manual mappings are stored as `modelAliases` in the desktop `settings.json`; they are not sent to the hub. Source logs, collected records, archive and delta anchors, sync payloads, custom-pricing identities and lossless exports retain the original model IDs. Removing a manual mapping immediately rebuilds the view from those original IDs without a rescan.

## Relationship to Tokscale

Tokscale also supports a flat, single-hop alias map after pricing. Token Monitor keeps this setting at Electron's presentation boundary instead of writing Tokscale's global configuration, because Token Monitor archives and synchronizes the reports it receives. Folding identities before that boundary would make a later reversal impossible. An alias already applied by Tokscale or another producer cannot be undone after the source ID has been lost.
