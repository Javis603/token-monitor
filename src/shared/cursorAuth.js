'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { classifyClientSyncDetailCode } = require('./clientHealth');

const MAX_SYNC_EXIT_CODE = 2 ** 31 - 1;

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

function extractUserId(token) {
  if (typeof token !== 'string') return null;
  if (token.includes('%3A%3A')) {
    const head = token.split('%3A%3A')[0].trim();
    if (head) return head;
  }
  if (token.includes('::')) {
    const head = token.split('::')[0].trim();
    if (head) return head;
  }
  return null;
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

function readActiveAccount({ home = os.homedir() } = {}) {
  const parsed = readCredentialsStore({ home });
  if (!parsed) return null;
  const accounts = parsed.accounts;
  const id = parsed.activeAccountId;
  if (!id || !accounts || typeof accounts !== 'object') return null;
  const acct = accounts[id];
  if (!acct || typeof acct !== 'object' || typeof acct.sessionToken !== 'string' || !acct.sessionToken) return null;
  return {
    id,
    sessionToken: acct.sessionToken,
    userId: typeof acct.userId === 'string' ? acct.userId : null,
    label: typeof acct.label === 'string' ? acct.label : null,
    createdAt: typeof acct.createdAt === 'string' ? acct.createdAt : null,
    expiresAt: typeof acct.expiresAt === 'string' ? acct.expiresAt : null
  };
}

function runTokscaleSubcommand(args, { stdin = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const { tokscaleCommand } = require('./collector');
    const { bin, prefixArgs, env } = tokscaleCommand();
    const child = spawn(bin, [...prefixArgs, 'cursor', ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(annotateSyncError(new Error(`tokscale cursor ${args[0]} timed out after ${timeoutMs}ms`), 'timeout'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(annotateSyncError(err, 'spawn')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(annotateSyncError(
          new Error(`tokscale cursor ${args[0]} exited ${code}: ${(stderr || stdout).trim()}`),
          'process-exit',
          code
        ));
      }
      resolve(stdout);
    });
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function runCursorLogin(token, { label = '', home = os.homedir() } = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('runCursorLogin: token must be a non-empty string');
  }
  const accountId = deriveAccountId(token);
  const userId = extractUserId(token);
  const file = credentialsPath(home);

  let store = readCredentialsStore({ home });
  if (!store || typeof store.accounts !== 'object' || store.accounts === null) {
    store = { version: 1, activeAccountId: accountId, accounts: {} };
  }
  if (!store.accounts || typeof store.accounts !== 'object') store.accounts = {};

  const trimmedLabel = typeof label === 'string' ? label.trim() : '';
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
}

async function runCursorLogout({ label = '', home = os.homedir() } = {}) {
  const file = credentialsPath(home);
  const store = readCredentialsStore({ home });
  if (!store || !store.accounts || typeof store.accounts !== 'object') return;

  const trimmedLabel = typeof label === 'string' ? label.trim() : '';
  let removeId = null;

  if (trimmedLabel) {
    const lcLabel = trimmedLabel.toLowerCase();
    for (const [id, acct] of Object.entries(store.accounts)) {
      if (!acct || typeof acct !== 'object') continue;
      const acctLabel = typeof acct.label === 'string' ? acct.label.trim().toLowerCase() : '';
      if (acctLabel && acctLabel === lcLabel) { removeId = id; break; }
    }
    if (!removeId && Object.prototype.hasOwnProperty.call(store.accounts, trimmedLabel)) {
      removeId = trimmedLabel;
    }
    if (!removeId) return;
  } else {
    removeId = store.activeAccountId || null;
    if (!removeId || !Object.prototype.hasOwnProperty.call(store.accounts, removeId)) return;
  }

  const wasActive = store.activeAccountId === removeId;
  delete store.accounts[removeId];

  if (wasActive) {
    const remainingIds = Object.keys(store.accounts);
    if (remainingIds.length === 0) {
      try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
      return;
    }
    store.activeAccountId = remainingIds[0];
  }

  writeCredentialsStoreAtomic(file, store);
}

async function runCursorSync({ timeoutMs = 60000 } = {}) {
  return runTokscaleSubcommand(['sync', '--json'], { timeoutMs });
}

function runCursorStatus({ timeoutMs = 15000 } = {}) {
  return runTokscaleSubcommand(['status'], { timeoutMs });
}

module.exports = {
  credentialsPath,
  readActiveAccount,
  runCursorLogin,
  runCursorLogout,
  runCursorSync,
  runCursorStatus
};
