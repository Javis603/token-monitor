# Data export

Token Monitor can export your usage data in **tool-agnostic** formats so you can
pull it into a spreadsheet, an Obsidian dashboard, Grafana, or your own scripts.
Nothing here is specific to any one tool — the app writes standard CSV + JSON and
you connect whatever consumer you like.

## How to export

In **Settings → Collection → Data export**:

- **Export data…** — pick a folder; Token Monitor writes the file set below into
  it once, right now.
- **Auto-export to a folder** — turn this on and choose a folder, and Token
  Monitor rewrites the file set whenever usage updates, at a frequency you choose
  (30 seconds to 60 minutes; default every minute) and skipped entirely when
  nothing changed, so an idle machine never re-uploads unchanged files through
  iCloud / Obsidian Sync. Point it at a folder inside your Obsidian vault (or any
  synced folder) to keep a dashboard always current, hands-free.

Both actions write the **same** files.

## The files

| File | What it is |
|---|---|
| `token-monitor-export.json` | Complete, lossless snapshot + history in one JSON object |
| `token-monitor-snapshot.csv` | Current totals (today / month / all-time), one row per tool and per model |
| `token-monitor-daily.csv` | Daily time-series **history**, one row per day × tool — spans your whole tracked history, not just today (only written when trend history has data) |

CSV files are UTF-8 **with BOM** (so Excel opens non-ASCII correctly), RFC 4180
quoted, with a header row and ISO 8601 dates. Cost columns are named `cost_usd`
and are always in USD.

### `token-monitor-snapshot.csv`

```
period,dimension,name,tokens,cost_usd
today,tool,codex,20,2
today,model,gpt-5,20,2
month,tool,codex,0,0
allTime,tool,codex,100,9
```

### `token-monitor-daily.csv`

This is the daily-granularity **history**, not "today". "Daily" describes the
row granularity (one row per day) as opposed to the monthly rollup — the file
spans your entire tracked history, so it naturally covers many months (capped at
roughly the last 370 days; older days drop off). Today's running totals live in
`token-monitor-snapshot.csv` under `period,today`, not here.

Each row is one day × one tool, so a day where you used three tools produces
three rows for that date; an early date that shows only `codex` simply means only
`codex` was used that day. It is written only when trend history is enabled
(Settings → it's on by default). On a multi-device hub, the counts are the
**combined total across all connected devices** for that day (there is no
per-device column).

```
date,tool,tokens,cost_usd
2026-07-02,codex,5,1
2026-07-03,codex,7,1
2026-07-03,claude-code,5,1
```

### `token-monitor-export.json`

```json
{
  "generatedAt": "2026-07-03T14:30:00.000Z",
  "app": { "name": "token-monitor", "version": "0.19.0" },
  "snapshot": { "today": { … }, "month": { … }, "allTime": { … } },
  "daily":   [ { "date": "2026-07-03", "tokens": 12, "cost": 2, "perClient": { … }, "perModel": { … } } ],
  "monthly": [ { "month": "2026-07", "tokens": 17, "cost": 3, "perClient": { … }, "perModel": { … } } ]
}
```

> Daily/monthly time series only appears when **trend history** is enabled
> (Settings → it's on by default). With history off, the export is snapshot-only.

## Privacy

The export contains **only your usage numbers**. It never includes device
identifiers, hostnames, account emails, plan labels, or AI-tool limit/quota
account data — even when multi-device sync is running. It is safe to drop into a
synced vault.

## Recipes

### Obsidian (Dataview)

Point auto-export at a folder inside your vault (e.g. `TokenMonitor/`), then in a
note:

````markdown
```dataviewjs
const raw = await app.vault.adapter.read("TokenMonitor/token-monitor-export.json");
const data = JSON.parse(raw);
dv.table(["Date", "Tokens", "Cost (USD)"],
  data.daily.slice(-14).map(d => [d.date, d.tokens, "$" + d.cost.toFixed(2)]));
```
````

Prefer a code-free table? Import `token-monitor-daily.csv` with a CSV/table
plugin instead.

### Excel / Google Sheets / Numbers

Open `token-monitor-snapshot.csv` or `token-monitor-daily.csv` directly. Both are
tidy (long) tables, so they pivot cleanly.

### Grafana / dashboards

Use `token-monitor-export.json` (or the CSVs) as a JSON/CSV file data source. For
a live dashboard driven by the hub instead of files, see the `/api/stats` and
`/api/history` endpoints in [API.md](API.md).
