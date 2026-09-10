import { randomBytes } from 'node:crypto';
export interface GatewayConfig {
  hubUrl: string;
  host: string;
  port: number;
  secret: string;
  trustOidcProxy: boolean;
  // HMAC key for the browser session cookie (tm_session) issued on the
  // OIDC-protected SPA shell. Browsers never hold the Hub secret; this cookie
  // is what lets them read /api/* once reverse proxy passes those paths through.
  sessionSecret: string;
  authMode?: 'local' | 'proxy';
}

function requiredSecret(value: string | undefined): string {
  const secret = String(value ?? '').trim();
  if (!secret) throw new Error('TOKEN_MONITOR_SECRET is required');
  return secret;
}

function validHubUrl(value: string | undefined): string {
  const raw = String(value ?? 'http://127.0.0.1:17321').trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('HUB_URL must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('HUB_URL must be a valid http(s) URL without credentials');
  }
  return url.toString().replace(/\/$/, '');
}

function validPort(value: string | undefined): number {
  const port = Number(value ?? 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('GATEWAY_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function validSessionSecret(value: string | undefined): string {
  const secret = String(value ?? '').trim();
  if (secret !== '' && secret.length < 16) {
    throw new Error('GATEWAY_SESSION_SECRET must be at least 16 characters');
  }
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  // When enabled, API requests without Authorization may authenticate through
  // the x-forwarded-user identity injected by the trusted authentication proxy, or
  // through the gateway-issued tm_session cookie (see app.ts).
  const trustOidcProxy = /^(1|true)$/i.test(String(env.TRUST_OIDC_PROXY ?? '0').trim());
  const authMode = env.WEB_AUTH_MODE || (trustOidcProxy ? 'proxy' : 'local');
  if (!['local','proxy'].includes(authMode)) throw new Error('WEB_AUTH_MODE must be local or proxy');
  const host = String(env.GATEWAY_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  if (authMode === 'local' && !['localhost','127.0.0.1','::1'].includes(host)) throw new Error('Local mode requires a loopback GATEWAY_HOST');
  const sessionSecret = validSessionSecret(env.GATEWAY_SESSION_SECRET) || (authMode === 'local' ? randomBytes(32).toString('hex') : '');
  if (authMode === 'proxy' && sessionSecret === '') {
    throw new Error('GATEWAY_SESSION_SECRET is required in proxy mode');
  }
  return {
    hubUrl: validHubUrl(env.HUB_URL),
    host,
    port: validPort(env.GATEWAY_PORT),
    secret: requiredSecret(env.TOKEN_MONITOR_SECRET),
    trustOidcProxy: authMode === 'proxy',
    authMode: authMode as 'local' | 'proxy',
    sessionSecret
  };
}
