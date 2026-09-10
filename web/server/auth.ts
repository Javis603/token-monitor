import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as oidc from 'openid-client';
import type { GatewayConfig } from './config.js';

const COOKIE='tm_web_session';
const FLOW_COOKIE='tm_oidc_flow';
const TTL=8*60*60*1000;
function equal(a:string | Buffer,b:string) {
  // Compare credential bytes directly; this is not password-hash storage.
  const supplied=Buffer.from(a);const expected=Buffer.from(b);
  return supplied.length===expected.length && timingSafeEqual(supplied,expected);
}
function cookie(request:IncomingMessage,name:string) {
  return request.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
}
export function localRequest(request:IncomingMessage) {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')) return false;
  try {return ['localhost','127.0.0.1','[::1]'].includes(new URL('http://'+request.headers.host).hostname);}catch{return false;}
}
export function createAuth(config:GatewayConfig, discover=()=>oidc.discovery(new URL(config.oidcIssuer!),config.oidcClientId!,config.oidcClientSecret,config.oidcClientSecret ? oidc.ClientSecretPost(config.oidcClientSecret) : oidc.None(),{timeout:10})) {
  const mode=config.authMode === 'proxy' ? 'trusted-proxy' : config.authMode || 'local';
  const sessions=new Map<string,number>();
  const streams=new Map<string,Set<ServerResponse>>();
  const flows=new Map<string,{expires:number;state:string;nonce:string;verifier:string}>();
  const failures=new Map<string,{until:number;count:number}>();
  const trusted=new BlockList();
  for(const entry of config.trustedProxyPeers || ['127.0.0.1','::1']) {
    const [address,prefix]=entry.split('/');const type=isIP(address)===4?'ipv4':'ipv6';
    if(prefix!==undefined) trusted.addSubnet(address,Number(prefix),type);else trusted.addAddress(address,type);
  }
  const secure=config.publicOrigin ? new URL(config.publicOrigin).protocol==='https:' : mode!=='local';
  function setCookie(response:ServerResponse,name:string,value:string,maxAge:number) {
    const previous=response.getHeader('set-cookie');
    const values=typeof previous==='string'?[previous]:Array.isArray(previous)?previous.map(String):[];
    response.setHeader('set-cookie',[...values,`${name}=${value}; Path=/; HttpOnly; SameSite=Lax;${secure?' Secure;':''} Max-Age=${maxAge}`]);
  }
  function revoke(id:string) {
    sessions.delete(id);
    for(const response of streams.get(id)||[])response.destroy();
    streams.delete(id);
  }
  function bindStream(request:IncomingMessage,response:ServerResponse) {
    const id=cookie(request,COOKIE)||'';const expires=sessions.get(id);if(!expires)return;
    const active=streams.get(id)||new Set<ServerResponse>();active.add(response);streams.set(id,active);
    const timer=setTimeout(()=>revoke(id),Math.max(0,expires-Date.now()));timer.unref();
    response.once('close',()=>{clearTimeout(timer);active.delete(response);if(!active.size)streams.delete(id);});
  }
  function prune() {
    const now=Date.now();
    for(const [id,expires] of sessions)if(expires<=now)revoke(id);
    for(const [id,flow] of flows)if(flow.expires<=now)flows.delete(id);
    for(const [id,failure] of failures)if(failure.until<=now)failures.delete(id);
  }
  function hasSession(request:IncomingMessage) {prune();return sessions.has(cookie(request,COOKIE)||'');}
  function issue(request:IncomingMessage,response:ServerResponse) {
    // External auth offload only vouches for these exact protected entry paths.
    // Public assets and SPA fallbacks may return HTML but must not create sessions.
    if(mode==='trusted-proxy' && config.proxyMode==='external'
      && !['/','/index.html'].includes((request.url || '').split('?')[0]))return;
    if(hasSession(request))return;
    if(sessions.size>=10000)throw new Error('session_capacity');
    const id=randomBytes(32).toString('base64url');sessions.set(id,Date.now()+TTL);setCookie(response,COOKIE,id,TTL/1000);
  }
  function peerTrusted(request:IncomingMessage) {
    const address=(request.socket.remoteAddress||'').replace(/^::ffff:/,'');
    return trusted.check(address,isIP(address)===4?'ipv4':'ipv6');
  }
  function proxyIdentity(request:IncomingMessage,shell:boolean) {
    if(config.authMode==='proxy' && !config.trustOidcProxy)return false;
    if(!peerTrusted(request))return false;
    // Explicit auth-offload contract: upstream authenticates the session entry paths.
    if(config.proxyMode==='external')return shell && !!config.publicOrigin && new URL(config.publicOrigin).host===request.headers.host;
    const value=request.headers[config.proxyHeader || 'x-forwarded-user'];
    return typeof value==='string' && value.trim().length>0;
  }
  function basic(request:IncomingMessage) {
    prune();
    if((failures.get(request.socket.remoteAddress || '')?.count || 0)>=20)return false;
    const match=/^Basic ([A-Za-z0-9+/=]+)$/i.exec(request.headers.authorization||'');
    if(!match || !config.basicUsername || !config.basicPassword)return false;
    return equal(Buffer.from(match[1],'base64'),config.basicUsername+':'+config.basicPassword);
  }
  function authorized(request:IncomingMessage,shell:boolean) {
    const header=request.headers.authorization;
    if(header!==undefined && (!shell || mode==='basic')) {
      const bearer=/^Bearer (.+)$/i.exec(header);
      if(bearer)return !shell && equal(bearer[1],config.secret);
      if(mode==='basic')return basic(request);
      return false;
    }
    if(mode==='local')return localRequest(request);
    if(hasSession(request))return true;
    return mode==='trusted-proxy' && proxyIdentity(request,shell);
  }
  function json(response:ServerResponse,status:number,value:object) {
    response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(value));
  }
  function redirect(response:ServerResponse,url:string) {response.writeHead(303,{location:url,'cache-control':'no-store'});response.end();}
  let discovery:Promise<oidc.Configuration>|undefined;
  function client() {return discovery ||= discover().then(value=>{oidc.enableNonRepudiationChecks(value);value.timeout=10;return value;}).catch(error=>{discovery=undefined;throw error;});}
  async function handle(request:IncomingMessage,response:ServerResponse,url:URL):Promise<boolean> {
    prune();
    if(url.pathname==='/auth/signed-out') {
      response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Token Monitor</title><h1>Signed out / 已退出</h1><p>Your Web session has ended. / Web 会话已结束。</p><a href="/">Sign in / 登录</a></html>');return true;
    }
    if(url.pathname==='/auth/logout') {
      if(request.method!=='POST'){json(response,405,{error:'method_not_allowed'});return true;}
      if(!request.headers.origin || new URL(request.headers.origin).host!==request.headers.host){json(response,403,{error:'cross_site_request'});return true;}
      revoke(cookie(request,COOKIE)||'');flows.delete(cookie(request,FLOW_COOKIE)||'');
      setCookie(response,COOKIE,'',0);setCookie(response,FLOW_COOKIE,'',0);json(response,200,{ok:true});return true;
    }
    if(url.pathname==='/auth/session') {
      if(request.method!=='GET'){json(response,405,{error:'method_not_allowed'});return true;}
      json(response,200,{mode,authenticated:authorized(request,false)});return true;
    }
    if(url.pathname==='/auth/callback' && mode==='oidc') {
      if(request.method!=='GET'){json(response,405,{error:'method_not_allowed'});return true;}
      const id=cookie(request,FLOW_COOKIE)||'';const flow=flows.get(id);flows.delete(id);setCookie(response,FLOW_COOKIE,'',0);
      if(!flow){json(response,400,{error:'invalid_login_state'});return true;}
      try {
        const current=new URL('/auth/callback'+url.search,config.publicOrigin);
        const tokens=await oidc.authorizationCodeGrant(await client(),current,{pkceCodeVerifier:flow.verifier,expectedState:flow.state,expectedNonce:flow.nonce,idTokenExpected:true});
        const claims=tokens.claims();
        if(!claims?.sub || (config.oidcSubjects?.length && !config.oidcSubjects.includes(claims.sub)))throw new Error('access_denied');
        issue(request,response);redirect(response,'/');
      }catch{json(response,401,{error:'oidc_login_failed'});}
      return true;
    }
    if(url.pathname==='/auth/login' && mode!=='oidc'){redirect(response,'/');return true;}
    if(url.pathname==='/auth/login' && mode==='oidc') {
      if(request.method!=='GET'){json(response,405,{error:'method_not_allowed'});return true;}
      if(flows.size>=1000){json(response,429,{error:'too_many_logins'});return true;}
      try {
        const previous=cookie(request,FLOW_COOKIE);if(previous)flows.delete(previous);
        const id=randomBytes(32).toString('base64url');const verifier=oidc.randomPKCECodeVerifier();const state=oidc.randomState();const nonce=oidc.randomNonce();
        const target=oidc.buildAuthorizationUrl(await client(),{redirect_uri:new URL('/auth/callback',config.publicOrigin).href,scope:'openid profile',code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',state,nonce});
        flows.set(id,{expires:Date.now()+600000,verifier,state,nonce});setCookie(response,FLOW_COOKIE,id,600);redirect(response,target.href);
      }catch{json(response,503,{error:'oidc_unavailable'});}
      return true;
    }
    return false;
  }
  function deny(request:IncomingMessage,response:ServerResponse,shell:boolean) {
    if(mode==='oidc' && shell){redirect(response,'/auth/login');return;}
    if(mode==='basic') {
      const peer=request.socket.remoteAddress||'';prune();
      const failure=failures.get(peer)||{count:0,until:Date.now()+60000};
      if(failure.count>=20 || failures.size>=10000){response.setHeader('retry-after','60');json(response,429,{error:'too_many_attempts'});return;}
      if(request.headers.authorization)failure.count++;
      failures.set(peer,failure);response.setHeader('www-authenticate','Basic realm="Token Monitor", charset="UTF-8"');
    }
    json(response,401,{error:'unauthorized'});
  }
  return {handle,authorized,issue,deny,bindStream};
}
