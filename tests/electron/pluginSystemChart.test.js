'use strict';
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const path = require('node:path'), test = require('node:test');
const file = path.resolve(__dirname, '../../src/electron/plugins/builtin/system-monitor/ui/chart.js');
test('chart reconciles wall-clock jumps without stale curves or rejecting fresh samples', async () => {
let monotonic = 0, wall = 1700000000000, seq = 0;
const raf = new Map(), nodes = new Map();
const node = key => { if (!nodes.has(key)) nodes.set(key, {attrs:{},setAttribute(k,v){this.attrs[k]=v;},textContent:''}); return nodes.get(key); };
const element = {dataset:{metric:'cpu'},querySelector:node};
const doc = {hidden:false,querySelectorAll:()=>[element],documentElement:{style:{setProperty(){}}},body:{style:{}},addEventListener(){}};
const ctx = vm.createContext({document:doc,window:{addEventListener(){}},Date:{now:()=>wall},performance:{now:()=>monotonic},console,
 requestAnimationFrame:cb=>{raf.set(++seq,cb);return seq;},cancelAnimationFrame:id=>raf.delete(id),
 tm:{onContext:()=>()=>{},context:async()=>({theme:{colors:{},reducedMotion:false}}),storage:{get:async()=>null,set:async()=>{}},onData:()=>()=>{},subscribe:async()=>({})}});
vm.runInContext(fs.readFileSync(file,'utf8'),ctx,{filename:file});
const read = () => vm.runInContext('({at:charts[0].at,end:charts[0].end,points:charts[0].points.length})',ctx);
function advance(ms){monotonic+=ms;wall+=ms;const batch=[...raf.values()];raf.clear();for(const cb of batch)cb(monotonic);}
function sample(value){ctx.reading={at:wall,value};vm.runInContext("data({'sys.cpu':reading})",ctx);}

 for(let i=0;i<8;i++)await Promise.resolve();
 sample(10); advance(2000); sample(20); advance(1000);
 assert.equal(read().at-read().end,1250); console.log('PASS normal clock has expected delayed presentation');
 const before=read().end; advance(100);sample(30); assert.ok(read().end>=before);
 assert.equal(node('.value').textContent,'30%');console.log('PASS overlapping delivery preserves monotonic end and latest labels');
 wall+=60000; sample(80); const jump=read();console.log('CLOCK_FORWARD',JSON.stringify({...jump,lag:jump.at-jump.end}));
 for(let i=0;i<5;i++){advance(2000);sample(80+i);}
 const later=read(); console.log('TEN_SECONDS_LATER',JSON.stringify({...later,lag:later.at-later.end,label:node('.value').textContent,transform:node('.line').attrs.transform}));
 assert.equal(later.at-later.end,2250); assert.equal(node('.value').textContent,'84%');
 wall-=60000; sample(42);
 assert.equal(read().at,wall); assert.equal(node('.value').textContent,'42%');
 assert.equal(read().points,1); assert.equal(read().at-read().end,2250);
 advance(2000); sample(43); assert.equal(read().points,2); assert.equal(read().at-read().end,2250);
 doc.hidden=true;vm.runInContext('render()',ctx);assert.equal(raf.size,0);console.log('PASS hidden document cancels animation frame');
});
