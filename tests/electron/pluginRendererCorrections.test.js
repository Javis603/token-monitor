'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict'), espree = require('espree');
const test = require('node:test');
const root = process.env.TM_PLUGIN_CORRECTIONS_ROOT || path.resolve(__dirname, '../..');
const req = p => require(path.join(root,p));
const appPath='src/electron/renderer/app.js', source=fs.readFileSync(path.join(root,appPath),'utf8');
const ast=espree.parse(source,{ecmaVersion:'latest',loc:true,range:true}), extracted={};
function extract(name) {
 const n=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);
 assert.ok(n,name); extracted[name]={file:appPath,start:n.loc.start.line,end:n.loc.end.line};
 return source.slice(n.start,n.end);
}
function scope(names, bindings) { const c=vm.createContext(bindings); vm.runInContext(names.map(extract).join('\n'),c); return c; }
const prefs=req('src/electron/renderer/homeModulePreferences.js'), placements=req('src/shared/plugins/placements.js'), placement=req('src/electron/plugins/placementSettings.js');
const itemsApi=req('src/electron/renderer/edgeDock/items.js');
const i18n=req('src/electron/renderer/i18n.js'), t=(key,params)=>i18n.translate('en',key,params);
const {Element}=require('../helpers/notchPanel.js');
// Repository DOM helper, extended only for sibling placement/connectivity used by Rich host.
Object.defineProperties(Element.prototype,{
 firstChild:{get(){return this.children[0]||null;}},
 isConnected:{get(){return this===this.ownerDocument.body||!!this.parent?.isConnected;}},
 previousElementSibling:{get(){return this.parent?.children[this.parent.children.indexOf(this)-1]||null;}}
});
Element.prototype.before=function(n){n.remove();const i=this.parent.children.indexOf(this);this.parent.children.splice(i,0,n);n.parent=this.parent;};
Element.prototype.after=function(n){n.remove();const i=this.parent.children.indexOf(this);this.parent.children.splice(i+1,0,n);n.parent=this.parent;};
Element.prototype.getBoundingClientRect=function(){return {x:0,y:80,left:0,top:80,width:400,height:120,bottom:200,right:400};};
function makeDoc(){const d={activeElement:null,hidden:false,addEventListener(){}};d.createElement=tag=>new Element(tag,d);d.createElementNS=(_,tag)=>d.createElement(tag);d.body=d.createElement('body');d.documentElement=d.createElement('html');d.querySelector=s=>d.body.querySelector(s);d.getElementById=id=>walk(d.body).find(x=>x.id===id)||null;return d;}
function walk(n){return [n,...n.children.flatMap(walk)];}

test('Home drag preserves inactive plugin placement and hidden slot through re-enable', () => {
 // 3: actual Home options and exact production drag callback, real settings normalization/placement lookup.
 const builtins=['limits','tool','model','session','device','trends'].map(id=>({id}));
 const token='plugin:system-monitor/overview';
 const state={settings:{homeModuleOrder:['limits',token,...builtins.slice(1).map(x=>x.id)].join(',')},pluginCatalog:{plugins:[{id:'system-monitor',name:'System Monitor',status:'active',views:[{ref:'system-monitor/overview',title:'Overview',surfaces:['home']}]}]}};
 const saves=[];
 const c=scope(['homeModuleOptions','createMainPreferenceRowDrag'],{state,HOME_MODULE_OPTIONS:builtins,pluginPlacementsApi:placements,homeModulePreferencesApi:prefs,MAIN_PREFERENCE_DRAG_EXCLUDED:'unused',rowDragControllerApi:{createRowDragController:x=>x},verticalDragSortApi:{},preserveSettingsPanelScroll(){},saveSettings(patch){saves.push(patch);state.settings={...state.settings,homeModuleOrder:prefs.normalizeHomeModuleOrder(patch.homeModuleOrder,builtins).join(',')};}});
 const original=state.settings.homeModuleOrder;
 assert.equal(c.homeModuleOptions().length,7);
 state.pluginCatalog.plugins[0].status='disabled';
 const visible=prefs.orderedHomeModules(c.homeModuleOptions(),state.settings.homeModuleOrder).map(x=>x.id);
 assert.equal(visible.length,6);
 const drag=c.createMainPreferenceRowDrag({kind:'homeModule',settingKey:'homeModuleOrder'});
 const reordered=[visible[1],visible[0],...visible.slice(2)];
 const value=drag.mirrorOrder(reordered);drag.persistOrder(reordered,'tool',value);
 state.pluginCatalog.plugins[0].status='active';
 const afterOptions=c.homeModuleOptions().map(x=>x.id), afterPlacement=placement.placementsFor(state.settings,'system-monitor/overview');
 assert.equal(afterOptions.includes(token),true);assert.equal(afterPlacement.home,true);
 assert.equal(value.split(',')[1],token);
 assert.equal(saves[0].homeModuleOrder,value);
 assert.deepEqual(value.split(',').filter(id=>id!==token),reordered);
 const keyboard=prefs.moveHomeModuleOrder(original,builtins,'model','up');assert.ok(keyboard.includes(token));

 const globalDrag=c.createMainPreferenceRowDrag({kind:'view',settingKey:'viewDisplayOrder'});
 assert.equal(globalDrag.mirrorOrder(['device','model']),'device,model');
});

test('composer names plugin entries and keeps remove/reorder without quota controls', tctx => {
 // 8: actual app composer dependency handoff, production composer and normalizer.
 const document=makeDoc();const previousDocument=global.document;global.document=document; tctx.after(()=>{global.document=previousDocument;});
 const dockRoot=document.createElement('div');document.body.append(dockRoot);
 const dockState={settings:{edgeDockItems:[{type:'plugin',ref:'system-monitor/cpu'},{type:'plugin',ref:'system-monitor/memory'}]},stats:{limits:{providers:[]}},pluginCatalog:{plugins:[{status:'active',views:[{ref:'system-monitor/cpu',title:'CPU'},{ref:'system-monitor/memory',title:'Memory'}]}]}};
 const dockSaves=[];let drag;
 const dc=scope(['createDockItemsComposer'],{window:{TokenMonitorEdgeDockComposer:req('src/electron/renderer/edgeDock/composer.js'),TokenMonitorEdgeDockItems:itemsApi,TokenMonitorEdgeDockPresentation:{},TokenMonitorLimitProviders:req('src/shared/limits/providers.js')},state:dockState,t,saveSettings(patch){dockSaves.push(JSON.parse(JSON.stringify(patch)));dockState.settings={...dockState.settings,edgeDockItems:itemsApi.normalizeEdgeDockItems(patch.edgeDockItems)};},limitProviderColor:()=> '#fff',limitMarksWithIcon:new Set(),mimoProductLabel:()=>'',rowDragControllerApi:{createRowDragController:config=>{drag=config;return {deferRender:()=>false};}},verticalDragSortApi:{},preserveSettingsPanelScroll(){}});
 const composer=dc.createDockItemsComposer(dockRoot,'edgeDockItems');composer.render();
 const labels=dockRoot.querySelectorAll('.edge-dock-composer-item').map(n=>({id:n.dataset.itemId,ariaLabel:n.getAttribute('aria-label'),text:n.textContent}));
 assert.equal(labels.length,2);assert.deepEqual(labels.map(x=>x.ariaLabel),['CPU','Memory']);
 assert.ok(dockRoot.querySelectorAll('.edge-dock-composer-item').every(node=>node.getAttribute('title')==null));
 dockRoot.querySelectorAll('.edge-dock-composer-item')[0].fire('click');
 const title=dockRoot.querySelector('.edge-dock-composer-detail-title').textContent;

 assert.equal(title,'CPU');
 assert.equal(dockRoot.querySelectorAll('input').length,0);
 assert.equal(dockRoot.querySelectorAll('select').length,0);
 drag.persistOrder(['plugin:system-monitor/memory','plugin:system-monitor/cpu']);
 assert.deepEqual(dockState.settings.edgeDockItems.map(x=>x.ref),['system-monitor/memory','system-monitor/cpu']);
 dockRoot.querySelector('.edge-dock-composer-remove').fire('click');
 assert.deepEqual(dockState.settings.edgeDockItems,[{type:'plugin',ref:'system-monitor/memory'}]);
 dockState.pluginCatalog.plugins[0].status='disabled';composer.render();
 assert.equal(dockRoot.querySelector('.edge-dock-composer-item').getAttribute('aria-label'),'Memory');
 dockState.pluginCatalog={plugins:[]};composer.render();
 assert.equal(dockRoot.querySelector('.edge-dock-composer-item').getAttribute('aria-label'),'system-monitor/memory');
});

test('Notch choices exclude inactive plugins without removing native pages', () => {
 const catalog={enabled:true,plugins:[{status:'active',views:[{ref:'demo/first',title:'First',surfaces:['notch'],placements:{notch:true}},{ref:'demo/second',title:'Second',surfaces:['notch'],placements:{notch:true}}]},{status:'disabled',views:[{ref:'idle/main',title:'Idle',surfaces:['notch'],placements:{notch:true}}]}]};
 const d=makeDoc(), container=d.createElement('div');d.body.append(container);
 req('src/electron/renderer/notch/pageSettings.js').render({document:d,container,settings:{},catalog,t,save:async()=>{},place:async()=>{},onError:e=>{throw e;}});
 const chips=container.querySelectorAll('.notch-page-chip');
 assert.equal(chips.length,6);assert.equal(chips.some(n=>n.dataset.page==='plugin:idle/main'),false);
});
