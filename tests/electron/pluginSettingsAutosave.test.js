'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSettingsAutosave}=require('../../src/electron/renderer/pluginSettings');
const {normalizeSettings,prepareSettings,applySettingsPatch}=require('../../src/shared/plugins/settings');
const tick=()=>new Promise(setImmediate);
const snapshot=()=>({schemaVersion:1,revision:0,values:{mode:'a',text:'base'},errors:{},schema:{fields:[{id:'mode',default:'a'},{id:'text',default:'base'}]}});
function fixture(){const calls=[],pending=[];const c=createSettingsAutosave({snapshot:snapshot(),save:request=>{calls.push(request);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}});return{c,calls,pending,finish(index,values){pending[index].resolve({...snapshot(),revision:index+1,values});}};}
test('selects save immediately, text waits for completion and writers serialize newest edits',async()=>{
 const f=fixture();f.c.edit('mode','b',true);assert.equal(f.calls.length,1);f.c.edit('mode','c',true);f.c.edit('text','typing');
 f.finish(0,{mode:'b',text:'base'});await tick();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],{schemaVersion:1,expectedRevision:1,patch:{mode:'c'}});assert.equal(f.c.state.draft.text,'typing');
 f.finish(1,{mode:'c',text:'base'});await tick();assert.equal(f.calls.length,2);f.c.complete('text');assert.deepEqual(f.calls[2].patch,{text:'typing'});f.finish(2,{mode:'c',text:'typing'});await tick();assert.equal(f.c.state.message,'saved');
});
test('a queued complete text value does not submit a later unfinished edit',async()=>{
 const f=fixture();f.c.edit('mode','b',true);f.c.edit('text','done',true);f.c.edit('text','still typing');f.finish(0,{mode:'b',text:'base'});await tick();assert.equal(f.calls.length,1);assert.equal(f.c.state.draft.text,'still typing');f.c.complete('text');assert.equal(f.calls[1].patch.text,'still typing');f.c.dispose();
});
test('failures retain edits, do not loop, and retry uses the same revision',async()=>{
 const f=fixture();f.c.edit('mode','b',true);f.pending[0].reject(Error('disk'));await tick();assert.equal(f.c.state.message,'saveFailed');assert.equal(f.c.state.draft.mode,'b');f.c.edit('mode','c',true);assert.equal(f.calls.length,1);f.c.retry();assert.equal(f.calls[1].expectedRevision,0);assert.deepEqual(f.calls[1].patch,{mode:'c'});f.finish(1,{mode:'c',text:'base'});await tick();f.c.dispose();
});
test('conflict blocks edits/defaults/retries until explicit reload; controllers are independent',async()=>{
 const a=fixture(),b=fixture();a.c.edit('mode','b',true);a.pending[0].reject(Error('settings-conflict'));await tick();a.c.edit('text','kept',true);a.c.defaults();a.c.retry();assert.equal(a.calls.length,1);assert.equal(a.c.state.draft.text,'kept');b.c.edit('mode','b',true);assert.equal(b.calls.length,1);a.c.reload({...snapshot(),revision:5});a.c.edit('mode','c',true);assert.equal(a.calls[1].expectedRevision,5);a.c.dispose();b.c.dispose();
});
test('defaults apply in one save; dispose fences queued writes and late responses',async()=>{
 const f=fixture();f.c.defaults();assert.deepEqual(f.calls[0].patch,{mode:'a',text:'base'});f.c.edit('mode','later',true);f.c.dispose();f.finish(0,{mode:'a',text:'base'});await tick();assert.equal(f.calls.length,1);assert.equal(f.c.state.draft.mode,'later');
});
test('management waits for completed queued writes, including a failed or disposed writer',async()=>{
 for(const mode of ['success','failure','dispose']){
  const f=fixture();f.c.edit('mode','b',true);f.c.edit('text','queued',true);let settled=false;const waiting=f.c.settle().then(()=>settled=true);await tick();assert.equal(settled,false);
  if(mode==='failure')f.pending[0].reject(Error('disk'));
  else{if(mode==='dispose')f.c.dispose();f.finish(0,{mode:'b',text:'base'});}
  await tick();
  if(mode==='success'){assert.equal(settled,false);f.finish(1,{mode:'b',text:'queued'});}
  await waiting;assert.equal(settled,true);f.c.dispose();
 }
});
test('one invalid draft does not block saving a different valid control or lose its error',async()=>{
 const f=fixture();f.c.edit('text','bad',true);f.pending[0].reject(Object.assign(Error('invalid-settings-values'),{fields:{text:'length'}}));await tick();
 f.c.edit('mode','b',true);assert.deepEqual(f.calls[1].patch,{mode:'b'});f.finish(1,{mode:'b',text:'base'});await tick();assert.equal(f.c.state.draft.text,'bad');assert.equal(f.c.state.errors.text,'length');
 f.c.edit('text','fixed',true);assert.deepEqual(f.calls[2].patch,{text:'fixed'});f.finish(2,{mode:'b',text:'fixed'});await tick();assert.deepEqual(f.c.state.errors,{});f.c.dispose();
});
test('separate failures preserve existing field errors and storage failure remains retryable',async()=>{
 const f=fixture();f.c.edit('text','bad',true);f.pending[0].reject(Object.assign(Error('invalid-settings-values'),{fields:{text:'length'}}));await tick();
 f.c.edit('mode','b',true);f.pending[1].reject(Error('disk'));await tick();assert.equal(f.c.state.errors.text,'length');assert.equal(f.c.state.message,'saveFailed');
 f.c.retry();assert.deepEqual(f.calls[2].patch,{mode:'b'});f.finish(2,{mode:'b',text:'base'});await tick();assert.equal(f.c.state.errors.text,'length');f.c.dispose();
});
test('an invalid response does not strand another completed edit queued during the request',async()=>{
 const f=fixture();f.c.edit('text','bad',true);f.c.edit('mode','b',true);f.pending[0].reject(Object.assign(Error('invalid-settings-values'),{fields:{text:'length'}}));await tick();
 assert.deepEqual(f.calls[1].patch,{mode:'b'});f.finish(1,{mode:'b',text:'base'});await tick();assert.equal(f.c.state.errors.text,'length');f.c.dispose();
});
test('validation for an older value does not mark its completed replacement invalid',async()=>{
 const f=fixture();f.c.edit('text','bad',true);f.c.edit('text','fixed',true);f.pending[0].reject(Object.assign(Error('invalid-settings-values'),{fields:{text:'length'}}));await tick();
 assert.deepEqual(f.calls[1].patch,{text:'fixed'});assert.deepEqual(f.c.state.errors,{});f.finish(1,{mode:'a',text:'fixed'});await tick();assert.equal(f.c.state.message,'saved');f.c.dispose();
});
test('invalid stored fields park rejected writes until correction or defaults, without retrying',async()=>{
 for(const recovery of ['correction','defaults']){
  const schema=normalizeSettings({version:2,fields:[{id:'label',type:'string',label:'Label',default:'base'},{id:'rows',type:'number',label:'Rows',default:2,min:1}]});
  let stored={schemaVersion:1,revision:3,values:{label:'base',rows:0}};const calls=[];
  const current=()=>({schema,schemaVersion:2,revision:stored.revision,...prepareSettings(schema,stored)});
  const c=createSettingsAutosave({snapshot:current(),save:async request=>{
   calls.push(request);if(calls.length>3)throw Error('bounded regression guard');
   const values=applySettingsPatch(schema,stored,request.patch);stored={schemaVersion:2,revision:stored.revision+1,values};return current();
  }});
  c.edit('label','changed',true);await tick();await tick();assert.equal(calls.length,1);assert.equal(c.state.errors.rows,'range');assert.equal(c.state.draft.label,'changed');assert.equal(c.state.pending,false);
  if(recovery==='defaults')c.defaults();else c.edit('rows',4,true);
  await tick();assert.equal(calls.length,2);assert.equal(stored.values.rows,recovery==='defaults'?2:4);assert.equal(stored.values.label,recovery==='defaults'?'base':'changed');assert.deepEqual(c.state.errors,{});c.dispose();
 }
});
test('management pauses writes but retains focused edits; removed editors cannot resume writes',async()=>{
 for(const removed of [false,true]){
  const f=fixture();f.c.pause();f.c.edit('text','edited during management');f.c.complete('text');assert.equal(f.calls.length,0);assert.equal(f.c.state.draft.text,'edited during management');
  if(removed)f.c.dispose();f.c.resume();assert.equal(f.calls.length,removed?0:1);
  if(!removed){assert.deepEqual(f.calls[0].patch,{text:'edited during management'});f.finish(0,{mode:'a',text:'edited during management'});await tick();}f.c.dispose();
 }
});
