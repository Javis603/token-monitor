'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../../src/electron/renderer/pluginCredentials');
const {Element}=require('../helpers/notchPanel');
const tick=()=>new Promise(setImmediate);
function fixture(statusInHeader=()=>false){
  const document={createElement:tag=>{const node=new Element(tag);if(['input','textarea'].includes(tag))node.value='';node.prepend=(...nodes)=>node.replaceChildren(...nodes,...node.children);return node;}};
  const root=new Element();let revision=1, fail=false;
  const calls=[];
  const snapshot=()=>({revision,fields:{token:true,cookies:false},configured:true,declaration:{fields:[{id:'token',label:'Token',required:true,control:'input'},{id:'cookies',label:'Cookies',control:'textarea'}]}});
  const controller=create({document,statusInHeader,t:key=>key,localize:v=>v,call:async(method,_args)=>{calls.push({method,args:_args});if(method==='credentials.status')return snapshot();if(fail)throw Error('credentials-conflict');revision++;return snapshot();}});
  return{root,calls,controller,set fail(value){fail=value;}};
}
test('form submits only touched fields, handles explicit empty, retains failed drafts and masks saved presence',async()=>{
  const f=fixture(),editor=await f.controller.mount(f.root,{moduleId:'one'});
  f.root.querySelectorAll('button').find(node=>node.dataset.credentialAction==='edit').fire('click');
  const input=f.root.querySelector('input'), textarea=f.root.querySelector('textarea'),save=f.root.querySelector('.plugin-credential-editor').querySelector('button');
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
test('clear depends on saved presence, not completeness or unsaved text; valid summary preserves deliberate edits',async()=>{
  const document={createElement:tag=>{const n=new Element(tag);if(['input','textarea'].includes(tag))n.value='';return n;}};
  let saved={revision:0,fields:{token:false},configured:false,verification:'unverified',declaration:{validation:true,fields:[{id:'token',label:'Token',control:'input',required:true}]}},states=[];
  const root=new Element();const editor=await create({document,t:k=>k,localize:v=>v,call:async(method,_args)=>{
    if(method==='credentials.update'){saved={...saved,revision:1,fields:{token:true},configured:true};}
    if(method==='credentials.verify')saved={...saved,verification:'valid'};
    if(method==='credentials.clear')saved={...saved,revision:2,fields:{token:false},configured:false,verification:'unverified'};
    return saved;
  }}).mount(root,{moduleId:'one',onStateChange:value=>states.push(value)});
  const action=id=>root.querySelectorAll('button').find(n=>n.dataset.credentialAction===id),input=root.querySelector('input'),form=root.querySelector('.plugin-credential-editor');
  assert.equal(action('clear').hidden,true);input.value='draft';input.fire('input');assert.equal(action('clear').hidden,true);
  action('cancel').fire('click');await tick();assert.equal(input.value,'');assert.equal(form.hidden,false);
  input.value='draft';input.fire('input');
  action('save').fire('click');await tick();assert.equal(form.hidden,true);assert.equal(states.at(-1).verification,'valid');assert.equal(action('clear').hidden,false);
  action('edit').fire('click');input.value='keep my draft';input.fire('input');await editor.update({visible:true});assert.equal(input.value,'keep my draft');assert.equal(form.hidden,false);
  action('cancel').fire('click');await tick();assert.equal(input.value,'');assert.equal(form.hidden,true);
  saved={...saved,configured:false,verification:'expired'};action('edit').fire('click');await editor.update({visible:true});assert.equal(action('clear').hidden,false,'partial/expired credentials can be cleared');
  action('clear').fire('click');await tick();assert.equal(action('clear').hidden,true);assert.equal(form.hidden,false);editor.dispose();
});


test('conflicting clear retains its revision until explicit reload, including an in-flight refresh',async()=>{
 const document={createElement:tag=>{const n=new Element(tag);if(['input','textarea'].includes(tag))n.value='';return n;}};
 let saved={revision:1,fields:{token:true},configured:true,declaration:{fields:[{id:'token',label:'Token',control:'input',required:true}]}},release;
 const calls=[];let defer=false;
 const root=new Element(),editor=await create({document,t:k=>k,localize:v=>v,call:async(method,args)=>{
  calls.push({method,args});
  if(method==='credentials.status'){if(defer)return new Promise(resolve=>{release=()=>resolve({...saved});});return {...saved};}
  if(args.expectedRevision!==saved.revision)throw Error('credentials-conflict');
  return {...saved,revision:++saved.revision};
 }}).mount(root,{moduleId:'one'});
 const action=id=>root.querySelectorAll('button').find(n=>n.dataset.credentialAction===id);
 saved={...saved,revision:2};action('clear').fire('click');await tick();
 assert.equal(action('reload').hidden,false);
 await editor.update({visible:true});
 action('clear').fire('click');await tick();
 assert.equal(calls.at(-1).args.expectedRevision,1,'background update cannot silently rebase conflicting clear');
 action('reload').fire('click');await tick();assert.equal(action('reload').hidden,true);
 defer=true;const refreshing=editor.update({visible:true});
 saved={...saved,revision:3};action('clear').fire('click');await tick();release();await refreshing;
 assert.equal(action('reload').hidden,false);
 const input=root.querySelector('input');input.value='synthetic-draft';input.fire('input');action('save').fire('click');await tick();
 assert.equal(calls.at(-1).args.expectedRevision,2,'in-flight update cannot replace conflict base');
 assert.equal(input.value,'synthetic-draft');assert.equal(action('reload').hidden,false);
 defer=false;action('reload').fire('click');await tick();assert.equal(input.value,'synthetic-draft');action('save').fire('click');await tick();
 assert.equal(calls.at(-1).args.expectedRevision,3);assert.equal(input.value,'');editor.dispose();
});

test('host header owns the credential label; editing actions remain with fields and standalone status stays available', async () => {
  const f=fixture(()=>true),editor=await f.controller.mount(f.root,{moduleId:'one'});
  const summary=f.root.querySelector('.plugin-credential-summary');
  const feedback=summary.querySelector('p');
  summary.querySelectorAll('button').find(node=>node.dataset.credentialAction==='edit').fire('click');
  const buttons=f.root.querySelectorAll('button');
  const clear=buttons.find(button=>button.dataset.credentialAction==='clear');
  const save=buttons.find(button=>button.dataset.credentialAction==='save');
  assert.equal(feedback.hidden,true);
  assert.equal(clear.parentNode,save.parentNode,'clear is beside save/cancel while editing');
  const cancel=buttons.find(button=>button.dataset.credentialAction==='cancel');
  cancel.fire('click');await tick();
  assert.equal(clear.parentNode,summary,'collapsed editor retains its management actions');
  assert.equal(feedback.hidden,true);
  editor.dispose();
  const standalone=fixture(),own=await standalone.controller.mount(standalone.root,{moduleId:'one'});
  assert.equal(standalone.root.querySelector('.plugin-credential-summary').querySelector('p').hidden,false);
  own.dispose();
});

test('failed explicit and post-save verification restore saved state and expose conflicts without rolling back a successful save', async () => {
  for (const automatic of [false,true]) for (const failure of ['transport-failed','credentials-conflict']) {
    const document={createElement:tag=>{const node=new Element(tag);if(['input','textarea'].includes(tag))node.value='';return node;}};
    let saved={revision:1,fields:{token:true},configured:true,verification:automatic?'unverified':'unavailable',declaration:{validation:true,fields:[{id:'token',label:'Token',control:'input',required:true}]}},states=[];
    const root=new Element(),calls=[];let reject=true;
    const editor=await create({document,t:key=>key,localize:value=>value,call:async(method,args)=>{
      calls.push({method,args});
      if(method==='credentials.update')saved={...saved,revision:2};
      if(method==='credentials.verify'){if(reject)throw Error(failure);return {...saved,verification:'valid'};}
      return saved;
    }}).mount(root,{moduleId:'one',onStateChange:state=>states.push(state)});
    const action=id=>root.querySelectorAll('button').find(node=>node.dataset.credentialAction===id);
    if(automatic){action('edit').fire('click');const input=root.querySelector('input');input.value='synthetic-replacement';input.fire('input');action('save').fire('click');}
    else action('verify').fire('click');
    await tick();
    assert.equal(states.at(-1).verification,automatic?'unverified':'unavailable');
    assert.equal(states.at(-1).pending,false);
    assert.equal(states.at(-1).revision,automatic?2:1,'successful save is retained when its later verification fails');
    assert.equal(action('verify').disabled,false,'verification can be retried');
    assert.equal(action('reload').hidden,failure!=='credentials-conflict');
    assert.equal(root.querySelector('.plugin-credential-error').textContent,'plugins.credentials.'+(failure==='credentials-conflict'?'conflict':'checkError'));
    assert.equal(editor.hasUnsavedChanges(),false);
    assert.equal(calls.at(-1).args.expectedRevision,automatic?2:1);
    if(failure==='credentials-conflict'){assert.equal(action('verify').hidden,true);action('reload').fire('click');await tick();}
    reject=false;
    if(action('verify').hidden){action('edit').fire('click');const input=root.querySelector('input');input.value='synthetic-retry';input.fire('input');action('save').fire('click');}
    else action('verify').fire('click');await tick();
    assert.equal(states.at(-1).verification,'valid');
    assert.equal(root.querySelector('.plugin-credential-error').hidden,true,'successful retry removes the previous failure');
    editor.dispose();
  }
});

test('clear conflict exposes reload outside a collapsed credential editor', async () => {
  const document={createElement:tag=>{const node=new Element(tag);if(['input','textarea'].includes(tag))node.value='';return node;}};
  let revision=1;
  const saved=()=>({revision,fields:{token:true},configured:true,verification:'valid',declaration:{validation:true,fields:[{id:'token',label:'Token',control:'input',required:true}]}});
  const root=new Element(),editor=await create({document,t:key=>key,localize:value=>value,statusInHeader:()=>true,call:async(method,args)=>{
    if(method==='credentials.status')return saved();
    if(args.expectedRevision!==revision)throw Error('credentials-conflict');
    return {...saved(),revision:++revision,fields:{token:false},configured:false,verification:'unverified'};
  }}).mount(root,{moduleId:'one'});
  const action=id=>root.querySelectorAll('button').find(node=>node.dataset.credentialAction===id),form=root.querySelector('.plugin-credential-editor');
  assert.equal(form.hidden,true);revision=2;
  action('clear').fire('click');await tick();
  assert.equal(action('reload').hidden,false);
  assert.equal(form.hidden,true);
  assert.equal(action('reload').parentNode,action('clear').parentNode,'recovery is visible beside clear while the editor stays collapsed');
  action('reload').fire('click');await tick();assert.equal(action('reload').hidden,true);
  action('clear').fire('click');await tick();assert.equal(form.hidden,false);assert.equal(action('clear').hidden,true);
  editor.dispose();
});

test('saved credentials reopen compactly without a routine verification action; only failed checks offer retry', async () => {
  const document={createElement:tag=>{const node=new Element(tag);if(['input','textarea'].includes(tag))node.value='';return node;}};
  for (const verification of ['unverified','valid','rejected','expired','unavailable']) {
    const calls=[],root=new Element();
    const snapshot={revision:1,configured:true,fields:{token:true},verification,declaration:{validation:true,fields:[{id:'token',label:'Token',control:'input',required:true}]}};
    const editor=await create({document,t:key=>key,localize:value=>value,call:async(method)=>{calls.push(method);return snapshot;}}).mount(root,{moduleId:'one'});
    const retry=root.querySelectorAll('button').find(node=>node.dataset.credentialAction==='verify');
    const failed=['rejected','expired','unavailable'].includes(verification);
    assert.equal(retry.hidden,!failed,verification);
    assert.equal(retry.textContent,'plugins.credentials.retry');
    assert.equal(root.querySelector('.plugin-credential-editor').hidden,!failed);
    assert.deepEqual(calls,['credentials.status'],'mount never starts a validation request');
    assert.equal(root.querySelector('input').value,'');
    editor.dispose();
  }
});

test('a failed verification retry belongs only to its saved revision', async () => {
  const document={createElement:tag=>{const node=new Element(tag);if(['input','textarea'].includes(tag))node.value='';return node;}};
  let saved={revision:1,configured:true,fields:{token:true},verification:'unavailable',declaration:{validation:true,fields:[{id:'token',label:'Token',control:'input',required:true}]}};
  const root=new Element(),calls=[];
  const editor=await create({document,t:key=>key,localize:value=>value,call:async(method)=>{calls.push(method);if(method==='credentials.verify')throw Error('transport-failed');return saved;}}).mount(root,{moduleId:'one'});
  const retry=root.querySelectorAll('button').find(node=>node.dataset.credentialAction==='verify');
  retry.fire('click');await tick();assert.equal(retry.hidden,false);
  assert.equal(root.querySelector('.plugin-credential-error').hidden,false);
  saved={...saved,revision:2,verification:'unverified'};
  await editor.update({visible:true});
  assert.equal(retry.hidden,true,'replacement credentials do not inherit a failed check');
  assert.equal(root.querySelector('.plugin-credential-error').hidden,true);
  assert.deepEqual(calls,['credentials.status','credentials.verify','credentials.status']);
  editor.dispose();
});
