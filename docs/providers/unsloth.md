---
summary: "Unsloth Studio inference usage: SQLite source, bounded watches, and pricing boundaries."
ids: [unsloth]
read_when:
  - Changing Unsloth source detection or watch behavior
  - Debugging missing Unsloth usage or cost estimates
---

# Unsloth Studio

Unsloth is a regular Tokscale client (`unsloth`), enabled by default on new installs. Existing saved client selections are preserved; enable Unsloth in the tracked-tools settings if it is not selected. The widget and headless agent use the same collector. No Unsloth credentials or API connection are needed.

## Source

Tokscale 4.15.1 reads `~/.unsloth/studio/studio.db`, or `studio.db` directly under `UNSLOTH_STUDIO_HOME` when that override is nonblank. Token Monitor checks for the database itself, not merely the Studio installation directory.

Changes to `studio.db` and `studio.db-wal` directly under that directory trigger a targeted refresh. The collector ignores `studio.db-shm` events because its own read-only scans can rewrite that wal-index. Watching the parent allows a database or WAL created after startup to be detected, without recursively watching model weights, environments, or logs. A missing parent is discovered on a later full collection.

The upstream parser reads scalar inference metadata from Studio chat messages and local API usage events. It does not select message content, prompts, or response previews. Training tokens and native session-detail views are outside this integration.

WSL discovery recognizes the default database path. As with other SQLite clients, if Windows cannot read a live database over the WSL share, run the headless agent inside WSL and sync through a hub.

## Cost

Local inference has zero API cost; this is not an estimate of hardware or electricity costs. Studio chats routed to recognized metered providers use Tokscale's model pricing. Unknown, custom, and subscription-backed routes remain unpriced unless an exact custom-pricing override is supplied. A displayed zero is therefore not proof that every route was free, and estimates are not an invoice or a historical price ledger.
