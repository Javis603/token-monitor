'use strict';

const path = require('node:path');

// WSL discovery markers are home-relative Linux paths in scan order. A hostCheckId
// marks only sources where the same path is a host directory on every platform;
// file sources, alternate roots and platform-specific paths remain explicit in
// clientSourceRoots().
const SOURCE_MARKERS = [
  { marker: '.claude/projects', client: 'claude' },
  { marker: '.claude/transcripts', client: 'claude' },
  { marker: '.codex/sessions', client: 'codex' },
  { marker: '.local/share/opencode', client: 'opencode' },
  { marker: '.openclaw/agents', client: 'openclaw' },
  { marker: '.clawdbot/agents', client: 'openclaw' },
  { marker: '.moltbot/agents', client: 'openclaw' },
  { marker: '.moldbot/agents', client: 'openclaw' },
  { marker: '.hermes', client: 'hermes' },
  { marker: '.kimi/sessions', client: 'kimi' },
  { marker: '.kimi-code/sessions', client: 'kimi' },
  { marker: '.qwen/projects', client: 'qwen', hostCheckId: 'qwen-projects' },
  { marker: '.grok/sessions', client: 'grok' },
  { marker: '.copilot/otel', client: 'copilot' },
  // The CLI parse-local root belongs to the tracked Antigravity umbrella id.
  { marker: '.gemini/antigravity-cli/conversations', client: 'antigravity' },
  { marker: '.gemini/antigravity/conversations', client: 'antigravity' },
  { marker: '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks', client: 'cline' },
  { marker: '.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks', client: 'cline' },
  { marker: '.local/share/amp/threads', client: 'amp' },
  { marker: '.pi/agent/sessions', client: 'pi', hostCheckId: 'pi-sessions' },
  { marker: '.omp/agent/sessions', client: 'omp', hostCheckId: 'omp-sessions' },
  { marker: '.local/share/zed/threads/threads.db', client: 'zed' },
  { marker: '.local/share/kilo/kilo.db', client: 'kilo' },
  { marker: '.config/Code/User/globalStorage/kilocode.kilo-code/tasks', client: 'kilo' },
  { marker: '.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks', client: 'kilo' },
  { marker: '.commandcode/projects', client: 'commandcode', hostCheckId: 'commandcode-projects' },
  { marker: '.dsh/sessions', client: 'dsh' },
  { marker: '.factory/sessions', client: 'droid', hostCheckId: 'droid-sessions' },
  { marker: '.local/share/mimocode/mimocode.db', client: 'mimo' },
  { marker: '.zcode/projects', client: 'zcode' },
  { marker: '.zcode/cli/db', client: 'zcode' },
  { marker: '.kiro/sessions', client: 'kiro' },
  { marker: '.local/share/kiro-cli/data.sqlite3', client: 'kiro' },
  { marker: '.config/Kiro/User/globalStorage/kiro.kiroagent', client: 'kiro' },
  { marker: '.config/kiro/User/globalStorage/kiro.kiroagent', client: 'kiro' },
  { marker: '.codebuddy/projects', client: 'codebuddy' },
  { marker: '.workbuddy', client: 'workbuddy' },
  { marker: '.workbuddy-ai', client: 'workbuddy' },
  { marker: '.proma/agent-sessions', client: 'proma' },
  { marker: '.lmstudio/server-logs', client: 'lmstudio' },
  { marker: '.unsloth/studio/studio.db', client: 'unsloth' },
  { marker: '.local/share/devin/cli/sessions.db', client: 'devin' },
  { marker: 'AppData/Roaming/devin/cli/sessions.db', client: 'devin' },
  { marker: '.config/Devin/User/acp-events', client: 'devin' },
  { marker: '.config/devin/User/acp-events', client: 'devin' },
  { marker: 'AppData/Roaming/Devin/User/acp-events', client: 'devin' },
  { marker: 'Library/Application Support/Devin/User/acp-events', client: 'devin' }
];

const WSL_DATA_MARKERS = SOURCE_MARKERS.map(({ marker }) => marker);
const MARKER_CLIENTS = Object.fromEntries(SOURCE_MARKERS.map(({ marker, client }) => [marker, client]));

function simpleHostSourceRoots(client, home) {
  return SOURCE_MARKERS
    .filter((entry) => entry.client === client && entry.hostCheckId)
    .map(({ marker, hostCheckId }) => [hostCheckId, path.join(home, ...marker.split('/'))]);
}

module.exports = { SOURCE_MARKERS, WSL_DATA_MARKERS, MARKER_CLIENTS, simpleHostSourceRoots };
