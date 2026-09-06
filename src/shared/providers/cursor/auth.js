'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { abortReason } = require('../../abortSignal');
const {
  createSubprocessTermination,
  terminationUnconfirmedError
} = require('../../subprocessTermination');
const { classifyClientSyncDetailCode } = require('../../clientHealth');
const { withCursorLifecycle } = require('./lifecycle');

const MAX_SYNC_EXIT_CODE = 2 ** 31 - 1;
const MAX_TOKSCALE_STDERR_LENGTH = 64 * 1024;
const CURSOR_EXPLICIT_SYNC_TIMEOUT_MS = 150_000;
const CURSOR_DESKTOP_TOKEN_KEY = 'cursorAuth/accessToken';

function annotateSyncError(error, failureStage, exitCode = null) {
  const target = error instanceof Error ? error : new Error(String(error || 'Cursor sync failed'));
  target.syncFailureStage = failureStage;
  target.syncDetailCode = classifyClientSyncDetailCode({ client: 'cursor', text: target.message });
  if (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= MAX_SYNC_EXIT_CODE) {
    target.syncExitCode = exitCode;
  }
  return target;
}

function credentialsPath(home = os.homedir()) {
  return path.join(home, '.config', 'tokscale', 'cursor-credentials.json');
}

function cursorDesktopStateCandidates({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')];
  }
  if (platform === 'win32') {
    const candidates = [];
    const appData = String(env?.APPDATA || '').trim();
    if (appData) candidates.push(path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    candidates.push(path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    return candidates;
  }
  return [path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')];
}

function readCursorDesktopAccessToken(options = {}) {
  const fsApi = options.fs || fs;
  const dbPath = cursorDesktopStateCandidates(options).find((candidate) => {
    try { return fsApi.statSync(candidate).isFile(); } catch (_) { return false; }
  });
  if (!dbPath) return null;

  let sqlite = options.sqlite;
  if (sqlite === undefined) {
    try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
  }
  if (typeof sqlite?.DatabaseSync !== 'function') {
    const error = new Error('Cursor desktop discovery requires node:sqlite');
    error.code = 'CURSOR_DESKTOP_DISCOVERY_UNAVAILABLE';
    throw error;
  }

  const database = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(CURSOR_DESKTOP_TOKEN_KEY);
    const token = typeof row?.value === 'string' ? row.value.trim() : '';
    return token || null;
  } finally {
    database.close();
  }
}

function deriveAccountId(token) {
  if (typeof token === 'string') {
    if (token.includes('%3A%3A')) {
      const head = token.split('%3A%3A')[0].trim();
      if (head) return head;
    }
    if (token.includes('::')) {
      const head = token.split('::')[0].trim();
      if (head) return head;
    }
  }
  const digest = crypto.createHash('sha256').update(String(token)).digest('hex');
  return 'anon-' + digest.slice(0, 12);
}

function canonicalCursorUserId(value) {
  const match = String(value || '').match(/user_[A-Za-z0-9_]+/);
  return match?.[0] || '';
}

function extractUserId(token) {
  if (typeof token !== 'string') return null;
  if (token.includes('%3A%3A')) {
    const head = token.split('%3A%3A')[0].trim();
    const userId = canonicalCursorUserId(head);
    if (userId) return userId;
  }
  if (token.includes('::')) {
    const head = token.split('::')[0].trim();
    const userId = canonicalCursorUserId(head);
    if (userId) return userId;
  }
  return null;
}

function userIdFromAccessToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const sub = typeof payload?.sub === 'string' ? payload.sub : '';
    return canonicalCursorUserId(sub) || null;
  } catch (_) {
    return null;
  }
}

function normalizeCursorSessionToken(input) {
  let token = String(input || '').trim();
  if (!token || token.length > 16 * 1024) return '';
  if (token.toLowerCase().startsWith('cookie:')) token = token.slice(7).trim();
  const cookieMatch = token.match(/WorkosCursorSessionToken=([^;\s]+)/i);
  if (cookieMatch) token = cookieMatch[1];
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  if (!token || /\s/.test(token)) return '';
  const separator = token.indexOf('::');
  if (separator > 0) {
    token = `${token.slice(0, separator)}%3A%3A${token.slice(separator + 2)}`;
  } else if (!token.includes('%3A%3A')) {
    const userId = userIdFromAccessToken(token);
    if (userId) token = `${userId}%3A%3A${token}`;
  }
  return token;
}

function readCredentialsStore({ home = os.homedir() } = {}) {
  const file = credentialsPath(home);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

function writeCredentialsStoreAtomic(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpPath = file + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, file);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best-effort */ }
  }
}

function normalizeAccount(id, acct) {
  if (!id || !acct || typeof acct !== 'object' || typeof acct.sessionToken !== 'string' || !acct.sessionToken) return null;
  return {
    id,
    sessionToken: acct.sessionToken,
    userId: typeof acct.userId === 'string' ? acct.userId : null,
    label: typeof acct.label === 'string' ? acct.label : null,
    createdAt: typeof acct.createdAt === 'string' ? acct.createdAt : null,
    expiresAt: typeof acct.expiresAt === 'string' ? acct.expiresAt : null
  };
}

function listAccounts({ home = os.homedir() } = {}) {
  const parsed = readCredentialsStore({ home });
  if (!parsed?.accounts || typeof parsed.accounts !== 'object') return [];
  const active = typeof parsed.activeAccountId === 'string' ? parsed.activeAccountId : '';
  return Object.entries(parsed.accounts)
    .map(([id, acct]) => normalizeAccount(id, acct))
    .filter(Boolean)
    .sort((left, right) => {
      const leftRank = left.id === active ? 0 : 1;
      const rightRank = right.id === active ? 0 : 1;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const leftName = (left.label || left.userId || left.id).toLowerCase();
      const rightName = (right.label || right.userId || right.id).toLowerCase();
      return leftName.localeCompare(rightName);
    });
}

function readActiveAccount({ home = os.homedir() } = {}) {
  const parsed = readCredentialsStore({ home });
  if (!parsed?.accounts || typeof parsed.accounts !== 'object') return null;
  const id = parsed.activeAccountId;
  return normalizeAccount(id, parsed.accounts[id]);
}

function runTokscaleSubcommand(args, {
  stdin = null,
  timeoutMs = 30000,
  signal,
  spawn: spawnFn = spawn,
  tokscaleCommand: resolveTokscaleCommand,
  terminationOptions,
  onTerminationUnconfirmed
} = {}) {
  if (signal?.aborted) return Promise.reject(abortReason(signal, 'Cursor sync aborted'));
  return new Promise((resolve, reject) => {
    const tokscaleCommand = resolveTokscaleCommand || require('../../collector').tokscaleCommand;
    const { bin, prefixArgs, env } = tokscaleCommand();
    const child = spawnFn(bin, [...prefixArgs, 'cursor', ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    let terminalError = null;
    const termination = createSubprocessTermination(child, {
      ...(terminationOptions || {}),
      onUnconfirmed() {
        const error = terminationUnconfirmedError(terminalError, `tokscale cursor ${args[0]}`);
        try { onTerminationUnconfirmed?.(error); } catch (_) {}
        finish(error);
      }
    });

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    }

    function onAbort() {
      if (terminalError) return;
      terminalError = abortReason(signal, 'Cursor sync aborted');
      clearTimeout(timer);
      termination.request();
    }

    timer = setTimeout(() => {
      if (terminalError) return;
      terminalError = annotateSyncError(
        new Error(`tokscale cursor ${args[0]} timed out after ${timeoutMs}ms`),
        'timeout'
      );
      termination.request();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (!settled && !terminalError) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (settled || terminalError || stderr.length >= MAX_TOKSCALE_STDERR_LENGTH) return;
      stderr += chunk.toString().slice(0, MAX_TOKSCALE_STDERR_LENGTH - stderr.length);
    });
    child.on('error', (error) => {
      if (terminalError) return;
      finish(annotateSyncError(error, 'spawn'));
    });
    child.stdin.on('error', (error) => {
      if (terminalError) return;
      terminalError = annotateSyncError(error, 'process-exit');
      clearTimeout(timer);
      termination.request();
    });
    child.on('close', (code) => {
      termination.confirmClosed();
      if (settled) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) {
        return finish(annotateSyncError(
          new Error(`tokscale cursor ${args[0]} exited ${code}: ${(stderr || stdout).trim()}`),
          'process-exit',
          code
        ));
      }
      finish(null, stdout);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      child.stdin.end(stdin || undefined);
    } catch (error) {
      if (terminalError) return;
      terminalError = annotateSyncError(error, 'process-exit');
      clearTimeout(timer);
      termination.request();
    }
  });
}

async function runCursorLogin(token, {
  label = '',
  home = os.homedir(),
  activate = true
} = {}) {
  token = normalizeCursorSessionToken(token);
  if (!token) {
    throw new Error('runCursorLogin: token must be a non-empty string');
  }
  const accountId = deriveAccountId(token);
  const userId = extractUserId(token);
  const file = credentialsPath(home);
  const trimmedLabel = typeof label === 'string' ? label.trim() : '';

  return withCursorLifecycle(() => {
    let store = readCredentialsStore({ home });
    if (!store || typeof store.accounts !== 'object' || store.accounts === null) {
      store = { version: 1, activeAccountId: accountId, accounts: {} };
    }
    if (!store.accounts || typeof store.accounts !== 'object') store.accounts = {};

    if (trimmedLabel) {
      const lcLabel = trimmedLabel.toLowerCase();
      for (const [otherId, otherAcct] of Object.entries(store.accounts)) {
        if (otherId === accountId) continue;
        if (!otherAcct || typeof otherAcct !== 'object') continue;
        const otherLabel = typeof otherAcct.label === 'string' ? otherAcct.label.trim().toLowerCase() : '';
        if (otherLabel && otherLabel === lcLabel) {
          throw new Error(`Cursor account label already exists: ${trimmedLabel}`);
        }
      }
    }

    const existing = store.accounts[accountId];
    const activeIsValid = Boolean(normalizeAccount(
      store.activeAccountId,
      store.accounts[store.activeAccountId]
    ));
    const existingCreatedAt = typeof existing?.createdAt === 'string' ? existing.createdAt : '';
    const existingLabel = typeof existing?.label === 'string' ? existing.label : null;

    store.accounts[accountId] = {
      sessionToken: token,
      userId: userId || null,
      createdAt: existingCreatedAt || new Date().toISOString(),
      expiresAt: null,
      label: trimmedLabel || existingLabel
    };
    if (activate || !activeIsValid) store.activeAccountId = accountId;
    if (!store.version) store.version = 1;

    writeCredentialsStoreAtomic(file, store);
    return accountId;
  });
}

async function runCursorDiscover(options = {}) {
  const accessToken = readCursorDesktopAccessToken(options);
  if (!accessToken) return { discovered: false, reason: 'not-signed-in' };
  const sessionToken = normalizeCursorSessionToken(accessToken);
  if (!sessionToken || !extractUserId(sessionToken)) {
    const error = new Error('Cursor desktop access token has an invalid account identity');
    error.code = 'CURSOR_DESKTOP_TOKEN_INVALID';
    throw error;
  }
  const accountId = await (options.runLogin || runCursorLogin)(sessionToken, {
    home: options.home,
    activate: false
  });
  return { discovered: true, accountId };
}

async function runCursorLogout({
  accountId = '',
  label = '',
  timeoutMs = 30000,
  runSubcommand = runTokscaleSubcommand,
  ...options
} = {}) {
  const target = String(accountId || label || '').trim();
  const args = target ? ['logout', '--name', target] : ['logout'];
  return withCursorLifecycle(
    () => runSubcommand(args, { ...options, timeoutMs }),
    { signal: options.signal }
  );
}

function parseCursorSyncResult(stdout) {
  let result;
  try { result = JSON.parse(String(stdout || '')); } catch (error) {
    throw annotateSyncError(new Error(`tokscale cursor sync returned invalid JSON: ${error.message}`), 'unknown');
  }
  if (!result || typeof result !== 'object' || typeof result.synced !== 'boolean') {
    throw annotateSyncError(new Error('tokscale cursor sync returned an invalid result'), 'unknown');
  }
  const errorText = typeof result.error === 'string' ? result.error.trim() : '';
  const notAuthenticated = !result.synced && /not authenticated/i.test(errorText);
  if (!result.synced && !notAuthenticated) {
    throw annotateSyncError(new Error(errorText || 'Cursor sync failed'), 'unknown');
  }
  return {
    synced: result.synced,
    rows: Number.isFinite(Number(result.rows)) ? Math.max(0, Number(result.rows)) : 0,
    error: errorText || null,
    notAuthenticated
  };
}

async function runCursorSync(options = {}) {
  const { runSubcommand = runTokscaleSubcommand, ...subprocessOptions } = options;
  return withCursorLifecycle(async () => {
    const stdout = await runSubcommand(
      ['sync', '--json'],
      { ...subprocessOptions, timeoutMs: options.timeoutMs ?? CURSOR_EXPLICIT_SYNC_TIMEOUT_MS }
    );
    return parseCursorSyncResult(stdout);
  }, { signal: options.signal });
}

function runCursorStatus(options = {}) {
  return runTokscaleSubcommand(['status'], { ...options, timeoutMs: options.timeoutMs ?? 15000 });
}

module.exports = {
  CURSOR_EXPLICIT_SYNC_TIMEOUT_MS,
  canonicalCursorUserId,
  credentialsPath,
  listAccounts,
  normalizeCursorSessionToken,
  readActiveAccount,
  readCursorDesktopAccessToken,
  runCursorDiscover,
  runCursorLogin,
  runCursorLogout,
  runCursorSync,
  runCursorStatus
};
