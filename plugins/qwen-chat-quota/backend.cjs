'use strict';
const path=require('node:path');
const os=require('node:os');
const {readSession}=require('./session.cjs');
const ENDPOINT='https://sg-entitlement.qwen.com/api/entitlement/agent/usage';
const MAX_BODY=128*1024;
function profileDirectory({platform=process.platform,env=process.env,home=os.homedir()}={}) {
  const root=platform==='win32'
    ? env.APPDATA||path.join(home,'AppData','Roaming')
    : platform==='darwin' ? path.join(home,'Library','Application Support')
      : env.XDG_CONFIG_HOME||path.join(home,'.config');
  return path.join(root,'Qwen','Local Storage','leveldb');
}
async function jsonBody(response) {
  if(!/\bjson\b/i.test(response.headers.get('content-type')||''))throw Error('Unsupported response');
  if(Number(response.headers.get('content-length'))>MAX_BODY)throw Error('Response too large');
  const reader=response.body?.getReader();if(!reader)throw Error('Empty response');
  let count=0;const chunks=[];
  try {while(true){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>MAX_BODY)throw Error('Response too large');chunks.push(Buffer.from(value));}}
  finally {await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const note=label=>[{label}];
async function collect(deps={}) {
  const now=(deps.now||Date.now)();
  const base={updatedAt:new Date(now).toISOString(),windows:[]};
  try {
    const dir=profileDirectory();
    const session=(deps.readSession||readSession)(dir);
    if(!session)return {...base,status:'notConfigured',notes:note('Open the Qwen desktop app and sign in.')};
    if(session.expiresAt<=now)return {...base,status:'unauthorized',notes:note('Open Qwen to refresh its signed-in session, then refresh these limits.')};
    const url=new URL(ENDPOINT);
    for(const [k,v] of Object.entries({biz_id:'ai_qwen',chat_client:'h5',device:'pc',fr:'pc',pr:'qwen-i18n',la:'en-US',tz:Intl.DateTimeFormat().resolvedOptions().timeZone,wv:'0.3.42'}))url.searchParams.set(k,v);
    const response=await (deps.fetch||fetch)(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{
      Authorization:`Bearer ${session.token}`,Accept:'application/json',Origin:'https://chat.qwen.ai'
    }});
    if([401,403].includes(response.status))return {...base,status:'unauthorized',notes:note('Open Qwen to refresh its signed-in session.')};
    if(response.status===429)return {...base,status:'rateLimited',notes:note('Qwen temporarily limited quota checks. Try again later.')};
    if(!response.ok)return {...base,status:'unavailable',notes:note('The Qwen quota service is temporarily unavailable.')};
    const payload=await jsonBody(response);
    if(payload.httpCode===401||payload.httpCode===403||payload.errorCode==='NOT_LOGIN')return {...base,status:'unauthorized',notes:note('Open Qwen to refresh its signed-in session.')};
    const data=payload.data;
    if(payload.success!==true||payload.httpCode!==200||!data||typeof data.remainingPercent!=='number'||!Number.isFinite(data.remainingPercent)||data.remainingPercent<0||data.remainingPercent>100||typeof data.resetAt!=='number'||!Number.isFinite(data.resetAt)||data.resetAt<=now||!Number.isFinite(new Date(data.resetAt).getTime()))throw Error('Invalid quota');
    const plan={plus:'Plus',pro:'Pro',lite:'Lite',go:'Go',free:'Free'}[String(data.memberType||'').toLowerCase()]||'';
    return {...base,status:'ok',plan,windows:[{kind:'weekly',label:'Weekly',usedPercent:100-data.remainingPercent,resetsAt:new Date(data.resetAt).toISOString(),windowMinutes:10080}],
      notes:note('Shared: Qwen Code, Agent, Coder, Deep Research. Ordinary chats excluded.')};
  } catch {
    return {...base,status:'unavailable',notes:note('Unable to read Qwen quota. Open Qwen and refresh. No estimate is substituted.')};
  }
}
function createBackend({host},deps={}) {
  // Use the App's proxy-aware transport; native visibility owns request cancellation.
  const hostFetch=async(url,options)=>{
    const reply=await host.call('network.request',{
      moduleId:'subscription',requestId:'weekly-quota',url:String(url),
      method:'GET',timeoutMs:15000,headers:options.headers
    });
    return new Response(reply.body,{status:reply.status,headers:reply.headers});
  };
  return {async call(method,args){
    if(method!=='limits.collect'||args?.moduleId!=='subscription')throw Error('Unsupported Qwen plugin operation');
    return collect({...deps,fetch:hostFetch});
  }};
}
async function activate(context) {return createBackend(context);}
module.exports={activate,collect,createBackend,profileDirectory};
