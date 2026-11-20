---
summary: "Amp usage collection from local threads and the Tokscale export cache."
ids: [amp]
read_when:
  - Setting up or troubleshooting Amp usage collection
  - Changing Amp source discovery or watch behavior
---

# Amp

Token Monitor reads local Amp threads from `~/.local/share/amp/threads/` (or the equivalent under `XDG_DATA_HOME`) and exports from Tokscale's `amp-cache/threads` directory. If Amp can list your threads but has no local thread files, export them with `tokscale amp sync`.

## Sync on Windows

1. Install the native Amp CLI and sign in. In PowerShell, run `amp threads list` to check that the CLI can see your account's threads.
2. Run the bundled Tokscale from the default Token Monitor installation. For a custom installation, set `$installDir` to the folder containing the Token Monitor executable. If you already have a current Tokscale CLI on your PATH, you can run `tokscale amp sync` directly.

   ```powershell
   $installDir = Join-Path $env:LOCALAPPDATA 'Programs\token-monitor'
   $scannerDir = Join-Path $installDir 'resources\app.asar.unpacked\node_modules\@tokscale'
   $tokscale = Get-ChildItem -LiteralPath $scannerDir -Filter tokscale.exe -File -Recurse |
     Select-Object -First 1 -ExpandProperty FullName
   & $tokscale amp sync
   ```

3. Check the sync summary and verify that `%APPDATA%\tokscale\amp-cache\threads` contains exported JSON files. If you set `TOKSCALE_CONFIG_DIR` for Token Monitor, use that directory instead of `%APPDATA%\tokscale` and run the sync with the same setting.
4. Enable Amp under **Settings → Collection → Tracked Tools** and refresh usage. Run the same sync command again when you want to import new or updated threads.

If the sync cannot find Amp, check that `amp.exe` or `amp.cmd` is on PATH in the same PowerShell session. If a large export reaches the time limit, try `amp sync --timeout 180` with the same Tokscale executable. Usage reflects the token data in the exported messages, which can differ from Amp's account totals.
