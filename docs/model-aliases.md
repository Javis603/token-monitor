# Model aliases

Open **Settings → Collection → Model aliases → Add alias** to merge names that you know refer to the same model. For example:

```json
{
  "anthropic/claude-opus-5": "claude-opus-5"
}
```

The left side is the model ID in a report; the right side is the group to display it under. Edit an existing row to change the mapping, or remove it to restore separate groups. No mappings are enabled by default.

Aliases apply to the widget's model, tool, session and project breakdowns, the macOS widget, and the trends dashboard, including already-retained history and usage received from other devices. Tokens, already-calculated costs and token components are added within each resulting model group. Tool, device and provider identities are not renamed. No model is re-priced.

Matching ignores case and treats `.` and `-` as equivalent. It does not strip provider prefixes, dated versions, `-pro`, or reasoning tiers automatically. Only explicitly configured aliases merge. Resolution is single-hop: with `a → b` and `b → c`, original `a` rows display as `b`, and original `b` rows display as `c`.

These are local display preferences, stored as `modelAliases` in the app's `settings.json`. They are not sent to the hub and do not alter source logs, collected records, archive/delta anchors, or exports. Changing a mapping re-projects retained source data; it does not require a rescan or an online hub. The full history's favorite model is recomputed when complete model totals are available; compact/legacy history without that attribution can only relabel its existing favorite until complete history is loaded.

## Relationship to Tokscale

[Tokscale v4.15.1 model aliases](https://github.com/junhoyeo/tokscale/blob/v4.15.1/crates/tokscale-core/src/model_alias.rs) provide a flat alias map, separator-insensitive lookup, and a single-hop fold after pricing. This feature follows that approach, but deliberately does not edit Tokscale's `settings.json`: Token Monitor ingests Tokscale's local `--group-by client,session,model` reports, then archives and synchronizes those results. Enabling aliases at that ingestion boundary would persist folded identities and make later mapping changes irreversible. Instead, Token Monitor applies its map only at Electron's presentation boundary. It also keeps archived version and reasoning-tier suffixes distinct rather than repeating Tokscale's broader syntactic normalization.

An independent alias configuration already applied by Tokscale or another producer cannot be undone here: source IDs lost before Token Monitor receives them are not recoverable. This feature preserves the IDs Token Monitor receives; it does not reconstruct unavailable provenance.
