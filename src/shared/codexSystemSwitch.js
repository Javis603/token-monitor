'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexAuthIdentity, codexManagedAccountMatchesIdentity } = require('./codexAuth');
const { authWithSelectedCodexWorkspace, normalizeWorkspaceId } = require('./codexWorkspaces');

function liveCodexAuthPath(env = process.env, homeDir = os.homedir()) {
  const codexHome = String(env?.CODEX_HOME || '').trim();
  return path.join(codexHome || path.join(homeDir, '.codex'), 'auth.json');
}

function codexAccountMatchesIdentity(account, identity) {
  return codexManagedAccountMatchesIdentity(account, identity);
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

function codexAuthMaterialForWorkspace(material, workspaceId, options = {}) {
  const selectedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!selectedWorkspaceId) return material;
  const sourceIdentity = codexAuthIdentity(material?.auth);
  const routedWorkspaceId = normalizeWorkspaceId(
    sourceIdentity.claimedWorkspaceAccountId
    || sourceIdentity.workspaceAccountId
  );
  const selectedIsFedramp = typeof options.isFedrampAccount === 'boolean'
    ? options.isFedrampAccount
    : undefined;
  const switchesWorkspace = !routedWorkspaceId || selectedWorkspaceId !== routedWorkspaceId;
  if (switchesWorkspace && typeof selectedIsFedramp !== 'boolean') {
    throw new Error('The selected Codex workspace routing could not be verified. Sign in directly to that workspace before switching the system account.');
  }
  if (
    typeof selectedIsFedramp === 'boolean'
    && selectedIsFedramp !== sourceIdentity.isFedrampAccount
  ) {
    throw new Error('The selected Codex workspace uses different FedRAMP routing. Sign in directly to that workspace before switching the system account.');
  }
  const auth = authWithSelectedCodexWorkspace(material?.auth, selectedWorkspaceId);
  return {
    ...material,
    auth,
    data: `${JSON.stringify(auth, null, 2)}\n`,
    identity: codexAuthIdentity(auth)
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
  codexAuthMaterialForWorkspace,
  codexAccountMatchesIdentity,
  findMatchingCodexAccount,
  liveCodexAuthPath,
  readCodexAuthMaterial,
  writeCodexAuthFile
};
