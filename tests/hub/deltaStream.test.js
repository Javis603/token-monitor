'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHub } = require('../../src/hub/server');
const { createStatsStreamReceiver } = require('../../src/shared/hubProtocol');
const { createSseBlockReader, parseSseBlock } = require('../../src/electron/sseEventReader');

const json = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(setImmediate);
async function waitFor(check) {
  for (let i=0;i<200;i++) { if(check())return; await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.fail('SSE timeout');
}
function fakeState() {
  const data=new Map();
  return { storage: {async get(key){return data.get(key);}, async put(key,value){data.set(key,json(value));}, async delete(key){data.delete(key);}, async list({prefix}={}){return new Map([...data].filter(([key])=>!prefix||key.startsWith(prefix)));}} };
}
async function runtime(kind, t) {
  if(kind==='Node'){
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tm-delta-e2e-'));
    const hub=createHub({port:0,host:'127.0.0.1',secret:'shh',broadcastDelayMs:0,dataFile:path.join(directory,'data.json'),logger:{error(){}}});
    await hub.start();
    const url=`http://127.0.0.1:${hub.server.address().port}`;
    t.after(async()=>{await hub.stop();fs.rmSync(directory,{recursive:true});});
    return {async open(version){return fetch(url+'/api/stats/stream',{headers:{authorization:'Bearer shh','x-token-monitor-stream':version}});},
      async ingest(record){hub.ingest(record);await new Promise(resolve=>setTimeout(resolve,15));},
      async stats(){return hub.getStats();},
      observe(listener){return hub.onStats(listener);},
      async delete(id){hub.deleteDevice(id);},
      async subscriptions(){hub.setSubscriptions([], '');}
    };
  }
  const worker=await import(pathToFileURL(path.resolve(__dirname,'../../worker/src/index.js')).href);
  const hub=new worker.HubDO(fakeState(),{TOKEN_MONITOR_SECRET:'shh',STALE_AFTER_MS:'600000'});
  t.after(()=>{for(const client of [...hub.sseClients])hub.dropClient(client);});
  return {async open(version){return hub.fetch(new Request('https://hub/api/stats/stream',{headers:{authorization:'Bearer shh','x-token-monitor-stream':version}}));},
    async ingest(record){await hub.fetch(new Request('https://hub/api/ingest',{method:'POST',headers:{authorization:'Bearer shh','content-type':'application/json','x-token-monitor-response':'minimal'},body:JSON.stringify(record)}));await hub.flushBroadcast();},
    async stats(){return hub.statsWithSubscriptionVersion();},
    async delete(id){await hub.fetch(new Request('https://hub/api/devices/'+id,{method:'DELETE',headers:{authorization:'Bearer shh'}}));await hub.broadcastTail;},
    async subscriptions(){await hub.fetch(new Request('https://hub/api/subscriptions',{method:'PUT',headers:{authorization:'Bearer shh','content-type':'application/json'},body:JSON.stringify({subscriptions:[],baseUpdatedAt:''})}));await hub.broadcastTail;}
  };
}
function record(tokens=1) {
  const at=new Date().toISOString();
  return {deviceId:'a',updatedAt:at,today:{totalTokens:tokens,sessions:Object.fromEntries(Array.from({length:100},(_,i)=>['s'+i,{sessionId:'s'+i,client:'codex',totalTokens:i?1:tokens,lastUsedAt:i?`${at.slice(0,10)}T00:00:00.000Z`:at,turnEnded:false}]))}};
}
function collect(response,t){
  const reader=response.body.getReader();t.after(()=>reader.cancel().catch(()=>{}));
  const decoder=new TextDecoder();const blocks=createSseBlockReader();const receiver=createStatsStreamReceiver();
  const results={events:[],snapshots:[]};
  const pump=(async()=>{for(;;){const {value,done}=await reader.read();if(done)return;for(const block of blocks.push(decoder.decode(value,{stream:true}))){const event=parseSseBlock(block);if(!event)continue;results.events.push(event);results.snapshots.push(receiver.receive(event.event,event.data));}}})();
  const settled=pump.catch(error=>{results.error=error;});
  t.after(async()=>{await settled;if(results.error)throw results.error;});
  return results;
}
for(const kind of ['Node','Worker']){
  test(`${kind} v4 active updates, reconnect, deletions and subscriptions reconstruct the v3 snapshot`,async t=>{
    const hub=await runtime(kind,t);await hub.ingest(record());
    const v4=collect(await hub.open('4'),t);const v3=collect(await hub.open('3'),t);
    await waitFor(()=>v4.events.length===1&&v3.events.length===1);
    // The first connection starts with the shared revision; later peers bootstrap.
    await hub.ingest(record(2));await waitFor(()=>v4.events.length===2&&v3.events.length===2);
    assert.equal(v4.events[1].event,'delta');
    await hub.ingest(record(3));await waitFor(()=>v4.events.length===3&&v3.events.length===3);
    assert.equal(v4.events[2].event,'delta');
    assert.deepEqual(json(v4.snapshots.at(-1)),json(v3.snapshots.at(-1)));
    const reconnected=collect(await hub.open('4'),t);await waitFor(()=>reconnected.events.length===1);
    await hub.ingest(record(4));await waitFor(()=>v4.events.length===4&&reconnected.events.length===2&&v3.events.length===4);
    assert.equal(v4.events.at(-1).event,'delta');assert.equal(reconnected.events.at(-1).event,'stats');
    assert.deepEqual(json(reconnected.snapshots.at(-1)),json(v4.snapshots.at(-1)));
    await hub.subscriptions();await waitFor(()=>v4.events.length===5&&v3.events.length===5&&reconnected.events.length===3);
    assert.equal(v4.events.at(-1).event,'stats');assert.equal(v4.events.at(-1).data.reason,'subscriptions');
    await hub.delete('a');await waitFor(()=>v4.events.length===6&&v3.events.length===6);
    assert.equal(v4.events.at(-1).event,'stats');assert.deepEqual(v4.snapshots.at(-1).devices,[]);
    assert.deepEqual(json(v4.snapshots.at(-1)),json(v3.snapshots.at(-1)));
  });
}

test('Worker bounds unread writes, skips heartbeat backlog, and recovers with a full latest snapshot',async t=>{
  const worker=await import(pathToFileURL(path.resolve(__dirname,'../../worker/src/index.js')).href);
  const hub=new worker.HubDO(fakeState(),{TOKEN_MONITOR_SECRET:'shh'});
  let latest=record(1);const snapshot=n=>({periods:{today:{totalTokens:n}},devices:[],note:'long '.repeat(1000)});
  hub.statsWithSubscriptionVersion=async()=>snapshot(latest.today.totalTokens);
  let release;const slowWrites=[];const fastWrites=[];
  const slow={deltaEvents:true,freshnessEvents:true,streamRevision:null,writer:{write(chunk){slowWrites.push(new TextDecoder().decode(chunk));return new Promise(resolve=>{release=resolve;});},abort(){}}};
  const fast={deltaEvents:true,freshnessEvents:true,streamRevision:null,writer:{write(chunk){fastWrites.push(new TextDecoder().decode(chunk));return Promise.resolve();},abort(){}}};
  hub.sseClients.add(slow);hub.sseClients.add(fast);
  t.after(()=>{for(const c of [...hub.sseClients])hub.dropClient(c);release?.();});
  await hub.flushBroadcast();await flush();
  for(let n=2;n<=30;n++){latest=record(n);await hub.flushBroadcast();await flush();}
  assert.equal(slowWrites.length,1);assert.equal(slow.needsSnapshot,true);
  assert.equal(fastWrites.length,30);assert.match(fastWrites.at(-1),/^event: delta/);
  release();await flush();await flush();
  assert.equal(slowWrites.length,2);assert.match(slowWrites[1],/^event: stats/);
  assert.equal(JSON.parse(slowWrites[1].split('data: ')[1]).stats.periods.today.totalTokens,30);
  release();await flush();latest=record(31);await hub.flushBroadcast();await flush();
  assert.equal(slowWrites.length,3);assert.match(slowWrites[2],/^event: stats/);
  release();await flush();latest=record(32);await hub.flushBroadcast();await flush();
  assert.match(slowWrites[3],/^event: delta/);
  const r=createStatsStreamReceiver();let decoded;
  for(const frame of slowWrites){const e=parseSseBlock(frame);decoded=r.receive(e.event,e.data);}
  assert.equal(decoded.periods.today.totalTokens,32);
});

test('Worker serializes concurrent broadcasts before advancing revision baselines', async t => {
  const worker=await import(pathToFileURL(path.resolve(__dirname,'../../worker/src/index.js')).href);
  const hub=new worker.HubDO(fakeState(),{TOKEN_MONITOR_SECRET:'shh'});
  const frames=[];let release;let reads=0;
  hub.statsWithSubscriptionVersion=async()=>{
    const n=++reads;if(n===1)await new Promise(resolve=>{release=resolve;});
    return {n,devices:[],unchanged:'large '.repeat(1000)};
  };
  const client={deltaEvents:true,streamRevision:null,writer:{write(chunk){frames.push(parseSseBlock(new TextDecoder().decode(chunk)));return Promise.resolve();},abort(){}}};
  hub.sseClients.add(client);t.after(()=>hub.dropClient(client));
  const first=hub.flushBroadcast();await flush();
  const second=hub.flushBroadcast();await flush();assert.equal(reads,1);
  release();await Promise.all([first,second]);await flush();
  assert.equal(frames.length,2);assert.equal(frames[0].event,'stats');assert.equal(frames[1].event,'delta');
  const receiver=createStatsStreamReceiver();
  receiver.receive(frames[0].event,frames[0].data);
  assert.equal(receiver.receive(frames[1].event,frames[1].data).n,2);
});

for (const forceFull of [false, true]) test(`Worker coalesces a slow read backlog and preserves full snapshot demand: ${forceFull}`, async t => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const hub = new worker.HubDO(fakeState(), { TOKEN_MONITOR_SECRET: 'shh' });
  let latest = 1, reads = 0, release;
  const frames = [];
  hub.statsWithSubscriptionVersion = async () => {
    const snapshot = { n: latest, devices: [], unchanged: 'large '.repeat(1000) };
    if (++reads === 1) await new Promise(resolve => { release = resolve; });
    return snapshot;
  };
  const client = { deltaEvents: true, streamRevision: null, writer: {
    write(chunk) { frames.push(parseSseBlock(new TextDecoder().decode(chunk))); return Promise.resolve(); }, close() {}
  } };
  hub.sseClients.add(client); t.after(() => hub.dropClient(client));
  const first = hub.flushBroadcast(); await flush();
  const updates = [];
  for (let n = 2; n <= 50; n++) {
    latest = n;
    updates.push(forceFull && n === 20 ? hub.broadcast('subscriptions') : hub.flushBroadcast());
  }
  assert.equal(reads, 1);
  release(); await Promise.all([first, ...updates]); await flush();
  assert.equal(reads, 2, 'only the active read and one latest pending batch should run');
  assert.equal(frames.length, 2);
  assert.equal(frames[1].event, forceFull ? 'stats' : 'delta');
  if (forceFull) assert.equal(frames[1].data.reason, 'subscriptions');
  const receiver = createStatsStreamReceiver();
  receiver.receive(frames[0].event, frames[0].data);
  assert.equal(receiver.receive(frames[1].event, frames[1].data).n, 50);
});

test('a failed Worker read does not strand the coalesced pending broadcast', async t => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const hub = new worker.HubDO(fakeState(), { TOKEN_MONITOR_SECRET: 'shh' });
  let fail, reads = 0;
  const frames = [];
  hub.statsWithSubscriptionVersion = async () => {
    if (++reads === 1) await new Promise((_, reject) => { fail = reject; });
    return { n: reads, devices: [] };
  };
  const client = { writer: { write(chunk) { frames.push(parseSseBlock(new TextDecoder().decode(chunk))); return Promise.resolve(); }, close() {} } };
  hub.sseClients.add(client); t.after(() => hub.dropClient(client));
  const first = hub.flushBroadcast(); await flush();
  const rejected = assert.rejects(first, /read fixture/);
  const second = hub.flushBroadcast();
  fail(new Error('read fixture')); await rejected; await second;
  assert.equal(frames.length, 1); assert.equal(frames[0].data.stats.n, 2);
  await hub.flushBroadcast(); assert.equal(reads, 3);
});

test('Worker heartbeat does not queue behind a blocked initial write or outlive a dropped client',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const worker=await import(pathToFileURL(path.resolve(__dirname,'../../worker/src/index.js')).href);
  const hub=new worker.HubDO(fakeState(),{TOKEN_MONITOR_SECRET:'shh'});
  let writes=0;let release;let aborted=0;
  const client={writer:{write(){writes++;return new Promise(resolve=>{release=resolve;});},close(){aborted++;return Promise.reject(new Error('already closed'));}}};
  hub.sseClients.add(client);hub.writeEncoded(client,new Uint8Array([1]));hub.ensureHeartbeat();
  t.mock.timers.tick(120000);assert.equal(writes,1);
  hub.dropClient(client);release();await flush();t.mock.timers.tick(120000);
  assert.equal(writes,1);assert.equal(aborted,1);assert.equal(hub.heartbeatTimer,null);
});


test('Node host-mode listener overlays cannot alter the SSE delta baseline', async t => {
  const hub = await runtime('Node', t);
  await hub.ingest(record());
  const stream = collect(await hub.open('4'), t);
  await waitFor(() => stream.events.length === 1);
  const unsubscribe = hub.observe(stats => {
    stats.localPresentation = true;
    if (stats.devices[0]) stats.devices[0].clientHealth = { observedAt: 'local-only' };
    stats.periods.today.totalTokens = 999999;
  });
  t.after(unsubscribe);
  await hub.subscriptions();
  await waitFor(() => stream.events.length === 2);
  await hub.ingest(record(2));
  await waitFor(() => stream.events.length === 3);
  assert.equal(stream.events.at(-1).event, 'delta');
  assert.equal(stream.snapshots.at(-1).periods.today.totalTokens, 2);
  assert.equal(stream.snapshots.at(-1).localPresentation, undefined);
});


test('Worker discards an in-flight broadcast after every subscriber reconnects', async () => {
  const worker = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const hub = new worker.HubDO(fakeState(), { TOKEN_MONITOR_SECRET: 'shh' });
  const frames = [];
  const client = () => ({ deltaEvents: true, streamRevision: null, writer: {
    write(chunk) { frames.push(new TextDecoder().decode(chunk)); return Promise.resolve(); }, close() {}
  } });
  let release;
  hub.statsWithSubscriptionVersion = () => new Promise(resolve => { release = resolve; });
  const old = client(); hub.sseClients.add(old);
  const pending = hub.flushBroadcast(); await flush();
  hub.dropClient(old);
  const next = client(); hub.sseClients.add(next);
  release({ devices: [], marker: 'obsolete' }); await pending;
  assert.equal(frames.length, 0);
  hub.statsWithSubscriptionVersion = async () => ({ devices: [], marker: 'current' });
  await hub.flushBroadcast(); await flush();
  assert.equal(JSON.parse(frames[0].split('data: ')[1]).stats.marker, 'current');
  hub.dropClient(next);
});
