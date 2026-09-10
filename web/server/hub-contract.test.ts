// @vitest-environment node
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { isHubStats, periodFor, usageRows } from '../src/data/stats.js';
const require=createRequire(import.meta.url);
const {createHub}=require('../../src/hub/server.js');
it('reads real upstream Hub aggregation without local extensions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tm-web-contract-'));
  const hub=createHub({host:'127.0.0.1',port:0,secret:'synthetic-test-secret',dataFile:join(root,'devices.json')});
  try {
    await hub.start();
    const base=`http://127.0.0.1:${hub.server.address().port}`;
    const result=await fetch(base+'/api/ingest',{method:'POST',headers:{authorization:'Bearer synthetic-test-secret','content-type':'application/json'},body:JSON.stringify({deviceId:'demo-device',hostname:'Demo workstation',platform:'linux',updatedAt:new Date().toISOString(),today:{totalTokens:1200,clients:{codex:1200},models:{'gpt-5':1200}},month:{totalTokens:1200},allTime:{totalTokens:1200}})});
    expect(result.ok).toBe(true);
    const stats=await (await fetch(base+'/api/stats',{headers:{authorization:'Bearer synthetic-test-secret'}})).json();
    expect(isHubStats(stats)).toBe(true);
    expect(periodFor(stats,'today').totalTokens).toBe(1200);
    expect(usageRows(periodFor(stats,'today'),'clients')[0]).toMatchObject({id:'codex',total:1200});
  } finally {await hub.stop();await rm(root,{recursive:true,force:true});}
});
