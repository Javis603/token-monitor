'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBalance } = require('../../plugins/openai-api-credit/balance.cjs');
const { createBackend, activate } = require('../../plugins/openai-api-credit/backend.cjs');
const sample = () => ({ object: 'credit_summary', total_granted: 124, total_used: 24, total_available: 100, total_paid_available: 0,
  grants: { data: [{ grant_amount: 100, used_amount: 0, effective_at: 1, expires_at: 2000000000 }, { grant_amount: 24, used_amount: 24, effective_at: 1, expires_at: null }] } });
test('real available amount is used instead of plan allowance minus accumulated spend', () => {
  assert.deepEqual(parseBalance(sample(), 100000), { available: 100, granted: 124, used: 24, paidAvailable: 0, currency: 'USD', expiresAt: '2033-05-18T03:33:20.000Z', meterTotal: 100, usableGrants: [{remaining:100, expiresAt:'2033-05-18T03:33:20.000Z'}] });
  const empty = sample(); empty.total_available = 0; assert.equal(parseBalance(empty).available, 0);
  for (const bad of [null, {}, { ...sample(), total_available: '100' }, { ...sample(), total_available: null }, { ...sample(), grants: {} }]) assert.throws(() => parseBalance(bad));
});
test('the meter uses reconciled effective grants, excluding expired, future, scheduled and held grants', () => {
  const body = sample(); body.total_available = 83.25;
  body.grants.data[0].used_amount = 16.75;
  body.grants.data[1].expires_at = 50;
  const extra = { grant_amount: 200, used_amount: 0, effective_at: 1, expires_at: 2000000000 };
  body.grants.data.push({ ...extra, effective_at: 200 }, { ...extra, is_scheduled: true }, { ...extra, is_held_for_prepaid_transition: true });
  const balance = parseBalance(body, 100000);
  assert.equal(balance.available, 83.25); assert.equal(balance.meterTotal, 100);
  assert.notEqual(balance.meterTotal, body.total_granted);
  body.grants.data[0].used_amount = 100; body.total_available = 0;
  assert.equal(parseBalance(body, 100000).meterTotal, null, 'no usable grants leaves measured zero without a historical denominator');
});
test('the bar excludes fully spent grants but preserves spending within grants that still have credit', () => {
  const body = sample();
  body.grants.data.push({ grant_amount: 50, used_amount: 10, effective_at: 1, expires_at: null });
  body.total_available = 140; body.total_granted = 174; body.total_used = 34;
  assert.equal(parseBalance(body, 100000).meterTotal, 150);
  body.grants.data[0].used_amount = 100; body.total_available = 40; body.total_used = 134;
  assert.equal(parseBalance(body, 100000).meterTotal, 50);
  assert.equal(parseBalance(body, 100000).available, 40);
});
test('unreconciled and paid balances keep their amount without inventing a meter', () => {
  for (const mutate of [body => { body.total_available = 91; }, body => { body.total_paid_available = 10; },
    body => { body.grants.data = []; }, body => { body.grants.data[0].used_amount = 101; },
    body => { for (const grant of body.grants.data) grant.expires_at = 50; }]) {
    const body = sample(); mutate(body);
    const balance = parseBalance(body, 100000);
    assert.equal(balance.available, body.total_available); assert.equal(balance.meterTotal, null);
  }
});
function fixture() {
  const state = { locale: 'en', mode: 'bar', configured: true, credentials: { sessionBearer: 'synthetic-session', organization: 'org-synthetic' }, response: { status: 200, body: JSON.stringify(sample()) }, calls: [] };
  const body=sample();body.total_available=83.25;body.grants.data[0].used_amount=16.75;body.grants.data[1].expires_at=50;state.response.body=JSON.stringify(body);
  state.host = { async call(method, args) {
    state.calls.push({method,args});
    if(method==='credentials.status')return {configured:state.configured};
    if(method==='credentials.read')return state.credentials;
    if(method==='app.settings')return {locale:state.locale};
    if(method==='settings.get')return {values:{displayMode:state.mode}};
    if(method==='network.request')return state.response;
    throw Error('Unexpected host operation');
  }};
  return state;
}
test('manual credentials use the host transport and return only normalized native quota data', async()=>{
  const state=fixture(),backend=createBackend({host:state.host},{now:()=>100000});
  const reading=await backend.call('limits.collect',{moduleId:'credits'});
  assert.deepEqual(reading,{status:'ok',windows:[{kind:'billing',metric:'credits',label:'API credits',creditsDisplay:'percent',remaining:83.25,limit:100,currency:'USD',boundaryKind:'expiry',resetsAt:'2033-05-18T03:33:20.000Z'}]});
  const request=state.calls.find(call=>call.method==='network.request').args;
  assert.equal(request.url,'https://api.openai.com/v1/dashboard/billing/credit_grants');
  assert.equal(request.moduleId,'credits');assert.equal(request.method,'GET');assert.equal(request.timeoutMs,15000);
  assert.equal(request.headers.Authorization,'Bearer '+state.credentials.sessionBearer);assert.equal(request.headers['OpenAI-Organization'],state.credentials.organization);
  state.mode='balance';assert.equal((await backend.call('limits.collect',{moduleId:'credits'})).windows[0].creditsDisplay,'balance');
  state.credentials.sessionBearer='Bearer synthetic-session';
  await backend.call('limits.collect',{moduleId:'credits'});assert.equal(state.calls.at(-1).args.headers.Authorization,'Bearer synthetic-session');
});
test('activation is passive and unsupported operations do not access credentials or open login',async()=>{
  const state=fixture(),backend=await activate({host:state.host});
  assert.deepEqual(state.calls,[]);await assert.rejects(backend.call('connect',{moduleId:'credits'}));await assert.rejects(backend.call('limits.collect',{moduleId:'other'}));assert.deepEqual(state.calls,[]);
});
test('missing credentials never trigger a network request; malformed headers are rejected locally',async()=>{
  const state=fixture();state.configured=false;
  assert.deepEqual(await createBackend({host:state.host}).call('limits.collect',{moduleId:'credits'}),{status:'notConfigured',windows:[]});assert.equal(state.calls.length,1);
  for(const credentials of [{sessionBearer:'bad token',organization:'org'},{sessionBearer:'synthetic',organization:'org\r\nX-Test: invalid'},{sessionBearer:'',organization:'org'}]){
    const state=fixture();state.credentials=credentials;
    assert.deepEqual(await createBackend({host:state.host}).call('limits.collect',{moduleId:'credits'}),{status:'error',windows:[]});assert.ok(!state.calls.some(call=>call.method==='network.request'));
  }
});
test('provider and transport failures report native states without exposing their response or errors',async()=>{
  for(const [status,expected] of [[401,'unauthorized'],[403,'unauthorized'],[429,'rateLimited'],[500,'unavailable'],[200,'error']]){
    const state=fixture();state.response={status,body:'not JSON'};
    assert.deepEqual(await createBackend({host:state.host}).call('limits.collect',{moduleId:'credits'}),{status:expected,windows:[]});
  }
  const backend=createBackend({host:{call:async()=>{throw Error('private transport cause');}}});
  assert.deepEqual(await backend.call('limits.collect',{moduleId:'credits'}),{status:'unavailable',windows:[]});
});

test('explicit validation binds credential reads to the saved revision and returns only service status',async()=>{
  const state=fixture(),backend=createBackend({host:state.host},{now:()=>100000});
  assert.deepEqual(await backend.call('credentials.validate',{moduleId:'credits',revision:7}),{status:'valid'});
  assert.deepEqual(state.calls.find(call=>call.method==='credentials.read').args,{moduleId:'credits',expectedRevision:7});
  assert.equal(state.calls.find(call=>call.method==='network.request').args.requestId,'credential-check');
  assert.ok(!state.calls.some(call=>call.method==='settings.get'));
  for(const [status,body,expected] of [[401,'private','rejected'],[403,'private','rejected'],[429,'private','unavailable'],[500,'private','unavailable'],[200,'invalid','unavailable']]){
    state.response={status,body};
    assert.deepEqual(await backend.call('credentials.validate',{moduleId:'credits',revision:7}),{status:expected});
  }
  await assert.rejects(backend.call('credentials.validate',{moduleId:'credits'}));
  const failing=createBackend({host:{call:async()=>{throw Error('credentials-conflict');}}});
  assert.deepEqual(await failing.call('credentials.validate',{moduleId:'credits',revision:7}),{status:'unavailable'});
});

test('batch tooltip appears only for multiple usable grants with distinct expiry dates',async()=>{
  async function reading(body) { const state=fixture();state.response.body=JSON.stringify(body);return (await createBackend({host:state.host},{now:()=>100000}).call('limits.collect',{moduleId:'credits'})).windows[0]; }
  const body=sample();
  assert.equal((await reading(body)).infoRows,undefined,'single grant has no redundant tooltip');
  body.grants.data.push({grant_amount:50,used_amount:10,effective_at:1,expires_at:2000000000});body.total_available=140;
  assert.equal((await reading(body)).infoRows,undefined,'same expiry has no redundant tooltip');
  body.grants.data[2].expires_at=1900000000;
  const window=await reading(body);
  assert.deepEqual(window.infoRows,[{label:'Expires 2030-03-17 17:46 UTC',value:{amount:40,currency:'USD'}},{label:'Expires 2033-05-18 03:33 UTC',value:{amount:100,currency:'USD'}}]);
  assert.equal(window.remaining,140);assert.equal(window.limit,150);
  body.total_paid_available=10;assert.equal((await reading(body)).infoRows,undefined,'unreconciled pool has no misleading breakdown');
  body.total_paid_available=0;body.grants.data[2].expires_at=null;
  assert.equal((await reading(body)).infoRows[1].label,'No expiry reported');
  for(let i=0;i<12;i++){body.grants.data.push({grant_amount:1,used_amount:0,effective_at:1,expires_at:null});body.total_available++;}
  assert.equal((await reading(body)).infoRows,undefined,'never truncate an oversized breakdown');
});

test('batch details follow the App locale and retain the same money and expiry semantics', async () => {
  const { messages } = await import('../../plugins/openai-api-credit/i18n.mjs');
  const state = fixture(), body = sample();
  body.grants.data.push({ grant_amount: 50, used_amount: 10, effective_at: 1, expires_at: null });
  body.total_available = 140; state.response.body = JSON.stringify(body);
  const backend = createBackend({ host: state.host }, { now: () => 100000 });
  for (const locale of Object.keys(messages)) {
    state.locale = locale;
    const window = (await backend.call('limits.collect', { moduleId: 'credits' })).windows[0];
    assert.equal(window.label, 'API credits');
    assert.equal(window.remaining, 140); assert.equal(window.limit, 150);
    assert.equal(window.infoRows[0].label, messages[locale].expires.replace('{time}', '2033-05-18 03:33'));
    assert.equal(window.infoRows[1].label, messages[locale].noExpiry);
    assert.deepEqual(window.infoRows.map(row => row.value), [{ amount: 100, currency: 'USD' }, { amount: 40, currency: 'USD' }]);
  }
});
