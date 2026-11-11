'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {Element}=require('../helpers/notchPanel');
const {translate}=require('../../src/electron/renderer/i18n');
test('credential cleanup is scoped to credential declarations while broken packages retain a cleanup route',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/electron/renderer/pluginSettings.js'),'utf8');
  const start=source.indexOf('    function credentialCleanupAction('),end=source.indexOf('    function detailSection(',start);
  const context={document:{},SURFACE_ORDER:[],catalogData:null,updatedVersions:new Map(),updatingPlugins:new Set(),busy:false,setDetailTooltip:null,t:key=>key,
    el:(_document,tag,className,text)=>{const node=new Element(tag);node.className=className;if(text)node.textContent=text;return node;},
    button:text=>{const node=new Element('button');node.textContent=text;return node;},pluginIdentity:()=>new Element(),statusChip:()=>new Element(),typeLabels:()=>new Element(),isFeatured:()=>false};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  for(const status of ['active','disabled','invalid','missing'])for(const declared of [true,false]){
    const card=context.pluginCard({id:'fixture',name:'Fixture',status,views:[],limits:declared?[{credentials:{fields:[]}}]:[]});
    const present=card.querySelectorAll('button').some(button=>button.textContent==='plugins.credentials.forget');
    assert.equal(present,false,`${status}, declared=${declared}`);
    assert.equal(Boolean(context.credentialCleanupAction({status,limits:declared?[{credentials:{fields:[]}}]:[]})),declared||['invalid','missing'].includes(status));
  }
});
test('credential-clear confirmation is localized in every supported app language',()=>{
  for(const locale of ['en','zh-TW','zh-CN','ko','ja','pt-BR'])for(const key of ['plugins.credentials.forgetTitle','plugins.credentials.forgetConfirm']){
    assert.notEqual(translate(locale,key),key);
    if(locale!=='en')assert.notEqual(translate(locale,key),translate('en',key));
  }
});
