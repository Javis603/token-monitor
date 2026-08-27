'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { abortReason } = require('./abortSignal');
const {
  createSubprocessTermination,
  terminationUnconfirmedError
} = require('./subprocessTermination');
const { classifyClientSyncDetailCode } = require('./clientHealth');
const { withCursorLifecycle } = require('./cursorLifecycle');

const MAX_SYNC_EXIT_CODE = 2 ** 31 - 1;
const MAX_TOKSCALE_STDERR_LENGTH = 64 * 1024;
const CURSOR_EXPLICIT_SYNC_TIMEOUT_MS = 150_000;

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
    const tokscaleCommand = resolveTokscaleCommand || require('./collector').tokscaleCommand;
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

async function runCursorLogin(token, { label = '', home = os.homedir() } = {}) {
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

    store.accounts[accountId] = {
      sessionToken: token,
      userId: userId || null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      label: trimmedLabel || null
    };
    store.activeAccountId = accountId;
    if (!store.version) store.version = 1;

    writeCredentialsStoreAtomic(file, store);
    return accountId;
  });
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

async function runCursorSync(options = {}) {
  return withCursorLifecycle(() => runTokscaleSubcommand(
    ['sync', '--json'],
    { ...options, timeoutMs: options.timeoutMs ?? CURSOR_EXPLICIT_SYNC_TIMEOUT_MS }
  ), { signal: options.signal });
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
  runCursorLogin,
  runCursorLogout,
  runCursorSync,
  runCursorStatus
};
