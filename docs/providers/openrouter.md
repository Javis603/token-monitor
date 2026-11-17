---
ids: [openrouter]
summary: OpenRouter API key slots, quota transport, migration and legacy IPC compatibility.
read_when:
  - Changing OpenRouter credentials, account slots, migration, or quota fetching.
---

# OpenRouter

OpenRouter uses the shared account slot panel with a single API key field. Regular and Management keys use only the official `/api/v1/key` and `/api/v1/credits` endpoints through the injected transport. Either successful endpoint is enough for a usable reading; a regular key can lack access to credits. Account identity is `hashKey('openrouter', apiKey)`, independent of the local label. There is no interactive sign-in or local discovery.

The environment lane resolves `TOKEN_MONITOR_OPENROUTER_API_KEY` before `OPENROUTER_API_KEY`. Matching saved credentials and environment credentials produce one account reading; disabled saved slots do not suppress the environment lane. Saved slots never borrow environment credentials. Scoped refreshes use account keys, retaining subscription and history bindings across migration and renaming.

On first load, main imports the former `openrouterProfiles` map into credential-store slots, keeping map order, profile names as labels, enabled flags and exact API-key hashes. A stored fixed key precedes those profiles. Stable import IDs allow retry after the destination write. Main verifies the destination from disk before stripping the old fields and recording `migrations.accountSlots.openrouter`. Older app versions cannot see migrated profiles. Environment keys are never imported. A source that cannot fit the slot limit remains intact and migration reports an error rather than dropping accounts.

Saving follows the shared slot policy: an unauthorized probe rejects the key; an indeterminate probe (such as a temporary network failure) saves it for later checking. This also applies to the legacy `openrouter:*` IPC methods, which forward name-based operations to the slot service. Those methods remain available through preload for compatibility; the settings UI uses only slot commands. The old map is migration input, never a second writable account store.
