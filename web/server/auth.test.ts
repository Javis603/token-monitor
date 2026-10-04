// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import * as oidc from 'openid-client';
import { createAuth } from './auth.js';
import { loadConfig, type GatewayConfig } from './config.js';
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function baseConfig(): GatewayConfig {
  return {
    hubUrl: 'http://127.0.0.1:1', host: '127.0.0.1', port: 0,
    secret: 'synthetic-hub', sessionSecret: '', trustOidcProxy: false,
    publicOrigin: 'http://127.0.0.1:1'
  };
}
async function harness(config: GatewayConfig, discover?: () => Promise<oidc.Configuration>) {
  const auth = createAuth(config, discover);
  const base = await listen(createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, config.publicOrigin);
      if (await auth.handle(req, res, url)) return;
      const shell = !url.pathname.startsWith('/api/');
      if (!auth.authorized(req, shell)) {
        auth.deny(req, res, shell);
        return;
      }
      if (shell) auth.issue(req, res);
      res.end('ok');
    })().catch(() => { res.statusCode = 500; res.end('error'); });
  }));
  config.publicOrigin = base;
  return base;
}
const cookieOf=(r:Response)=>r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
it('Basic authenticates independently of Hub bearer, rate limits failures and revokes logout sessions',async()=>{
 const base=await harness({...baseConfig(),authMode:'basic',basicUsername:'demo',basicPassword:'synthetic-password'});
 expect((await fetch(base)).headers.get('www-authenticate')).toContain('Basic');
 const login=await fetch(base,{headers:{authorization:'Basic '+Buffer.from('demo:synthetic-password').toString('base64')}});
 expect(login.status).toBe(200);const cookie=cookieOf(login);
 expect((await fetch(base+'/api/stats',{headers:{cookie}})).status).toBe(200);
 expect((await fetch(base+'/auth/logout',{method:'POST',headers:{cookie}})).status).toBe(403);
 expect((await fetch(base+'/auth/logout',{method:'POST',headers:{cookie,origin:base}})).status).toBe(200);
 expect((await fetch(base+'/api/stats',{headers:{cookie}})).status).toBe(401);
 for(let i=0;i<21;i++)await fetch(base,{headers:{authorization:'Basic '+Buffer.from('demo:wrong').toString('base64')}});
 expect((await fetch(base,{headers:{authorization:'Basic '+Buffer.from('demo:wrong').toString('base64')}})).status).toBe(429);
});
it('Basic cooldown rejects even a correct password until the failed-attempt window expires',async()=>{
 const base=await harness({...baseConfig(),authMode:'basic',basicUsername:'demo',basicPassword:'synthetic-password'});
 const header=(password:string)=>({authorization:'Basic '+Buffer.from('demo:'+password).toString('base64')});
 for(let i=0;i<20;i++)await fetch(base,{headers:header('wrong')});
 const blocked=await fetch(base,{headers:header('synthetic-password')});
 expect(blocked.status).toBe(429);expect(blocked.headers.getSetCookie()).toEqual([]);
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+61000);
 expect((await fetch(base,{headers:header('synthetic-password')})).status).toBe(200);
});
it('Basic compares exact UTF-8 credential bytes without decoding malformed sequences',async()=>{
 const base=await harness({...baseConfig(),authMode:'basic',basicUsername:'demo',basicPassword:'\uFFFD'});
 const malformed=Buffer.concat([Buffer.from('demo:'),Buffer.from([255])]);
 expect((await fetch(base,{headers:{authorization:'Basic '+malformed.toString('base64')}})).status).toBe(401);
 expect((await fetch(base,{headers:{authorization:'Basic '+Buffer.from('demo:\uFFFD').toString('base64')}})).status).toBe(200);
});
it('trusted proxy validates socket peers and custom identity headers; XFF cannot grant trust',async()=>{
 const cfg={...baseConfig(),authMode:'trusted-proxy' as const,proxyHeader:'x-auth-user',trustedProxyPeers:['192.0.2.1']};
 const base=await harness(cfg);
 expect((await fetch(base,{headers:{'x-auth-user':'demo','x-forwarded-for':'192.0.2.1'}})).status).toBe(401);
 const trusted=await harness({...cfg,trustedProxyPeers:['127.0.0.1']});
 expect((await fetch(trusted)).status).toBe(401);
 expect((await fetch(trusted,{headers:{'x-auth-user':'demo'}})).status).toBe(200);
});
it('explicit external proxy mode mints sessions without an identity header but not for anonymous API calls',async()=>{
 const base=await harness({...baseConfig(),authMode:'trusted-proxy',proxyMode:'external'});
 expect((await fetch(base+'/api/stats')).status).toBe(401);
 const page=await fetch(base);expect(page.status).toBe(200);const cookie=cookieOf(page);
 expect((await fetch(base+'/api/stats',{headers:{cookie}})).status).toBe(200);
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+9*3600000);
 expect((await fetch(base+'/api/stats',{headers:{cookie}})).status).toBe(401);
});
it('fails startup for incomplete or unsafe auth settings',()=>{
 for(const fields of [{WEB_AUTH_MODE:'basic'},{WEB_AUTH_MODE:'oidc',WEB_PUBLIC_ORIGIN:'https://web.example'},{WEB_AUTH_MODE:'trusted-proxy',WEB_TRUSTED_PROXY_MODE:'external'},{WEB_TRUSTED_PROXY_PEERS:'not-an-ip'},{WEB_PUBLIC_ORIGIN:'https://web.example/path'}])expect(()=>loadConfig({TOKEN_MONITOR_SECRET:'synthetic',...fields})).toThrow();
});

async function oidcHarness(variant='valid'){
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'};
 let nonce='';let challenge='';let pkceVerified=false;let issuer='';
 issuer=await listen(createServer((req,res)=>{void(async()=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/jwks'){res.end(JSON.stringify({keys:[jwk]}));return;}
  if(req.url==='/token'){
   let body='';for await(const part of req)body+=part;
   const values=new URLSearchParams(body);pkceVerified=createHash('sha256').update(values.get('code_verifier')||'').digest('base64url')===challenge;
   const now=Math.floor(Date.now()/1000);
   const claims={iss:variant==='issuer'?'https://wrong.example':issuer,aud:variant==='audience'?'wrong':'demo-client',sub:'demo-user',iat:now,exp:variant==='expired'?now-1000:now+300,nonce:variant==='nonce'?'wrong':nonce};
   const unsigned=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
   const signature=sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url');
   res.end(JSON.stringify({access_token:'synthetic',token_type:'Bearer',id_token:unsigned+'.'+(variant==='signature'?signature.slice(0,-8)+'AAAAAAAA':signature)}));return;
  }
  res.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']}));
 })();}));
 const config={...baseConfig(),authMode:'oidc' as const,oidcIssuer:issuer,oidcClientId:'demo-client',oidcClientSecret:'synthetic-client-secret'};
 const base=await harness(config,()=>oidc.discovery(new URL(issuer),'demo-client','synthetic-client-secret',undefined,{execute:[oidc.allowInsecureRequests]}));
 const start=await fetch(base+'/auth/login',{redirect:'manual'});expect(start.status).toBe(303);
 const target=new URL(start.headers.get('location')!);nonce=target.searchParams.get('nonce')!;challenge=target.searchParams.get('code_challenge')!;
 const callback=base+'/auth/callback?code=synthetic-code&state='+target.searchParams.get('state');
 return {base,callback,cookie:cookieOf(start),pkce:()=>pkceVerified};
}
it('OIDC runs real discovery, PKCE code exchange and signed ID-token validation, with single-use state',async()=>{
 const flow=await oidcHarness();const result=await fetch(flow.callback,{headers:{cookie:flow.cookie},redirect:'manual'});
 expect(result.status).toBe(303);expect(flow.pkce()).toBe(true);
 expect((await fetch(flow.base+'/api/stats',{headers:{cookie:cookieOf(result)}})).status).toBe(200);
 expect((await fetch(flow.callback,{headers:{cookie:flow.cookie},redirect:'manual'})).status).toBe(400);
});
for(const variant of ['state','nonce','issuer','audience','expired','signature'])it(`OIDC rejects invalid ${variant}`,async()=>{
 const flow=await oidcHarness(variant);const callback=variant==='state'?flow.callback+'wrong':flow.callback;
 const result=await fetch(callback,{headers:{cookie:flow.cookie},redirect:'manual'});
 expect(result.status).toBe(401);expect(result.headers.getSetCookie().some(x=>x.startsWith('tm_web_session='))).toBe(false);
});

it('rejects malformed and cross-scheme logout origins without revoking the session', async () => {
  const base = await harness({...baseConfig(), authMode:'trusted-proxy', proxyMode:'external'});
  const cookie = cookieOf(await fetch(base));
  for (const origin of ['invalid', base.replace('http:', 'https:')]) {
    expect((await fetch(base+'/auth/logout', {method:'POST', headers:{cookie, origin}})).status).toBe(403);
    expect((await fetch(base+'/api/stats', {headers:{cookie}})).status).toBe(200);
  }
});
