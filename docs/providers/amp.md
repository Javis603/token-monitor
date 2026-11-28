---
summary: "Amp usage collection from local threads and the Tokscale sync cache."
ids: [amp]
read_when:
  - Setting up or troubleshooting Amp usage collection
  - Changing Amp source discovery or sync behavior
---

# Amp

Install the native Amp CLI and sign in, then turn on **Track** for Amp in **Settings → Collection**. Token Monitor uses its bundled Tokscale to import new and updated threads in the background. Use the app's refresh action to request a sync immediately. Expand Amp under Collection to see the last successful sync and any sync error.

If sync fails, run `amp threads list` to check that the CLI can access your threads. If the app was already running when you installed Amp or changed PATH, restart it so it sees the updated environment.

Token Monitor reads local threads from `~/.local/share/amp/threads/` (or the equivalent under `XDG_DATA_HOME`) and the synced `amp-cache/threads/` directory under Tokscale's config directory. On Windows this defaults to `%APPDATA%\tokscale` and follows `TOKSCALE_CONFIG_DIR` if set. Usage comes from the locally available thread records and can differ from Amp's account totals.
