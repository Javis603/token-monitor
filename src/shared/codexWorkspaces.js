'use strict';

const { createOutboundFetch } = require('./outboundFetch');

const CODEX_WORKSPACES_URL = 'https://chatgpt.com/backend-api/accounts';
const DEFAULT_TIMEOUT_MS = 20_000;

function nonEmptyString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function normalizeWorkspaceId(value) {
  return nonEmptyString(value).toLowerCase();
}

function codexOAuthCredentials(auth) {
  if (!auth || typeof auth !== 'object') return null;
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
  const accessToken = nonEmptyString(tokens.access_token || tokens.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    accountId: normalizeWorkspaceId(
      tokens.account_id
      || tokens.accountId
      || auth.account_id
      || auth.accountId
    )
  };
}

function normalizeCodexWorkspaces(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const seen = new Set();
  const workspaces = [];
  for (const item of items) {
    const id = normalizeWorkspaceId(item?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = nonEmptyString(item?.name);
    workspaces.push({
      id,
      label: name,
      workspaceKind: name ? '' : 'personal'
    });
  }
  return workspaces;
}

async function listCodexWorkspaces(auth, deps = {}) {
  const credentials = codexOAuthCredentials(auth);
  if (!credentials) return [];
  const fetchFn = createOutboundFetch(deps.env || process.env, deps);
  const timeoutMs = Number(deps.timeoutMs || DEFAULT_TIMEOUT_MS);
  const timeoutSignal = AbortSignal.timeout(
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.trunc(timeoutMs)
      : DEFAULT_TIMEOUT_MS
  );
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, timeoutSignal])
    : timeoutSignal;
  const headers = {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'codex-cli'
  };
  if (credentials.accountId) headers['ChatGPT-Account-Id'] = credentials.accountId;
  const response = await fetchFn(CODEX_WORKSPACES_URL, {
    method: 'GET',
    headers,
    signal
  });
  if (!response?.ok) {
    const error = new Error(`OpenAI workspace lookup failed (${response?.status || 'unknown'}).`);
    error.status = response?.status;
    throw error;
  }
  const payload = await response.json();
  const workspaces = normalizeCodexWorkspaces(payload);
  const isLegitimateEmptyList = Array.isArray(payload?.items) && payload.items.length === 0;
  if (workspaces.length === 0 && !isLegitimateEmptyList) {
    const topLevelKeys = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload).slice(0, 20)
      : [];
    (deps.logger || console).warn(
      `[codex] Workspace lookup returned no usable accounts; top-level keys: ${topLevelKeys.join(', ') || '(none)'}`
    );
  }
  return workspaces;
}

function authWithSelectedCodexWorkspace(auth, workspaceId) {
  const id = normalizeWorkspaceId(workspaceId);
  if (!id) throw new Error('Codex workspace id is required.');
  const root = auth && typeof auth === 'object' ? auth : {};
  const currentTokens = root.tokens && typeof root.tokens === 'object' ? root.tokens : {};
  const tokens = {
    ...currentTokens,
    account_id: id
  };
  delete tokens.accountId;
  return {
    ...root,
    tokens
  };
}

module.exports = {
  CODEX_WORKSPACES_URL,
  authWithSelectedCodexWorkspace,
  codexOAuthCredentials,
  listCodexWorkspaces,
  normalizeCodexWorkspaces,
  normalizeWorkspaceId
};
