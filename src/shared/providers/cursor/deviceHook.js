'use strict';

// token-monitor-cursor-device — Cursor Agent hook. Observes stop / subagentStop,
// appends token counts, never prints prompt text. Always fail-open. This file is
// copied into ~/.cursor/hooks/ and must stay Node-builtin-only so the copy runs
// without the rest of the app on disk.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_MARKER = 'token-monitor-cursor-device';
const SCRIPT_NAME = `${HOOK_MARKER}.js`;
const HOOK_EVENTS = Object.freeze(['stop', 'subagentStop']);

function token(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function pick(input, ...keys) {
  for (const key of keys) {
    const value = input?.[key];
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function projectFromWorkspace(input) {
  const roots = pick(input, 'workspace_roots', 'workspaceRoots');
  const list = Array.isArray(roots) ? roots : roots ? [roots] : [];
  const first = String(list[0] || '')
    .trim()
    .replace(/^\/([a-zA-Z]:)/, '$1')
    .replace(/[\\/]+$/, '');
  if (!first) return undefined;
  return first.split(/[\\/]/).filter(Boolean).at(-1) || undefined;
}

function sharedDataDirEquiv({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const explicit = String(env.TOKEN_MONITOR_SHARED_DIR || '').trim();
  if (explicit) return explicit;
  const productName = 'Token Monitor';
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', productName);
  if (platform === 'win32') {
    const appData = String(env.APPDATA || '').trim();
    return path.join(appData || path.join(home, 'AppData', 'Roaming'), productName);
  }
  const xdg = String(env.XDG_CONFIG_HOME || '').trim();
  return path.join(xdg || path.join(home, '.config'), productName);
}

function cursorDeviceDir(options = {}) {
  const env = options.env || process.env;
  const explicit = String(env.TOKEN_MONITOR_CURSOR_DEVICE_DIR || '').trim();
  if (explicit) return explicit;
  return path.join(sharedDataDirEquiv(options), 'cursor-device');
}

function cursorDeviceLogPath(options = {}) {
  const env = options.env || process.env;
  const explicit = String(env.TOKEN_MONITOR_CURSOR_DEVICE_LOG || '').trim();
  if (explicit) return explicit;
  return path.join(cursorDeviceDir(options), 'usage.jsonl');
}

function recordFromPayload(input) {
  const event = String(pick(input, 'hook_event_name', 'hookEventName', 'event') || 'stop');
  const model = String(pick(input, 'model', 'model_name', 'modelName') || '').trim();
  const inputTokens = token(pick(input, 'input_tokens', 'inputTokens'));
  const outputTokens = token(pick(input, 'output_tokens', 'outputTokens'));
  const cacheRead = token(pick(input, 'cache_read_tokens', 'cacheReadTokens'));
  const cacheWrite = token(pick(input, 'cache_write_tokens', 'cacheWriteTokens'));
  if (!model) return null;
  if (inputTokens + outputTokens + cacheRead + cacheWrite === 0) return null;
  return {
    v: 1,
    event,
    ts: new Date().toISOString(),
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    conversation_id: pick(input, 'conversation_id', 'conversationId') || undefined,
    generation_id: pick(input, 'generation_id', 'generationId') || undefined,
    subagent_id: pick(input, 'subagent_id', 'subagentId') || undefined,
    project: projectFromWorkspace(input) || (typeof input.project === 'string' ? input.project.trim() : undefined) || undefined
  };
}

function appendCursorDeviceRecord(record, options = {}) {
  if (!record) return;
  const logPath = options.logPath || cursorDeviceLogPath(options);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

function quote(value) {
  return JSON.stringify(String(value).replace(/\\/g, '/'));
}

function cursorHome(options = {}) {
  const env = options.env || process.env;
  const override = String(env.TOKEN_MONITOR_CURSOR_HOME || '').trim();
  if (override) return override;
  if (options.cursorHome) return options.cursorHome;
  return path.join(options.home || os.homedir(), '.cursor');
}

function isOurHook(entry) {
  const command = typeof entry === 'string' ? entry : entry?.command;
  return typeof command === 'string' && command.includes(HOOK_MARKER);
}

function readHooksFile(filePath) {
  if (!fs.existsSync(filePath)) return { version: 1, hooks: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, hooks: {} };
    if (!parsed.hooks || typeof parsed.hooks !== 'object') parsed.hooks = {};
    return parsed;
  } catch (_) {
    return { version: 1, hooks: {} };
  }
}

function findNodeBinary(env = process.env) {
  const explicit = String(env.TOKEN_MONITOR_NODE || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const pathEnv = String(env.PATH || '');
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const extra of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (!dirs.includes(extra)) dirs.push(extra);
  }
  const names = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) {}
    }
  }
  return '';
}

function hookCommand({ dest, execPath = process.execPath, env = process.env, isElectron = Boolean(process.versions.electron) } = {}) {
  if (!isElectron) return `${quote(execPath)} ${quote(dest)}`;
  const nodePath = findNodeBinary(env);
  if (nodePath) return `${quote(nodePath)} ${quote(dest)}`;
  if (process.platform === 'win32') {
    return `${quote(execPath)} ${quote(dest)}`;
  }
  return `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quote(execPath)} ${quote(dest)}`;
}

function installCursorDeviceHook(options = {}) {
  const home = cursorHome(options);
  if (!fs.existsSync(home)) {
    throw new Error('Cursor config directory not found. Open Cursor once, then try again.');
  }
  const dest = path.join(home, 'hooks', SCRIPT_NAME);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(options.scriptPath || __filename, dest);
  try { fs.chmodSync(dest, 0o755); } catch (_) { /* Windows */ }
  fs.mkdirSync(cursorDeviceDir(options), { recursive: true });

  const hooksPath = path.join(home, 'hooks.json');
  const doc = readHooksFile(hooksPath);
  const command = hookCommand({
    dest,
    execPath: options.execPath || process.execPath,
    env: options.env || process.env,
    isElectron: options.isElectron
  });
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(doc.hooks[event]) ? doc.hooks[event].filter((entry) => !isOurHook(entry)) : [];
    list.push({ command });
    doc.hooks[event] = list;
  }
  if (!doc.version) doc.version = 1;
  fs.writeFileSync(hooksPath, `${JSON.stringify(doc, null, 2)}\n`);
  return { dest, hooksPath, command };
}

function uninstallCursorDeviceHook(options = {}) {
  const home = cursorHome(options);
  const hooksPath = path.join(home, 'hooks.json');
  if (!fs.existsSync(hooksPath)) return { hooksPath, removed: false };
  const doc = readHooksFile(hooksPath);
  let removed = false;
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(doc.hooks[event])) continue;
    const next = doc.hooks[event].filter((entry) => {
      const ours = isOurHook(entry);
      if (ours) removed = true;
      return !ours;
    });
    if (next.length === 0) delete doc.hooks[event];
    else doc.hooks[event] = next;
  }
  if (removed) fs.writeFileSync(hooksPath, `${JSON.stringify(doc, null, 2)}\n`);
  return { hooksPath, removed };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

if (require.main === module) {
  (async () => {
    try {
      const raw = await readStdin();
      if (raw) {
        let input = null;
        try { input = JSON.parse(raw); } catch (_) { input = null; }
        const record = input ? recordFromPayload(input) : null;
        if (record) appendCursorDeviceRecord(record);
      }
    } catch (_) {
      // fail open
    }
    process.stdout.write('{}\n');
    process.exit(0);
  })();
}

module.exports = {
  HOOK_EVENTS,
  HOOK_MARKER,
  SCRIPT_NAME,
  appendCursorDeviceRecord,
  cursorDeviceDir,
  cursorDeviceLogPath,
  hookCommand,
  installCursorDeviceHook,
  recordFromPayload,
  uninstallCursorDeviceHook
};
