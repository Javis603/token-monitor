# GitHub Copilot CLI token tracking

Token Monitor automatically detects VS Code Copilot Chat usage from VS Code's local session data through Tokscale 4.5.2 or later. No VS Code settings or OpenTelemetry exporter are required.

The standalone GitHub Copilot CLI still needs its OpenTelemetry file exporter enabled. Token Monitor reads those JSONL files from `~/.copilot/otel/` through Tokscale. OTel begins recording only after it is enabled, so earlier CLI interactions are not backfilled.

## Migrating from the previous VS Code setup

If you previously followed this guide for VS Code Copilot Chat, remove these settings from VS Code's `settings.json`:

- `github.copilot.chat.otel.enabled`
- `github.copilot.chat.otel.exporterType`
- `github.copilot.chat.otel.outfile`

Move any VS Code-generated Copilot Chat OTel file out of `~/.copilot/otel/` after backing it up. Leaving both the old VS Code OTel export and the built-in VS Code session source enabled can overlap. Copilot CLI OTel files can remain in that directory.

## Setup

Copilot CLI does not write an OTel file by default. Set the file exporter before starting the CLI. The timestamped filename keeps each session in a separate file instead of growing one OTel log indefinitely.

```bash
export COPILOT_OTEL_ENABLED=true
export COPILOT_OTEL_EXPORTER_TYPE=file
mkdir -p ~/.copilot/otel
export COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/otel/copilot-otel-$(date +%Y%m%d-%H%M%S).jsonl"
copilot
```

On Windows PowerShell:

```powershell
$otelDir = "$HOME/.copilot/otel"
New-Item -ItemType Directory -Force -Path $otelDir | Out-Null
$env:COPILOT_OTEL_ENABLED = "true"
$env:COPILOT_OTEL_EXPORTER_TYPE = "file"
$env:COPILOT_OTEL_FILE_EXPORTER_PATH = Join-Path $otelDir ("copilot-otel-{0}.jsonl" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
copilot
```

## Privacy

Token Monitor needs only token metadata. Do not enable optional OTel content-capture settings unless you intentionally want prompts, responses, or tool content written to disk.

## References

- [GitHub Copilot CLI OpenTelemetry monitoring](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
