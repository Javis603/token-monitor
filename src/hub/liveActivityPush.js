'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const http2 = require('node:http2');
const { liveActivityStaleDate } = require('../shared/liveActivity');

const DEFAULT_BUNDLE_ID = 'com.javis.tokenmonitor.ios';
const DEFAULT_MIN_INTERVAL_MS = 15_000;

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function readPrivateKey({ privateKey, privateKeyFile } = {}) {
  const inline = normalizePrivateKey(privateKey);
  if (inline) return inline;
  const file = String(privateKeyFile || '').trim();
  if (!file) return '';
  try {
    return normalizePrivateKey(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return '';
  }
}

function createProviderToken({ keyID, teamID, privateKey, now = () => Date.now() }) {
  let cached;
  return () => {
    const issuedAt = Math.floor(now() / 1000);
    if (cached && issuedAt >= cached.issuedAt && issuedAt - cached.issuedAt < 50 * 60) return cached.value;
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyID }));
    const payload = base64url(JSON.stringify({ iss: teamID, iat: issuedAt }));
    const unsigned = `${header}.${payload}`;
    const signer = crypto.createSign('SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign({
      key: privateKey,
      dsaEncoding: 'ieee-p1363'
    });
    const value = `${unsigned}.${base64url(signature)}`;
    cached = { issuedAt, value };
    return value;
  };
}

function sendHttp2(urlText, options) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const client = http2.connect(`${url.protocol}//${url.host}`);
    let settled = false;
    const abort = () => finish(() => reject(options.signal.reason || new Error('APNs request aborted')));
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      // Destroy also closes stalled streams; graceful close alone can hang forever.
      try { client.destroy(); } catch (_) {}
      callback();
    };
    client.once('error', (error) => finish(() => reject(error)));
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    let request;
    try {
      request = client.request({
        ':method': options.method || 'GET',
        ':path': `${url.pathname}${url.search}`,
        ...options.headers
      });
    } catch (error) {
      return finish(() => reject(error));
    }
    const chunks = [];
    let status = 500;
    request.setEncoding('utf8');
    request.on('response', (headers) => {
      status = Number(headers[':status'] || 500);
    });
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('error', (error) => finish(() => reject(error)));
    request.once('end', () => finish(() => resolve({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        const body = chunks.join('');
        if (!body) return {};
        return JSON.parse(body);
      }
    })));
    request.end(options.body || undefined);
  });
}

function createLiveActivityPushClient({
  keyID,
  teamID,
  privateKey,
  privateKeyFile,
  bundleID = DEFAULT_BUNDLE_ID,
  environment = 'production',
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  fetchImpl,
  requestTimeoutMs = 10_000,
  requestImpl = sendHttp2,
  now = () => Date.now(),
  logger = console
} = {}) {
  const normalizedKeyID = String(keyID || '').trim();
  const normalizedTeamID = String(teamID || '').trim();
  const normalizedPrivateKey = readPrivateKey({ privateKey, privateKeyFile });
  const normalizedEnvironment = String(environment || '').trim().toLowerCase() === 'sandbox'
    ? 'sandbox'
    : 'production';
  const normalizedBundleID = String(bundleID || '').trim() || DEFAULT_BUNDLE_ID;
  const normalizedMinIntervalMs = Number.isFinite(Number(minIntervalMs))
    ? Math.max(0, Number(minIntervalMs))
    : DEFAULT_MIN_INTERVAL_MS;
  const enabled = Boolean(
    normalizedKeyID
      && normalizedTeamID
      && normalizedPrivateKey
      && (typeof fetchImpl === 'function' || typeof requestImpl === 'function')
  );
  const token = enabled
    ? createProviderToken({
        keyID: normalizedKeyID,
        teamID: normalizedTeamID,
        privateKey: normalizedPrivateKey,
        now
      })
    : null;

  function endpoint(activityToken) {
    const host = normalizedEnvironment === 'sandbox'
      ? 'api.sandbox.push.apple.com'
      : 'api.push.apple.com';
    return `https://${host}/3/device/${encodeURIComponent(activityToken)}`;
  }

  async function send(activityToken, contentState) {
    if (!enabled) return { sent: false, skipped: true };
    const transport = typeof fetchImpl === 'function' ? fetchImpl : requestImpl;
    const timestamp = Math.floor(now() / 1000);
    const response = await transport(endpoint(activityToken), {
      method: 'POST',
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        authorization: `bearer ${token()}`,
        'content-type': 'application/json',
        'apns-topic': `${normalizedBundleID}.push-type.liveactivity`,
        'apns-push-type': 'liveactivity',
        'apns-priority': '10',
        'apns-expiration': '0'
      },
      body: JSON.stringify({
        aps: {
          timestamp,
          event: 'update',
          'stale-date': liveActivityStaleDate(contentState, timestamp),
          'content-state': contentState
        }
      })
    });
    let body = null;
    try { body = await response.json(); } catch (_) { /* APNs may return an empty body. */ }
    if (response.ok) return { sent: true };
    const reason = String(body?.reason || '').trim();
    const invalid = response.status === 410
      || reason === 'BadDeviceToken'
      || reason === 'Unregistered';
    if (!invalid) {
      logger.warn?.(`ActivityKit push failed with HTTP ${response.status}${reason ? ` (${reason})` : ''}.`);
    }
    return { sent: false, invalid, status: response.status, reason };
  }

  return {
    enabled,
    minIntervalMs: normalizedMinIntervalMs,
    send
  };
}

function createLiveActivityPushClientFromEnv({
  env = process.env,
  fetchImpl,
  requestImpl,
  now,
  logger
} = {}) {
  return createLiveActivityPushClient({
    keyID: env.TOKEN_MONITOR_APNS_KEY_ID,
    teamID: env.TOKEN_MONITOR_APNS_TEAM_ID,
    privateKey: env.TOKEN_MONITOR_APNS_PRIVATE_KEY,
    privateKeyFile: env.TOKEN_MONITOR_APNS_PRIVATE_KEY_FILE,
    bundleID: env.TOKEN_MONITOR_APNS_BUNDLE_ID || DEFAULT_BUNDLE_ID,
    environment: env.TOKEN_MONITOR_APNS_ENVIRONMENT || 'production',
    minIntervalMs: env.TOKEN_MONITOR_APNS_MIN_INTERVAL_MS || DEFAULT_MIN_INTERVAL_MS,
    fetchImpl,
    requestImpl,
    now,
    logger
  });
}

module.exports = {
  createLiveActivityPushClient,
  createLiveActivityPushClientFromEnv
};
