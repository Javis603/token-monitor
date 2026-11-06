#!/usr/bin/env node
'use strict';

// Local replay of the same active-session updates through v3 and v4 encoders.
// No network, credentials, uploads or changes to the user's runtime.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const nodeProtocol = require('../src/shared/hubProtocol');
const workerProtocol = require('../worker/src/shared/hubProtocol');
const nodeUsage = require('../src/shared/usage');
const workerUsage = require('../worker/src/shared/usage');
const now = Date.parse('2026-10-28T10:00:00.000Z');
const updates = 30;
const iso = round => new Date(now + round * 10000).toISOString();
const wire = value => JSON.parse(JSON.stringify(value));
function fixture(usage) {
  const records = Array.from({length:4}, (_,d) => ({deviceId:`device-${d}`, updatedAt:iso(0), receivedAt:iso(0),
    periods:Object.fromEntries(['today','month','allTime'].map(period => [period, {totalTokens:500000,
      sessions:Object.fromEntries(Array.from({length:500},(_,i)=>[`codex:d${d}-s${i}`,{
        sessionId:`d${d}-s${i}`, client:'codex', totalTokens:1000,inputTokens:700,outputTokens:300,costUsd:0.01,lastUsedAt:iso(0),turnEnded:true,
        ...(i<2?{liveActivity:{state:'running',observedAt:iso(0)}}:{})
      }]))}]))}));
  return wire({...usage.aggregateDevices(records,600000,now),staleAfterMs:600000});
}
function advance(previous, round, scenario) {
  const stats=wire(previous);
  stats.updatedAt=iso(round);
  for(const device of stats.devices){device.updatedAt=iso(round);device.receivedAt=iso(round);}
  function update(periods){for(const period of Object.values(periods)){
    for(const session of Object.values(period.sessions||{}))if(session.liveActivity)session.liveActivity.observedAt=iso(round);
    const session=Object.values(period.sessions||{}).find(row=>row.liveActivity);
    if((scenario==='active'||scenario==='late-join')||(scenario==='mixed'&&round%6===0)){
      session.totalTokens++; session.outputTokens++; session.contextTokens = 100 + round; session.lastUsedAt = iso(round); period.totalTokens++;
    }
  }}
  update(stats.periods);for(const device of stats.devices)update(device.periods);
  return stats;
}
const results=[];
for(const [runtime,protocol,usage]of [['Node Hub',nodeProtocol,nodeUsage],['Worker',workerProtocol,workerUsage]]){
  for(const scenario of ['renewal','mixed','active','late-join']){
    let previous=fixture(usage),key=protocol.hubStatsContentKey(previous);
    const client={deltaEvents:true,streamRevision:scenario==='late-join'?null:0};const receiver=protocol.createStatsStreamReceiver();
    receiver.receive('snapshot',{stats:wire(previous),...(scenario==='late-join'?{}:{revision:0})});
    const row={runtime,scenario,updates,beforeBytes:0,afterBytes:0,fullFrames:0,deltaFrames:0,freshnessFrames:0,encodeBeforeMs:0,encodeAfterMs:0,applyAfterMs:0};
    row.snapshotBytes=Buffer.byteLength(protocol.encodeSseEvent('snapshot',{type:'stats',reason:'snapshot',stats:previous,at:iso(0)}));
    for(let round=1;round<=updates;round++){
      const current=advance(previous,round,scenario);
      const input={reason:'ingest',stats:current,at:iso(round),lastContentKey:key};
      let start=performance.now();const beforeFrames=protocol.prepareSseFanout({...input,hasFreshnessClients:true});
      const before=protocol.sseFrameForClient(beforeFrames,{freshnessEvents:true});row.encodeBeforeMs+=performance.now()-start;
      start=performance.now();const afterFrames=protocol.prepareSseFanout({...input,hasDeltaClients:true,previousStats:previous,revision:round});
      const after=protocol.sseFrameForClient(afterFrames,client);row.encodeAfterMs+=performance.now()-start;
      const event=JSON.parse(after.split('data: ')[1]);start=performance.now();const reconstructed=receiver.receive(event.type,event);row.applyAfterMs+=performance.now()-start;
      assert.deepEqual(reconstructed,current,`${runtime}/${scenario}/${round}`);
      row.beforeBytes+=Buffer.byteLength(before);row.afterBytes+=Buffer.byteLength(after);
      row.fullFrames+=Number(event.type==='stats');row.deltaFrames+=Number(event.type==='delta');row.freshnessFrames+=Number(event.type==='freshness');
      client.streamRevision=round;key=afterFrames.contentKey;previous=current;
    }
    row.savedPercent=Number(((1-row.afterBytes/row.beforeBytes)*100).toFixed(3));
    for(const key of ['encodeBeforeMs','encodeAfterMs','applyAfterMs'])row[key]=Number(row[key].toFixed(2));
    results.push(row);
  }
}
for(let i=0;i<4;i++)for(const key of ['beforeBytes','afterBytes','fullFrames','deltaFrames'])assert.equal(results[i][key],results[i+4][key]);
console.log(JSON.stringify({mode:'local deterministic replay, UTF-8 SSE bytes, initial snapshot excluded',devices:4,sessionsPerDevicePerPeriod:500,periods:3,activeSessionsPerDevice:2,updates,results},null,2));
