'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSystemSampler, parseMeminfo, parseNetwork, parseDisk, registerSystemSources } = require('../../src/electron/plugins/systemDetails');
const { createDataBus } = require('../../src/shared/plugins/dataBus');
test('CPU totals and per-core readings share a baseline; reset does not average hidden time', () => {
  let n=0; const cpus=()=>[{times:{idle:n*20,user:n*80,sys:0,nice:0,irq:0}},{times:{idle:n*80,user:n*20,sys:0,nice:0,irq:0}}];
  const sampler=createSystemSampler({platform:'test',cpus,memory:()=>({used:20,total:100,percent:20})});
  assert.equal(sampler.sample().cpu,undefined);n++;const value=sampler.sample();assert.equal(value.cpu,50);assert.equal(Math.round(value.details.cpu.value.perCore[0]),80);
  assert.equal(value.details.gpu.status,'unsupported');sampler.reset();n+=100;assert.equal(sampler.sample().cpu,undefined);
});
test('detailed linux counters expose units and unavailable first rates without exposing interface names', () => {
  assert.equal(parseMeminfo('SwapTotal: 100 kB\nSwapFree: 40 kB').swapUsed,61440);
  assert.deepEqual(parseNetwork('eth0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0'),{received:100,sent:200});
  assert.deepEqual(parseDisk('8 0 sda 0 0 10 0 0 0 20 0 0 0 0\n8 1 sda1 0 0 100 0 0 0 200 0 0 0 0'),{read:5120,written:10240});
});
test('no demand performs no system IO; aliases and two plugins share exactly one sample', async () => {
  let callback, calls=0; const bus=createDataBus({setTimer:fn=>(callback=fn,1),clearTimer:()=>{callback=null}});
  registerSystemSources(bus,{platform:'test',cpus:()=>{calls++;return []},memory:()=>({used:1,total:2,percent:50})});assert.equal(calls,0);assert.equal(callback,undefined);
  bus.setDemand('one',{sources:['sys.cpu']});bus.setDemand('two',{sources:['sys.details','sys.memory']});await callback();assert.equal(calls,1);assert.equal(bus.read('sys.memory').value.percent,50);
  bus.clearDemand('one');assert.ok(callback);bus.clearDemand('two');assert.equal(callback,null);bus.dispose();
});
test('last subscriber removal discards a late async sample and resets the source', async () => {
  let callback, resolve, resets=0;const bus=createDataBus({setTimer:fn=>(callback=fn,1),clearTimer:()=>{callback=null}});
  bus.defineSource('slow',{sample:()=>new Promise(r=>{resolve=r}),reset:()=>resets++});bus.setDemand('one',{sources:['slow']});const run=callback;callback=null;const pending=run();bus.clearDemand('one');resolve(42);await pending;assert.equal(bus.read('slow'),null);assert.equal(resets,1);assert.equal(callback,null);bus.dispose();
});
