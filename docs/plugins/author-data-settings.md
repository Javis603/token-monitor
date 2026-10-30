# Data and settings API

These are plugin `ctx` methods, not the [Hub HTTP API](../API.md). Use them from `activate(ctx)` or its mounts. The [quickstart](author-quickstart.md) supplies a minimal manifest and import steps; no backend is needed for these examples.

## Read a snapshot

`await ctx.data.query(query)` reads captured data for the App's selected source. It does not probe providers or start another collector. The host defaults `version` to `1`; callers need not supply it.

| Query option | Contract |
| --- | --- |
| `resource` | Required: `usage`, `models`, `tools`, `devices`, `projects`, `sessions`, `history`, `limits`, `subscriptions`, `status` |
| `period` | `today` (default), `month`, `allTime` |
| `filter` | Optional string-valued filters; see below. Use returned opaque IDs, not raw host IDs. |
| `sort` | `{field, direction}`; default `id` / `asc`. Fields: `id`, `totalTokens`, `knownUsd`, `updatedAt`, `lastUsedAt`, `date`, `label`; direction `asc` or `desc`. Choose a field meaningful for the resource. |
| `page` | `{limit, cursor?}`; default limit 100, range 1–500. Omit cursor for the first page. |
| `resolution`, `groupBy` | History only: `daily` / `monthly` / `summary`, and `none` / `model` / `client`; defaults `daily`, `none`. |

Supported filter keys (values are strings of at most 256 characters):

| Resource | Filters |
| --- | --- |
| `usage`, `status` | `id`, `deviceId` |
| `models` | `id`, `deviceId`, `model`, `search` |
| `tools` | `id`, `deviceId`, `client`, `model`, `search` |
| `devices` | `id`, `deviceId`, `search` |
| `projects`, `sessions` | `id`, `deviceId`, `projectId` (sessions only), `client`, `model`, `search` |
| `history` | `id`, `deviceId`, `from`, `to`, `client`, `model` |
| `limits` | `id`, `deviceId`, `accountId`, `provider`, `search` |
| `subscriptions` | `id`, `accountId`, `provider`, `search` |

`from`/`to` bound history dates inclusively. `search` matches available title/label/account/plan text case-insensitively. IDs are opaque and scoped to the plugin and selected source/privacy identity; do not parse them or assume they survive a source/privacy change.

### Results and failure handling

The result contains `version`, `schemaVersion`, `snapshotRevision`, `availability`, `rows`, `pageInfo: {nextCursor, hasMore}` and `aggregateCoverage`. Successful snapshots also carry `asOf`, `collectedAt`, `freshness: {ageMs, state}` and `redacted`. Treat absent metadata on failure results as unavailable, rather than inventing timestamps or coverage.

- Check `availability` before using rows. `available` can still have partial coverage; `notCollected` is not an empty measured total. Other outcomes include `scopeUnavailable`, `denied`, `temporarilyUnavailable`, `budgetExceeded` and `rateLimited` (with `retryAfterMs`). Do not busy-loop retries.
- Invalid input is normally returned as an availability result such as `invalidFilter`, `invalidPeriod` or `unsupportedResource`; transport/disabled-plugin failures can reject the Promise. Handle both paths.
- Read `freshness.state` (`fresh`, `stale`, `unknown`) and `aggregateCoverage.kind` (`authorizedCollection`, `partial`, `unavailable`). Page sums are not necessarily whole-source totals. Missing remote/lifetime session detail stays missing.
- Limits rows expose `provider` as the stable provider identifier and `providerLabel` as the App's tool display name (for example `codex` / `Codex`, or `opencode` / `OpenCode`). Unknown providers retain their identifier as the label. Use the label for presentation and the identifier for filters and deduplication; a display name is not an account identity. Each limits window exposes `displayLabel` from the same display helper used by the App (for example Session, Weekly, Monthly or 5-hour), preserving an explicit provider label when present. The original nullable `label` remains unchanged; display defaults do not alter wire data.
- Usage rows expose `totalTokens` and `cost: {knownUsd, unpricedTokens, currency, completeness}`. `knownUsd: null` is unknown, not zero; a partial known amount is not the complete bill. Do not coerce missing values with `|| 0`.

Keep the same query options when passing `pageInfo.nextCursor` as `page.cursor`. Ordinary data updates can leave an admitted cursor usable against its captured snapshot. If `availability` is `snapshotExpired` or `invalidCursor`, discard accumulated pages and restart without a cursor. Do not combine rows from different traversals. A source/privacy reset also requires clearing old rows and cursors.

## Live updates with cleanup

Replace the quickstart's `ui.mjs` with this example. It displays today's usage, receives the initial snapshot through the subscription, and refetches on invalidation. It shows status rather than presenting missing data as zero.

```js
export function activate(ctx) {
  return {
    mount(container) {
      const output = document.createElement('p');
      output.textContent = 'Loading usage…';
      container.append(output);
      const query = { resource: 'usage', period: 'today' };
      let closed = false, generation = 0, unsubscribe;

      function show(result) {
        if (closed) return;
        output.textContent = result.availability === 'available'
          ? `${result.rows.map(row => row.totalTokens ?? 'Unknown').join(', ')} tokens (${result.freshness.state})`
          : `Data: ${result.availability}`;
      }
      async function refetch() {
        const request = ++generation;
        try {
          const result = await ctx.data.query(query);
          if (request === generation) show(result);
        } catch (error) {
          if (!closed && request === generation) output.textContent = error.message;
        }
      }
      async function start() {
        try {
          const stop = await ctx.data.subscribe(query, event => {
            if (closed) return;
            if (event.type === 'snapshot') show(event.value);
            else if (event.type === 'invalidate') {
              if (event.reset) output.textContent = 'Source changed; reloading…';
              if (event.refetch) void refetch();
            }
          });
          if (closed) stop(); // Mount may have closed during subscription setup.
          else unsubscribe = stop;
        } catch (error) {
          if (!closed) output.textContent = error.message;
        }
      }
      void start();
      return {
        dispose() {
          closed = true;
          ++generation; // Ignore an in-flight result after disposal.
          unsubscribe?.();
          output.remove();
        }
      };
    }
  };
}
```

`await ctx.data.subscribe(query, callback)` resolves to an unsubscribe function. Subscribe without a cursor. Events are `{type:'snapshot', value, sequence}` followed by coalesced `{type:'invalidate', refetch, reset, sequence, ...}` events, not a stream of row patches. Do not throw from the callback. On `reset`, clear cached rows/cursors before refetching. The example uses a fixed period; for a period-dependent view, unsubscribe and resubscribe when `update(context)` changes its query. Honor `visible:false` by releasing work you do not need while hidden. Use `ctx.onDispose(fn)` for module-owned resources and mount `dispose()` for mount-owned resources.

## Plugin settings

Add this top-level `settings` member to the quickstart manifest (keep its UI and file declarations):

```json
{
  "settings": {
    "version": 1,
    "fields": [
      {"id":"showCost","type":"boolean","label":"Show cost","default":false},
      {"id":"rowLimit","type":"number","label":"Rows","default":20,"integer":true,"min":1,"max":100}
    ]
  }
}
```

This creates a native form that works even with plugin code disabled. A custom `settings` view is optional and executes trusted UI only when enabled.

Each field needs a unique `id`, `type`, `label` and valid `default`; `description` is optional. Labels/descriptions may be strings or locale maps. There are at most 64 fields. IDs start with an ASCII letter, then letters, digits, `_` or `-`, up to 64 characters; prototype-reserved names are rejected.

| Type | Additional schema options |
| --- | --- |
| `boolean` | Boolean default/value |
| `number` | Finite number; optional `min`, `max`, `integer` |
| `string` | `minLength` (default 0), `maxLength` (default 4096), both within 0–4096 |
| `select` | `options: [{value:'compact', label:'Compact'}, ...]`; value/default must match an option |

### Read and save

Use `ctx.host.call('settings.get')` and `ctx.host.call('settings.update', request)` for **this plugin's** preferences. No plugin ID is passed. Both return a snapshot with `pluginId`, `schema`, `schemaVersion`, `storedSchemaVersion`, `revision`, `values`, `errors`, `status` and `readOnly`.

For example, call this helper from your custom editor's Save handler. Pass the snapshot captured when the editor loaded, so concurrent edits are detected:

```js
async function saveShowCost(ctx, current, checked, feedback) {
  if (current.readOnly) {
    feedback.textContent = 'Settings were saved by a newer schema; update the plugin.';
    return current;
  }
  try {
    const saved = await ctx.host.call('settings.update', {
      schemaVersion: current.schemaVersion,
      expectedRevision: current.revision,
      patch: { showCost: checked }
    });
    feedback.textContent = 'Saved';
    return saved; // Keep this revision for the next save.
  } catch (error) {
    feedback.textContent = `Save failed: ${error.message}. Reload settings before retrying.`;
    return current; // Keep the draft; do not silently overwrite a competing edit.
  }
}
```

Load the editor with `const current = await ctx.host.call('settings.get')` inside a try/catch. `status` is `ready`, `invalid` or `newer-schema`. `errors` maps invalid stored field IDs to validation reasons; those values are exposed as `null` and need explicit repair. Respect `readOnly` on schema downgrade.

`settings.update` patches declared fields only. A stale revision/schema rejects with `settings-conflict`; invalid fields reject with `invalid-settings-values`; a newer stored schema rejects with `settings-newer-schema`. Display failure feedback and reload deliberately before retrying; do not assume custom Error properties survive renderer IPC. `settings.get` also rejects if no schema is declared or the store cannot be read.

Increase `settings.version` when changing the schema. Optional declarative renames use `migrations: [{fromVersion:1, renames:{oldName:'newName'}}]` in a higher-version schema. Removed/unknown stored keys are retained privately for compatibility, not writable through the patch API. Rollback restores code, not arbitrary backend data migrations. This JSON preference store is not a secret vault; keep credential handling in a trusted backend and disclose its storage/access.
