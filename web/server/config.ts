import { BlockList, isIP } from 'node:net';
export interface GatewayConfig {
  hubUrl: string;
  host: string;
  port: number;
  secret: string;
  trustOidcProxy: boolean;
  // Legacy config retained for migration; opaque sessions are now server-owned.
  sessionSecret: string;
  authMode?: 'local' | 'proxy' | 'trusted-proxy' | 'basic' | 'oidc';
  publicOrigin?: string;
  basicUsername?: string;
  basicPassword?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcSubjects?: string[];
  trustedProxyPeers?: string[];
  proxyHeader?: string;
  proxyMode?: 'header' | 'external';
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
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  // Preserve the legacy proxy switch; explicit WEB_AUTH_MODE takes precedence.
  // Auth strategies and opaque browser sessions are implemented in auth.ts.
  const trustOidcProxy = /^(1|true)$/i.test(String(env.TRUST_OIDC_PROXY ?? '0').trim());
  const authMode = env.WEB_AUTH_MODE || (trustOidcProxy ? 'proxy' : 'local');
  if (!['local','proxy','trusted-proxy','basic','oidc'].includes(authMode)) throw new Error('WEB_AUTH_MODE must be local, basic, oidc or trusted-proxy');
  const host = String(env.GATEWAY_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  if (authMode === 'local' && !['localhost','127.0.0.1','::1'].includes(host)) throw new Error('Local mode requires a loopback GATEWAY_HOST');
  const sessionSecret = env.GATEWAY_SESSION_SECRET || ''; // ignored legacy signing key
  const publicOrigin=env.WEB_PUBLIC_ORIGIN;
  if (publicOrigin) {
    const parsed=new URL(publicOrigin);
    if(parsed.origin!==publicOrigin || (parsed.protocol!=='https:' && !(parsed.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)))) throw new Error('WEB_PUBLIC_ORIGIN must be an HTTPS origin (HTTP loopback is allowed)');
  }
  if(['basic','oidc'].includes(authMode) && !publicOrigin) throw new Error('WEB_PUBLIC_ORIGIN is required');
  if(authMode==='basic' && (!env.WEB_BASIC_USERNAME || env.WEB_BASIC_USERNAME.includes(':') || !env.WEB_BASIC_PASSWORD)) throw new Error('Basic mode requires WEB_BASIC_USERNAME and WEB_BASIC_PASSWORD');
  if(authMode==='oidc') {
    if(!env.WEB_OIDC_ISSUER || !env.WEB_OIDC_CLIENT_ID)throw new Error('OIDC requires WEB_OIDC_ISSUER and WEB_OIDC_CLIENT_ID');
    const issuer=new URL(env.WEB_OIDC_ISSUER);
    if(issuer.protocol!=='https:' || issuer.username || issuer.password || issuer.search || issuer.hash)throw new Error('WEB_OIDC_ISSUER must be an HTTPS issuer URL');
  }
  const proxyMode=env.WEB_TRUSTED_PROXY_MODE || 'header';
  if(proxyMode==='external' && ['proxy','trusted-proxy'].includes(authMode) && !publicOrigin)throw new Error('WEB_PUBLIC_ORIGIN is required for external proxy authentication');
  if(!['header','external'].includes(proxyMode))throw new Error('WEB_TRUSTED_PROXY_MODE must be header or external');
  const proxyHeader=env.WEB_TRUSTED_PROXY_HEADER || 'x-forwarded-user';
  if(!/^[a-z0-9-]+$/.test(proxyHeader) || ['authorization','cookie','host'].includes(proxyHeader))throw new Error('Invalid WEB_TRUSTED_PROXY_HEADER');
  const trustedProxyPeers=(env.WEB_TRUSTED_PROXY_PEERS || '127.0.0.1,::1').split(',').map(x=>x.trim());
  const check=new BlockList();
  try {for(const entry of trustedProxyPeers){const [address,prefix,...extra]=entry.split('/');if(extra.length || !isIP(address))throw new Error();const type=isIP(address)===4?'ipv4':'ipv6';if(prefix!==undefined){if(!/^\d+$/.test(prefix))throw new Error();check.addSubnet(address,Number(prefix),type);}else check.addAddress(address,type);}} catch {throw new Error('WEB_TRUSTED_PROXY_PEERS requires IP addresses or CIDR ranges');}
  return {
    hubUrl: validHubUrl(env.HUB_URL),
    host,
    port: validPort(env.GATEWAY_PORT),
    secret: requiredSecret(env.TOKEN_MONITOR_SECRET),
    trustOidcProxy: ['proxy','trusted-proxy'].includes(authMode),
    authMode: authMode as GatewayConfig['authMode'],
    publicOrigin, basicUsername:env.WEB_BASIC_USERNAME,basicPassword:env.WEB_BASIC_PASSWORD,
    oidcIssuer:env.WEB_OIDC_ISSUER,oidcClientId:env.WEB_OIDC_CLIENT_ID,oidcClientSecret:env.WEB_OIDC_CLIENT_SECRET,
    oidcSubjects:env.WEB_OIDC_ALLOWED_SUBJECTS?.split(',').map(x=>x.trim()).filter(Boolean),
    proxyHeader, proxyMode:proxyMode as 'header'|'external', trustedProxyPeers,
    sessionSecret
  };
}
