import { liveActivityStaleDate } from './shared/liveActivity.js';

const DEFAULT_BUNDLE_ID = 'com.javis.tokenmonitor.ios';

function base64urlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlJSON(value) {
  return base64urlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function pemBytes(value) {
  const base64 = String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derToJose(signature) {
  if (signature.length === 64) return signature;
  if (signature[0] !== 0x30) return signature;
  let offset = 2;
  if ((signature[1] & 0x80) !== 0) offset += signature[1] & 0x7f;
  if (signature[offset++] !== 0x02) return signature;
  const rLength = signature[offset++];
  const r = signature.slice(offset, offset + rLength);
  offset += rLength;
  if (signature[offset++] !== 0x02) return signature;
  const sLength = signature[offset++];
  const s = signature.slice(offset, offset + sLength);
  const output = new Uint8Array(64);
  output.set(r.slice(-32), 32 - Math.min(32, r.length));
  output.set(s.slice(-32), 64 - Math.min(32, s.length));
  return output;
}

function createLiveActivityPushClient({
  env,
  fetchImpl = fetch,
  requestTimeoutMs = 10_000,
  now = () => Date.now(),
  logger = console
} = {}) {
  const keyID = String(env?.TOKEN_MONITOR_APNS_KEY_ID || '').trim();
  const teamID = String(env?.TOKEN_MONITOR_APNS_TEAM_ID || '').trim();
  const privateKey = String(env?.TOKEN_MONITOR_APNS_PRIVATE_KEY || '').trim();
  const bundleID = String(
    env?.TOKEN_MONITOR_APNS_BUNDLE_ID || DEFAULT_BUNDLE_ID
  ).trim();
  const environment = String(env?.TOKEN_MONITOR_APNS_ENVIRONMENT || 'production')
    .trim()
    .toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  const enabled = Boolean(keyID && teamID && privateKey && typeof fetchImpl === 'function');
  let signingKeyPromise;
  let cachedToken;

  async function signingKey() {
    if (!signingKeyPromise) {
      signingKeyPromise = crypto.subtle.importKey(
        'pkcs8',
        pemBytes(privateKey),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
      );
    }
    return signingKeyPromise;
  }

  async function providerToken() {
    const issuedAt = Math.floor(now() / 1000);
    if (cachedToken && issuedAt >= cachedToken.issuedAt && issuedAt - cachedToken.issuedAt < 50 * 60) {
      return cachedToken.value;
    }
    const header = base64urlJSON({ alg: 'ES256', kid: keyID });
    const payload = base64urlJSON({ iss: teamID, iat: issuedAt });
    const unsigned = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      await signingKey(),
      new TextEncoder().encode(unsigned)
    );
    const value = `${unsigned}.${base64urlBytes(derToJose(new Uint8Array(signature)))}`;
    cachedToken = { issuedAt, value };
    return value;
  }

  function endpoint(activityToken) {
    const host = environment === 'sandbox'
      ? 'api.sandbox.push.apple.com'
      : 'api.push.apple.com';
    return `https://${host}/3/device/${encodeURIComponent(activityToken)}`;
  }

  async function send(activityToken, contentState) {
    if (!enabled) return { sent: false, skipped: true };
    const timestamp = Math.floor(now() / 1000);
    const response = await fetchImpl(endpoint(activityToken), {
      method: 'POST',
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        authorization: `bearer ${await providerToken()}`,
        'content-type': 'application/json',
        'apns-topic': `${bundleID}.push-type.liveactivity`,
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

  return { enabled, send };
}

export { createLiveActivityPushClient };
