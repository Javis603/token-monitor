# GitHub Copilot token tracking

Token Monitor reads OpenTelemetry JSONL files from `~/.copilot/otel/` through Tokscale. This supports both the standalone GitHub Copilot CLI and VS Code Copilot Chat. OTel begins recording only after it is enabled, so earlier interactions are not backfilled.

## VS Code Copilot Chat

Use VS Code 1.119 or later. Create the output folder, then open **Preferences: Open User Settings (JSON)** and add the following settings. Replace the example with an absolute path on your machine.

```bash
mkdir -p ~/.copilot/otel
```

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.outfile": "/Users/you/.copilot/otel/copilot-chat-otel.jsonl"
}
```

On Windows, use an absolute Windows path such as `C:\\Users\\you\\.copilot\\otel\\copilot-chat-otel.jsonl`.

Reload the VS Code window, then send a new message in Copilot Chat. A `.jsonl` file should appear in `~/.copilot/otel/`, and Token Monitor will pick it up on its next refresh.

## Copilot CLI

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

Do not enable `github.copilot.chat.otel.captureContent` unless you intentionally want prompts, responses, and tool content written to disk. It is disabled by default; Token Monitor needs only the token metadata.

## References

- [Monitor agent usage with OpenTelemetry](https://code.visualstudio.com/docs/agents/guides/monitoring-agents)
- [GitHub Copilot CLI OpenTelemetry monitoring](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
