'use strict';

const { spawn } = require('node:child_process');
const { createSubprocessTermination } = require('../../subprocessTermination');

// The desktop launches `codex exec-server --environment-id <id>`. Matching
// that process is evidence of this computer's executor, unlike a cwd which
// can be identical on several computers. Never retain or log the command line.
function executorIdsFromProcesses(text) {
  const ids = new Set();
  // Desktop versions can put global config overrides before the subcommand.
  // Admit only assignment-valued -c/--config options, not arbitrary argv which
  // could contain an exec-server command as another subcommand's argument.
  const assignment = String.raw`(?:[A-Za-z0-9_.-]+=(?:\\"|[^\s"']|"(?:[^"\\]|\\.)*"|'[^']*')+|"[A-Za-z0-9_.-]+=(?:[^"\\]|\\.)*"|'[A-Za-z0-9_.-]+=[^']*')`;
  const executor = new RegExp(`^\\s*(?:"(?:[^"]*[\\\\/])?codex(?:\\.exe)?"|(?:[^\\s"]*[\\\\/])?codex(?:\\.exe)?)(?:\\s+(?:-c|--config)\\s+${assignment})*\\s+exec-server\\s`);
  for (const line of String(text || '').split(/\r?\n/)) {
    const command = line.match(executor);
    if (!command) continue;
    const id = line.slice(command[0].length).match(/(?:^|\s)--environment-id\s+"?([A-Za-z0-9_-]+)(?:"|\s|$)/)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

function localExecutorIds(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.spawn || spawn;
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Filter "Name = \'codex.exe\'" | ForEach-Object { $_.CommandLine }']
    : ['-axo', 'args='];
  return new Promise((resolve) => {
    if (options.signal?.aborted) return resolve(null);
    let child;
    try {
      child = run(platform === 'win32' ? 'powershell.exe' : 'ps', args, {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (_) { return resolve(null); }
    let text = '';
    let failed = false;
    let finished = false;
    const finish = (ids = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve(ids);
    };
    const termination = createSubprocessTermination(child, { onUnconfirmed: () => finish() });
    const abort = () => { failed = true; termination.request(); };
    // Windows PowerShell cold start was measured above five seconds.
    const timer = setTimeout(abort, platform === 'win32' ? 15000 : 2000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (bytes) => {
      if (failed || finished) return;
      text += bytes.toString('utf8');
      if (text.length > 4 * 1024 * 1024) abort();
    });
    child.on('error', () => { failed = true; });
    child.on('close', (code) => {
      termination.confirmClosed();
      finish(!failed && code === 0 ? executorIdsFromProcesses(text) : null);
    });
    if (options.signal?.aborted) abort();
  });
}

function localThreadEnvironment(thread, executorIds) {
  if (thread?.originator !== 'codex_work_cca' || thread.threadSource !== 'aeon_child'
    || thread.path || thread.ephemeral || typeof thread.id !== 'string' || !thread.id
    || typeof thread.model !== 'string' || !thread.model) return null;
  const environments = thread.environments;
  if (!Array.isArray(environments) || environments.length !== 1) return null;
  const environment = environments[0];
  if (!executorIds.has(environment?.environmentId) || typeof environment.cwd !== 'string'
    || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(environment.cwd)) return null;
  return { environmentId: environment.environmentId, cwd: environment.cwd };
}

module.exports = { executorIdsFromProcesses, localExecutorIds, localThreadEnvironment };
