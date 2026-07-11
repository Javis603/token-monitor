'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexAuthIdentity } = require('./codexAuth');

function liveCodexAuthPath(env = process.env, homeDir = os.homedir()) {
  const codexHome = String(env?.CODEX_HOME || '').trim();
  return path.join(codexHome || path.join(homeDir, '.codex'), 'auth.json');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function codexAccountMatchesIdentity(account, identity) {
  if (!account || !identity) return false;
  const accountKey = String(account.accountKey || '').trim();
  const identityKey = String(identity.accountKey || '').trim();
  if (accountKey && identityKey) return accountKey === identityKey;
  const accountEmail = normalizeEmail(account.email);
  const identityEmail = normalizeEmail(identity.email);
  return Boolean(accountEmail && identityEmail && accountEmail === identityEmail);
}

function findMatchingCodexAccount(accounts, identity) {
  return (accounts || []).find((account) => codexAccountMatchesIdentity(account, identity));
}

async function readCodexAuthMaterial(authPath, deps = {}) {
  const readFile = deps.readFile || fs.promises.readFile;
  const data = await readFile(authPath, 'utf8');
  let auth;
  try {
    auth = JSON.parse(data);
  } catch (error) {
    const parseError = new Error('Codex auth file is not valid JSON.');
    parseError.cause = error;
    throw parseError;
  }
  return {
    auth,
    data,
    identity: codexAuthIdentity(auth),
    authPath
  };
}

async function writeCodexAuthFile(authPath, data, deps = {}) {
  const mkdir = deps.mkdir || fs.promises.mkdir;
  const writeFile = deps.writeFile || fs.promises.writeFile;
  const rename = deps.rename || fs.promises.rename;
  const chmod = deps.chmod || fs.promises.chmod;
  const unlink = deps.unlink || fs.promises.unlink;
  const randomUUID = deps.randomUUID || crypto.randomUUID;
  const dir = path.dirname(authPath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.auth.json.token-monitor-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, data, { mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => {});
    await rename(tempPath, authPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

module.exports = {
  codexAccountMatchesIdentity,
  findMatchingCodexAccount,
  liveCodexAuthPath,
  readCodexAuthMaterial,
  writeCodexAuthFile
};
