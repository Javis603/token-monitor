'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const API_BASE_URL = 'https://cloudcode-pa.googleapis.com';
const API_DAILY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';
const API_DAILY_SANDBOX_BASE_URL = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
// CLIProxyAPI follows Antigravity Hub's own client identity. Cloud Code rejects
// newer model data for clients below 2.9.0, so keep the same safe floor when an
// installed app is older or unavailable.
const ANTIGRAVITY_CLIENT_VERSION = '2.9.1';
const ANTIGRAVITY_USER_AGENT = `antigravity/hub/${ANTIGRAVITY_CLIENT_VERSION} darwin/arm64`;
const ANTIGRAVITY_ONBOARD_USER_AGENT = `${ANTIGRAVITY_USER_AGENT} google-api-nodejs-client/10.3.0`;
const ANTIGRAVITY_GOOG_API_CLIENT = 'gl-node/22.21.1';
const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
]);
const REFRESH_SAFETY_MS = 60_000;
const OAUTH_CLIENT_ID_PATTERN = /[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/g;
const OAUTH_CLIENT_SECRET_PATTERN = /GOCSPX-[A-Za-z0-9_-]{28}/g;
// Antigravity ships more than one Google desktop OAuth client in the same Go
// binary. This is the client used by Antigravity Hub for the quota APIs. Pair it
// explicitly before falling back to the generic artifact parser; pairing the
// other client authenticates successfully but yields the reduced quota shape.
const ANTIGRAVITY_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_OAUTH_CLIENT_SECRET = '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';
const ANTIGRAVITY_METADATA = Object.freeze({ ideType: 'ANTIGRAVITY' });
const ANTIGRAVITY_CONTROL_PLANE_METADATA = Object.freeze({
  ide_type: 'ANTIGRAVITY',
  ide_version: ANTIGRAVITY_CLIENT_VERSION,
  ide_name: 'antigravity'
});

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function officialOAuthClient() {
  return {
    clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
    clientSecret: ANTIGRAVITY_OAUTH_CLIENT_SECRET
  };
}

function normalizeEmail(value) {
  return trimmed(value).toLowerCase();
}

function accountKey(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  const hash = crypto.createHash('sha256');
  hash.update('antigravity').update('\0').update(normalized).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

function normalizeManagedAccounts(value, options = {}) {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set();
  const seenAccounts = new Set();
  return value.flatMap((entry) => {
    const id = trimmed(entry?.id);
    const accountEmail = normalizeEmail(entry?.accountEmail || entry?.email);
    const identity = accountKey(accountEmail);
    if (!id || !accountEmail || seenIds.has(id) || seenAccounts.has(identity)) return [];
    seenIds.add(id);
    seenAccounts.add(identity);
    const normalized = {
      id,
      accountKey: trimmed(entry?.accountKey) || identity,
      accountEmail,
      accountLabel: trimmed(entry?.accountLabel),
      enabled: entry?.enabled !== false,
      addedAt: trimmed(entry?.addedAt),
      updatedAt: trimmed(entry?.updatedAt)
    };
    if (options.includeCredentials === true && entry?.credentials && typeof entry.credentials === 'object') {
      normalized.credentials = { ...entry.credentials };
    }
    return [normalized];
  });
}

function parseClientFromText(content) {
  const text = String(content || '');
  if (text.includes(ANTIGRAVITY_OAUTH_CLIENT_ID) && text.includes(ANTIGRAVITY_OAUTH_CLIENT_SECRET)) {
    return officialOAuthClient();
  }
  const marker = 'vs/platform/cloudCode/common/oauthClient.js';
  const markerIndex = text.indexOf(marker);
  const focused = markerIndex >= 0 ? text.slice(markerIndex, markerIndex + 4000) : text;
  const ids = unique(focused.match(OAUTH_CLIENT_ID_PATTERN) || []);
  const secrets = unique(focused.match(OAUTH_CLIENT_SECRET_PATTERN) || []);
  if (ids.length === 0 || secrets.length === 0) return null;
  if (secrets.length === 1 && ids.length > 1) {
    return { clientId: ids.at(-1), clientSecret: secrets[0] };
  }
  const clientSecret = secrets.length === ids.length && secrets.length > 1 ? secrets.at(-1) : secrets[0];
  return { clientId: ids[0], clientSecret };
}

function candidateOAuthArtifacts(options = {}) {
  const home = options.home || os.homedir();
  const roots = options.applicationRoots || [
    '/Applications/Antigravity.app',
    path.join(home, 'Applications', 'Antigravity.app'),
    '/Applications/Gemini.app',
    path.join(home, 'Applications', 'Gemini.app')
  ];
  const relative = [
    // Prefer the small JavaScript artifact so normal sign-in never decodes a
    // large language-server binary on the Electron main thread.
    'Contents/Resources/app/out/main.js',
    'Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm',
    'Contents/Resources/app/extensions/antigravity/bin/language_server_macos_x64',
    'Contents/Resources/app/extensions/antigravity/bin/language_server_macos',
    'Contents/Resources/bin/language_server',
    'Contents/Resources/bin/language_server_macos',
    'Contents/MacOS/Gemini'
  ];
  return roots.flatMap((root) => relative.map((entry) => path.join(root, entry)));
}

function discoverOAuthClient(options = {}) {
  const env = options.env || process.env;
  const configuredId = trimmed(env.ANTIGRAVITY_OAUTH_CLIENT_ID);
  const configuredSecret = trimmed(env.ANTIGRAVITY_OAUTH_CLIENT_SECRET);
  if (configuredId && configuredSecret) return { clientId: configuredId, clientSecret: configuredSecret };
  const fsApi = options.fs || fs;
  for (const filePath of candidateOAuthArtifacts(options)) {
    try {
      const stat = fsApi.statSync(filePath);
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024) continue;
      const client = parseClientFromText(fsApi.readFileSync(filePath).toString('latin1'));
      if (client) return client;
    } catch (error) {
      if (error?.code !== 'ENOENT') options.logger?.(`Could not inspect ${filePath}: ${error.message}`);
    }
  }
  return null;
}

function authorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', trimmed(clientId));
  url.searchParams.set('redirect_uri', trimmed(redirectUri));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'select_account consent');
  url.searchParams.set('state', trimmed(state));
  return url.toString();
}

function formBody(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => trimmed(value))).toString();
}

function errorWithStatus(status, message, httpStatus = null) {
  const error = new Error(message);
  error.status = status;
  if (Number.isInteger(httpStatus)) error.httpStatus = httpStatus;
  return error;
}

async function responseJson(response, action) {
  let body = null;
  try { body = await response.json(); } catch (_) {}
  if (response?.ok) return body || {};
  const status = Number(response?.status);
  const detail = trimmed(body?.error_description || body?.error?.message || body?.error) || `HTTP ${status || 0}`;
  if (status === 400 || status === 401) throw errorWithStatus('unauthorized', `${action}: ${detail}`, status);
  if (status === 403) throw errorWithStatus('permissionDenied', `${action}: ${detail}`, status);
  if (status === 429) throw errorWithStatus('rateLimited', `${action}: ${detail}`, status);
  throw errorWithStatus('unavailable', `${action}: ${detail}`, status);
}

async function exchangeAuthorizationCode({ code, client, redirectUri }, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      client_id: client?.clientId,
      client_secret: client?.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }),
    signal: deps.signal
  });
  const payload = await responseJson(response, 'Google OAuth exchange failed');
  if (!trimmed(payload.access_token)) throw errorWithStatus('unauthorized', 'Google OAuth exchange returned no access token');
  const nowMs = (deps.now || Date.now)();
  return {
    accessToken: trimmed(payload.access_token),
    refreshToken: trimmed(payload.refresh_token),
    expiresAt: nowMs + Math.max(0, Number(payload.expires_in) || 0) * 1000,
    idToken: trimmed(payload.id_token),
    clientId: trimmed(client?.clientId),
    clientSecret: trimmed(client?.clientSecret),
    projectId: ''
  };
}

async function fetchGoogleIdentity(credential, deps = {}) {
  const response = await (deps.fetch || fetch)(USERINFO_URL, {
    headers: { authorization: `Bearer ${trimmed(credential?.accessToken)}` },
    signal: deps.signal
  });
  const payload = await responseJson(response, 'Google account lookup failed');
  const email = normalizeEmail(payload.email);
  if (!email) throw errorWithStatus('unavailable', 'Google account lookup returned no email');
  return { email, name: trimmed(payload.name), picture: trimmed(payload.picture) };
}

async function refreshCredential(credential, deps = {}) {
  const expiresAt = Number(credential?.expiresAt);
  const nowMs = (deps.now || Date.now)();
  if (trimmed(credential?.accessToken) && (!Number.isFinite(expiresAt) || expiresAt - nowMs > REFRESH_SAFETY_MS)) {
    return { ...credential };
  }
  const refreshToken = trimmed(credential?.refreshToken);
  const clientId = trimmed(credential?.clientId);
  const clientSecret = trimmed(credential?.clientSecret);
  if (!refreshToken || !clientId || !clientSecret) throw errorWithStatus('unauthorized', 'Antigravity Google account needs to be added again');
  const response = await (deps.fetch || fetch)(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    signal: deps.signal
  });
  const payload = await responseJson(response, 'Google OAuth refresh failed');
  const updated = {
    ...credential,
    accessToken: trimmed(payload.access_token),
    refreshToken: trimmed(payload.refresh_token) || refreshToken,
    expiresAt: nowMs + Math.max(0, Number(payload.expires_in) || 0) * 1000,
    idToken: trimmed(payload.id_token) || trimmed(credential?.idToken)
  };
  if (!updated.accessToken) throw errorWithStatus('unauthorized', 'Google OAuth refresh returned no access token');
  await deps.onCredentialRenewed?.(updated, credential);
  return updated;
}

async function cloudCodeRequest(endpoint, accessToken, body, deps = {}, options = {}) {
  const baseUrl = trimmed(options.baseUrl) || API_BASE_URL;
  const response = await (deps.fetch || fetch)(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: '*/*',
      'content-type': 'application/json',
      'user-agent': trimmed(options.userAgent) || ANTIGRAVITY_USER_AGENT,
      ...(options.headers || {})
    },
    body: JSON.stringify(body || {}),
    signal: deps.signal
  });
  return responseJson(response, `Antigravity API ${endpoint} failed`);
}

function projectIdFrom(value) {
  for (const container of [value, value?.response]) {
    for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
      const project = container?.[key];
      const id = trimmed(typeof project === 'string' ? project : project?.value || project?.id || project?.projectId);
      if (id) return id;
    }
  }
  return '';
}

function planFromLoadResponse(response, credential) {
  const direct = trimmed(response?.planInfo?.planType);
  if (direct) return direct;
  const paidTierId = trimmed(response?.paidTier?.id).toLowerCase();
  if (paidTierId === 'g1-pro-tier') return 'Pro';
  const paidTierName = trimmed(response?.paidTier?.name);
  if (paidTierName) return paidTierName;
  const tierId = trimmed(response?.currentTier?.id);
  if (tierId === 'standard-tier') return 'Paid';
  if (tierId === 'legacy-tier') return 'Legacy';
  if (tierId === 'free-tier') return hostedDomainFromIdToken(credential?.idToken) ? 'Workspace' : 'Free';
  return trimmed(response?.currentTier?.name);
}

function hostedDomainFromIdToken(idToken) {
  try {
    const payload = String(idToken || '').split('.')[1];
    if (!payload) return '';
    return trimmed(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.hd);
  } catch (_) {
    return '';
  }
}

function onboardTier(response) {
  const allowed = Array.isArray(response?.allowedTiers) ? response.allowedTiers : [];
  return trimmed(allowed.find((tier) => tier?.isDefault === true)?.id)
    || trimmed(allowed.find((tier) => tier?.id)?.id)
    || trimmed(response?.paidTier?.id)
    || trimmed(response?.currentTier?.id)
    || 'free-tier';
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || errorWithStatus('unavailable', 'Operation cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || errorWithStatus('unavailable', 'Operation cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function resolveProjectId(loadResponse, credential, deps = {}) {
  const stored = trimmed(credential?.projectId);
  if (stored) return stored;
  const loaded = projectIdFrom(loadResponse);
  if (loaded) return loaded;
  const tierId = onboardTier(loadResponse);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const onboarded = await cloudCodeRequest('/v1internal:onboardUser', credential.accessToken, {
        tier_id: tierId,
        metadata: ANTIGRAVITY_CONTROL_PLANE_METADATA
      }, deps, {
        baseUrl: API_DAILY_BASE_URL,
        userAgent: ANTIGRAVITY_ONBOARD_USER_AGENT,
        headers: { 'x-goog-api-client': ANTIGRAVITY_GOOG_API_CLIENT }
      });
      const projectId = projectIdFrom(onboarded);
      if (projectId) return projectId;
      if (attempt < 4) await (deps.delay || delay)(2000, deps.signal);
    }
  } catch (error) {
    deps.logger?.(`Antigravity onboarding failed: ${error.message}`);
  }
  return '';
}

async function fetchAvailableModels(accessToken, projectBody, deps = {}) {
  const baseUrls = Array.isArray(deps.antigravityModelBaseUrls) && deps.antigravityModelBaseUrls.length > 0
    ? deps.antigravityModelBaseUrls
    : [API_BASE_URL, API_DAILY_BASE_URL, API_DAILY_SANDBOX_BASE_URL];
  let lastError = null;
  for (const baseUrl of baseUrls) {
    try {
      return await cloudCodeRequest('/v1internal:fetchAvailableModels', accessToken, projectBody, deps, { baseUrl });
    } catch (error) {
      lastError = error;
      if (error?.status === 'unauthorized' || error?.status === 'rateLimited') throw error;
    }
  }
  throw lastError || errorWithStatus('unavailable', 'Antigravity model endpoints returned no response');
}

function clampFraction(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function modelsFromAvailable(response) {
  const models = response?.models && typeof response.models === 'object' ? response.models : {};
  return Object.entries(models).flatMap(([modelId, value]) => {
    if (!value?.quotaInfo) return [];
    return [{
      modelId,
      label: trimmed(value.displayName || value.label) || modelId,
      remainingFraction: clampFraction(value.quotaInfo.remainingFraction),
      resetTime: trimmed(value.quotaInfo.resetTime) || null
    }];
  });
}

function modelsFromBuckets(response) {
  const byModel = new Map();
  for (const bucket of Array.isArray(response?.buckets) ? response.buckets : []) {
    const modelId = trimmed(bucket?.modelId);
    if (!modelId) continue;
    const next = {
      modelId,
      label: modelId,
      remainingFraction: clampFraction(bucket?.remainingFraction),
      resetTime: trimmed(bucket?.resetTime) || null
    };
    const current = byModel.get(modelId);
    if (!current || (next.remainingFraction ?? Infinity) < (current.remainingFraction ?? Infinity)) byModel.set(modelId, next);
  }
  return [...byModel.values()];
}

function mergeVerifiedModels(available, verified) {
  const byId = new Map(verified.map((model) => [normalizeEmail(model.modelId), model]));
  const merged = [];
  for (const model of available) {
    const match = byId.get(normalizeEmail(model.modelId));
    if (!match) continue;
    byId.delete(normalizeEmail(model.modelId));
    merged.push({
      ...model,
      remainingFraction: match.remainingFraction ?? model.remainingFraction,
      resetTime: match.resetTime || model.resetTime
    });
  }
  for (const model of byId.values()) if (model.remainingFraction !== null) merged.push(model);
  return merged;
}

async function fetchRemoteSnapshot(account, deps = {}) {
  let credential = await refreshCredential(account?.credential || account?.credentials, {
    ...deps,
    onCredentialRenewed: async (updated, previous) => deps.onCredentialRenewed?.(account, updated, previous)
  });
  const loadResponse = await cloudCodeRequest('/v1internal:loadCodeAssist', credential.accessToken, {
    metadata: ANTIGRAVITY_METADATA
  }, deps);
  const projectId = await resolveProjectId(loadResponse, credential, deps);
  if (projectId && projectId !== trimmed(credential.projectId)) {
    const previous = credential;
    credential = { ...credential, projectId };
    await deps.onCredentialRenewed?.(account, credential, previous);
  }
  const projectBody = projectId ? { project: projectId } : {};
  const quotaSummaryWindows = deps.quotaSummaryWindows;
  if (typeof quotaSummaryWindows === 'function') {
    try {
      const summary = await cloudCodeRequest(
        '/v1internal:retrieveUserQuotaSummary',
        credential.accessToken,
        projectBody,
        deps
      );
      const windows = quotaSummaryWindows(summary);
      if (windows.some((window) => window.remainingFraction !== null)) {
        return {
          accountEmail: normalizeEmail(account?.accountEmail),
          accountPlan: planFromLoadResponse(loadResponse, credential),
          windows,
          sourceDetail: 'oauth'
        };
      }
    } catch (error) {
      if (error?.status === 'unauthorized' || error?.status === 'rateLimited') throw error;
      deps.logger?.(`Antigravity quota summary unavailable: ${error.message}`);
    }
  }
  let models;
  try {
    const availableResponse = await fetchAvailableModels(credential.accessToken, projectBody, deps);
    models = modelsFromAvailable(availableResponse);
    if (models.length > 0 && models.every((model) => model.remainingFraction !== null && model.remainingFraction >= 0.999)) {
      try {
        const verified = modelsFromBuckets(await cloudCodeRequest('/v1internal:retrieveUserQuota', credential.accessToken, projectBody, deps));
        models = verified.some((model) => model.remainingFraction !== null) ? mergeVerifiedModels(models, verified) : [];
      } catch (error) {
        if (error?.status !== 'permissionDenied') throw error;
        models = [];
      }
    }
  } catch (error) {
    if (error?.status !== 'permissionDenied') throw error;
    try {
      models = modelsFromBuckets(await cloudCodeRequest('/v1internal:retrieveUserQuota', credential.accessToken, projectBody, deps));
    } catch (quotaError) {
      if (quotaError?.status !== 'permissionDenied') throw quotaError;
      models = [];
    }
  }
  const collapsePools = deps.collapsePools;
  if (typeof collapsePools !== 'function') throw new TypeError('collapsePools dependency is required');
  return {
    accountEmail: normalizeEmail(account?.accountEmail),
    accountPlan: planFromLoadResponse(loadResponse, credential),
    pools: collapsePools(models),
    sourceDetail: 'oauth'
  };
}

module.exports = {
  AUTH_URL,
  TOKEN_URL,
  USERINFO_URL,
  SCOPES,
  accountKey,
  authorizationUrl,
  candidateOAuthArtifacts,
  discoverOAuthClient,
  exchangeAuthorizationCode,
  fetchGoogleIdentity,
  fetchRemoteSnapshot,
  modelsFromAvailable,
  modelsFromBuckets,
  normalizeManagedAccounts,
  parseClientFromText,
  refreshCredential,
  _mergeVerifiedModels: mergeVerifiedModels,
  _planFromLoadResponse: planFromLoadResponse,
  _officialOAuthClient: officialOAuthClient
};
