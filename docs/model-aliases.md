# Model aliases

The same model often reaches Token Monitor under more than one ID — a provider-qualified ID next to its bare form, or names differing only in case and separators:

```text
anthropic/claude-opus-5                  → claude-opus-5
openrouter/anthropic/Claude.Sonnet_4.5   → claude-sonnet-4-5
```

Model aliases group those IDs in this app's views. Two ways to get there, and both are presentation-only.

## Automatic grouping (off by default)

**Settings → Collection → Model aliases → Group duplicate model names.**

It is evidence-based: it only merges when the same model is present under two spellings *at once*. It compares the terminal segment of the ID, ignoring case and `.`, `_`, spaces and `-`. Dated builds, reasoning tiers, model sizes, quantization labels and other suffixes stay separate.

An ID that appears only one way is left alone. `commandcode/deepseek-v4.1-flash` on its own keeps its prefix, because nothing in the data shows the prefix is redundant — and a provider prefix is frequently which supply channel, and therefore which bill, the tokens came from. The same reasoning is why it is off by default: the only moment automatic grouping acts is the moment two channels are both present, which is also when the difference between them can be real.

Vendor-specific suffixes such as a reseller's `-cc` are likewise not folded automatically. Add a mapping for those.

## Manual aliases

**Settings → Collection → Model aliases → Add alias**, for anything the automatic rules leave apart — including renaming a single provider-qualified ID, which automatic grouping will never do.

The left side is the reported model ID; the right side is the group to display it under. A manual mapping applies whether or not automatic grouping is on, and overrides it for that reported ID. Mapping the canonical name of an automatic group moves the whole group. Resolution is single-hop, so `a → b` and `b → c` display original `a` rows as `b` and original `b` rows as `c`.

## What grouping touches

Aliases apply to model, tool, session and project breakdowns, the macOS widget, trends, retained history and usage received from other devices. Tokens, already-calculated costs and token components are added within the resulting group. Tool, device and provider identities are not renamed, and no model is re-priced.

Manual mappings are stored as `modelAliases` in the desktop `settings.json` and the toggle as `modelAliasAutoMerge`; neither is sent to the hub. Source logs, collected records, archive and delta anchors, sync payloads, custom-pricing identities and lossless exports keep the original model IDs. Turning the toggle off, or removing a mapping, rebuilds the view from those original IDs without a rescan.

## Relationship to Tokscale

Tokscale has its own flat, single-hop, post-pricing alias map (`modelAliases` in its `settings.json`), and draws the same line we do: its `canonical_model_id` — the ID that leaves the machine — never consults it.

Do not use Tokscale's map to drive Token Monitor. That boundary is drawn around *Tokscale's* display, and it cuts through the middle of ours. Tokscale excludes `graph` from the fold because `graph` is its submit/export payload — and `graph` is where Token Monitor's history comes from. Its report surfaces do fold — and those are where Token Monitor's usage periods come from, which are then posted to the hub. Configuring aliases there produces a half-grouped app whose periods and trends disagree, with the grouped names already persisted server-side where removing the alias cannot reach them.

Keeping the setting at Electron's presentation boundary is what makes it reversible.
