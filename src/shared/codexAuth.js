'use strict';

const crypto = require('node:crypto');

function hashAccountKey(seed) {
  const raw = String(seed || '').trim();
  if (!raw) return '';
  if (raw.startsWith('sha256:')) return raw;
  const hash = crypto.createHash('sha256');
  hash.update('codex').update('\0').update(raw).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

function codexAccountKey(email, providerAccountId) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedProviderAccountId = String(providerAccountId || '').trim().toLowerCase();
  if (normalizedEmail && normalizedProviderAccountId) {
    return hashAccountKey(`${normalizedEmail}\0${normalizedProviderAccountId}`);
  }
  return hashAccountKey(normalizedProviderAccountId || normalizedEmail);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeWorkspaceId(value) {
  return String(value || '').trim().toLowerCase();
}

function codexStoredAccountId(auth) {
  const tokens = auth?.tokens || auth || {};
  return normalizeWorkspaceId(
    tokens.account_id
    || tokens.accountId
    || auth?.account_id
    || auth?.accountId
  );
}

function managedAccountWorkspaceId(account) {
  return normalizeWorkspaceId(
    account?.workspaceAccountId
    || account?.providerAccountId
  );
}

function codexManagedAccountIdentityKey(account) {
  const id = String(account?.id || '').trim();
  const accountKey = String(account?.accountKey || '').trim();
  const email = normalizeEmail(account?.email || account?.accountEmail);
  const workspaceAccountId = managedAccountWorkspaceId(account);
  return workspaceAccountId && email
    ? `workspace:${workspaceAccountId}:email:${email}`
    : accountKey || email || id;
}

function preserveCodexManagedHydrationCollisions(storedAccounts, hydratedAccounts) {
  if (!Array.isArray(storedAccounts) || !Array.isArray(hydratedAccounts)) return [];
  if (storedAccounts.length !== hydratedAccounts.length) return storedAccounts.slice();

  const resolved = hydratedAccounts.slice();
  for (let pass = 0; pass <= storedAccounts.length; pass += 1) {
    const indexesByKey = new Map();
    resolved.forEach((account, index) => {
      const key = codexManagedAccountIdentityKey(account);
      const indexes = indexesByKey.get(key) || [];
      indexes.push(index);
      indexesByKey.set(key, indexes);
    });
    const collisions = Array.from(indexesByKey.values()).filter((indexes) => indexes.length > 1);
    if (collisions.length === 0) return resolved;

    let reverted = false;
    for (const indexes of collisions) {
      for (const index of indexes) {
        if (resolved[index] === storedAccounts[index]) continue;
        resolved[index] = storedAccounts[index];
        reverted = true;
      }
    }
    if (!reverted) break;
  }

  // Stored accounts were normalized before hydration, so falling back to them
  // is always safer than returning a set that would be deduped on the next save.
  return storedAccounts.slice();
}

function codexManagedAccountMatchesIdentity(account, identity) {
  if (!account || !identity) return false;
  const accountEmail = normalizeEmail(account.email || account.accountEmail);
  const identityEmail = normalizeEmail(identity.email || identity.accountEmail);
  if (accountEmail && identityEmail && accountEmail !== identityEmail) return false;

  const accountWorkspaceId = managedAccountWorkspaceId(account);
  const identityWorkspaceId = normalizeWorkspaceId(
    identity.workspaceAccountId
    || identity.providerAccountId
  );
  if (accountWorkspaceId && identityWorkspaceId) {
    return accountWorkspaceId === identityWorkspaceId
      && Boolean(accountEmail && identityEmail && accountEmail === identityEmail);
  }

  const accountKey = String(account.accountKey || '').trim();
  const identityKey = String(identity.accountKey || '').trim();
  if (accountKey && identityKey && accountKey === identityKey) return true;

  if (identityWorkspaceId) {
    // Migrate records created before workspace-aware composite keys. Those
    // records hashed only the workspace id, so email must also match.
    return Boolean(
      accountEmail
      && accountEmail === identityEmail
      && accountKey === hashAccountKey(identityWorkspaceId)
    );
  }
  if (accountKey && identityKey) return false;
  return Boolean(accountEmail && accountEmail === identityEmail);
}

function upgradeCodexManagedAccountIdentity(account, identity) {
  if (!account || typeof account !== 'object' || !identity) return account;
  const accountEmail = normalizeEmail(account.email || account.accountEmail);
  const identityEmail = normalizeEmail(identity.email || identity.accountEmail);
  if (accountEmail && identityEmail && accountEmail !== identityEmail) return account;

  const accountWorkspaceId = managedAccountWorkspaceId(account);
  const identityWorkspaceId = normalizeWorkspaceId(
    identity.workspaceAccountId
    || identity.providerAccountId
  );
  if (accountWorkspaceId && identityWorkspaceId && accountWorkspaceId !== identityWorkspaceId) {
    return account;
  }

  const accountKey = String(account.accountKey || '').trim();
  const identityKey = String(identity.accountKey || '').trim();
  const resolvedEmail = identityEmail || accountEmail;
  const resolvedWorkspaceId = identityWorkspaceId || accountWorkspaceId;
  const resolvedKey = resolvedEmail && resolvedWorkspaceId
    ? codexAccountKey(resolvedEmail, resolvedWorkspaceId)
    : accountKey || identityKey;
  if (!resolvedKey) return account;
  return {
    ...account,
    email: resolvedEmail,
    accountKey: resolvedKey,
    accountLabel: String(identity.accountLabel || account.accountLabel || '').trim(),
    workspaceAccountId: resolvedWorkspaceId
  };
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2 || !parts[1]) return {};
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function codexAuthClaims(auth) {
  const tokens = auth?.tokens || auth || {};
  const idToken = tokens.id_token || tokens.idToken || auth?.id_token || auth?.idToken || '';
  const payload = decodeJwtPayload(idToken);
  const nested = payload['https://api.openai.com/auth'] || payload['https://api.openai.com/profile'] || {};
  const claimedAccountId = normalizeWorkspaceId(
    payload.chatgpt_account_id
    || nested.chatgpt_account_id
  );
  const claimedIsFedrampAccount = (
    typeof nested.chatgpt_account_is_fedramp === 'boolean'
      ? nested.chatgpt_account_is_fedramp
      : typeof payload.chatgpt_account_is_fedramp === 'boolean'
        ? payload.chatgpt_account_is_fedramp
        : undefined
  );
  return {
    tokens,
    payload,
    nested,
    claimedAccountId,
    claimedIsFedrampAccount
  };
}

function codexOAuthRequestContext(auth, options = {}) {
  const { tokens, claimedAccountId, claimedIsFedrampAccount } = codexAuthClaims(auth);
  const accessToken = String(
    tokens.access_token
    || tokens.accessToken
    || auth?.access_token
    || auth?.accessToken
    || ''
  ).trim();
  const storedAccountId = codexStoredAccountId(auth);
  const requestedAccountId = normalizeWorkspaceId(options.accountId);
  const accountId = requestedAccountId || storedAccountId || claimedAccountId;
  return {
    accessToken,
    accountId,
    isFedrampAccount: Boolean(
      accountId
      && claimedAccountId
      && accountId === claimedAccountId
      && claimedIsFedrampAccount === true
    )
  };
}

function codexAuthIdentity(auth) {
  const { tokens, payload, nested } = codexAuthClaims(auth);
  const email = String(
    payload.email ||
    nested.email ||
    auth?.account?.email ||
    auth?.email ||
    ''
  ).trim().toLowerCase();
  const accountLabel = String(
    payload.chatgpt_plan_type ||
    nested.chatgpt_plan_type ||
    auth?.account?.planType ||
    auth?.account?.plan_type ||
    ''
  ).trim();
  const providerAccountId = String(
    tokens.account_id ||
    tokens.accountId ||
    auth?.account_id ||
    auth?.accountId ||
    payload.chatgpt_account_id ||
    nested.chatgpt_account_id ||
    ''
  ).trim().toLowerCase();
  // A workspace id is shared by every member of that workspace, while one user
  // can belong to several workspaces. Use the composite identity so both cases
  // remain distinct; email-only auth stays a legacy fallback.
  return {
    email,
    accountLabel,
    providerAccountId,
    workspaceAccountId: providerAccountId,
    accountKey: codexAccountKey(email, providerAccountId)
  };
}

// Normalizes parsed auth into the text shape writeCodexAuthFile/commitCodexManagedAccount store
// for a web-login account, so an imported account is semantically interchangeable with one (same
// parsed object; the collector re-parses JSON, so byte-for-byte identity with codex's own bytes is
// not required and not guaranteed — import re-serializes, a no-workspace-select web login preserves
// codex's original bytes verbatim).
function codexAuthJsonData(auth) {
  return `${JSON.stringify(auth, null, 2)}\n`;
}

function hasCodexIdentity(identity) {
  return Boolean(identity && (identity.accountKey || identity.email));
}

// Parses a pasted/read ~/.codex/auth.json into the same { auth, identity } the web-login path
// produces (it runs the identical codexAuthIdentity over the parsed object). Throws a clear,
// user-facing error for empty, non-JSON, or identity-less input so the UI can surface it.
function parseCodexAuthJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Codex auth.json is empty.');
  let auth;
  try {
    auth = JSON.parse(trimmed);
  } catch (error) {
    const parseError = new Error('Codex auth.json is not valid JSON.');
    parseError.cause = error;
    throw parseError;
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new Error('Codex auth.json must contain a JSON object.');
  }
  const identity = codexAuthIdentity(auth);
  if (!hasCodexIdentity(identity)) {
    throw new Error('Could not identify a Codex account in this auth.json.');
  }
  return { auth, identity, data: codexAuthJsonData(auth), source: 'authJson' };
}

// Accepts either a pasted full auth.json (JSON object) or a bare Codex access token. A bare token
// is only useful when it is itself the JWT carrying the email/account claims codexAuthIdentity
// reads (ChatGPT access tokens are); an opaque token yields no identity and is rejected with a
// clear error rather than silently producing an unnamed account.
//
// Limitation: a bare access token carries no refresh_token, so the constructed auth.json cannot
// refresh once the short-lived access JWT expires. Limits then surface an unauthorized status on
// the Limits page (the collector reads tokens.access_token directly); for persistent tracking,
// importing the full ~/.codex/auth.json (file picker) is preferred, since it carries refresh_token.
function authFromCodexAccessToken(token) {
  const trimmed = String(token || '').trim();
  if (!trimmed) throw new Error('Access token is empty.');
  if (trimmed.startsWith('{')) {
    // A pasted full auth.json: delegate to the structured parser for a consistent result.
    return parseCodexAuthJson(trimmed);
  }
  const auth = { tokens: { access_token: trimmed } };
  const payload = decodeJwtPayload(trimmed);
  if (payload && Object.keys(payload).length > 0) {
    // The access token is the JWT that carries the identity claims, so feed it through the same
    // id_token path codexAuthIdentity reads.
    auth.tokens.id_token = trimmed;
  }
  const identity = codexAuthIdentity(auth);
  if (!hasCodexIdentity(identity)) {
    throw new Error('Could not identify the account from this access token. Paste a Codex access token (JWT) or the full auth.json.');
  }
  return { auth, identity, data: codexAuthJsonData(auth), source: 'token' };
}

module.exports = {
  codexManagedAccountIdentityKey,
  codexManagedAccountMatchesIdentity,
  preserveCodexManagedHydrationCollisions,
  upgradeCodexManagedAccountIdentity,
  decodeJwtPayload,
  codexStoredAccountId,
  codexOAuthRequestContext,
  codexAuthIdentity,
  codexAccountKey,
  hashAccountKey,
  hasCodexIdentity,
  parseCodexAuthJson,
  authFromCodexAccessToken
};
