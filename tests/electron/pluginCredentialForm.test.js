'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../../src/electron/renderer/pluginCredentials');
const {Element}=require('../helpers/notchPanel');
const tick=()=>new Promise(setImmediate);
function fixture(){
  const document={createElement:tag=>{const node=new Element(tag);if(['input','textarea'].includes(tag))node.value='';node.prepend=(...nodes)=>node.replaceChildren(...nodes,...node.children);return node;}};
  const root=new Element();let revision=1, fail=false;
  const calls=[];
  const snapshot=()=>({revision,fields:{token:true,cookies:false},configured:true,declaration:{fields:[{id:'token',label:'Token',required:true,control:'input'},{id:'cookies',label:'Cookies',control:'textarea'}]}});
  const controller=create({document,t:key=>key,localize:v=>v,call:async(method,args)=>{calls.push({method,args});if(method==='credentials.status')return snapshot();if(fail)throw Error('credentials-conflict');revision++;return snapshot();}});
  return{root,calls,controller,set fail(value){fail=value;}};
}
test('form submits only touched fields, handles explicit empty, retains failed drafts and masks saved presence',async()=>{
  const f=fixture(),editor=await f.controller.mount(f.root,{moduleId:'one'});
  const input=f.root.querySelector('input'), textarea=f.root.querySelector('textarea'),save=f.root.querySelector('button');
  assert.equal(input.value,'');assert.equal(input.type,'password');assert.equal(input.placeholder,'plugins.credentials.present');
  textarea.value='a=b';textarea.fire('input');save.fire('click');await tick();
  assert.deepEqual(f.calls.at(-1).args.patch,{cookies:'a=b'});assert.equal(textarea.value,'');assert.equal(editor.hasUnsavedChanges(),false);
  input.value='';input.fire('input');f.fail=true;save.fire('click');await tick();
  assert.deepEqual(f.calls.at(-1).args.patch,{token:''});assert.equal(editor.hasUnsavedChanges(),true);
  assert.match(f.root.querySelector('.plugin-credential-error').textContent,/conflict/);
  input.value='draft';await editor.update({visible:true});assert.equal(input.value,'draft');assert.equal(f.calls.at(-1).method,'credentials.update');
  f.fail=false;save.fire('click');await tick();assert.equal(input.value,'');assert.equal(editor.hasUnsavedChanges(),false);
  editor.dispose();assert.equal(f.root.children.length,0);
});
