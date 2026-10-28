'use strict';
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-settings-ui.cjs
// Isolated Chromium DOM + fixture API. Does not open the main app or use user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-settings-ui-'));
app.setPath('userData', path.join(scratch, 'user-data'));
app.on('window-all-closed', () => {});
let win;
async function main() {
  app.dock?.hide();
  fs.writeFileSync(path.join(scratch, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${root}/src/electron/renderer/styles.css"><link rel="stylesheet" href="file://${root}/src/electron/renderer/pluginViews.css"><style>body{overflow:auto}#scroll{display:block;height:500px;overflow:auto}#before{height:80px}#after{height:600px}</style></head><body><div id="scroll" class="settings-panel"><div id="before"></div><div id="settings"></div><div id="after"></div></div><button id="outside">Outside</button><script src="file://${root}/src/electron/renderer/pluginUi.js"></script><script src="file://${root}/src/electron/renderer/pluginViews.js"></script><script src="file://${root}/src/electron/renderer/limits/windowsView.js"></script><script src="file://${root}/src/electron/renderer/selectControl.js"></script><script src="file://${root}/src/electron/renderer/pluginSettings.js"></script><script src="file://${root}/src/electron/renderer/pluginMainPages.js"></script></body></html>`);
  fs.writeFileSync(path.join(scratch, 'ui.mjs'), "export function mount(container){const input=document.createElement('input');input.value='saved';container.append(input);return {dispose(){input.remove()}}}");
  win = new BrowserWindow({ show: false, width: 361, height: 799, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const appHtml=fs.readFileSync(path.join(root,'src/electron/renderer/index.html'),'utf8');
  const appHeader=appHtml.slice(appHtml.indexOf('<header class="titlebar">'),appHtml.indexOf('</header>')+9);
  assert.ok(!appHtml.includes('id="pluginsEnabledInput"')&&!appHtml.includes('data-i18n="settings.plugins.intro"'));
  const i18n=require(path.join(root,'src/electron/renderer/i18n.js'));
  for (const locale of i18n.LANGUAGE_OPTIONS.filter(item=>item.value!=='auto').map(item=>item.value)) assert.ok(!i18n.translate(locale,'plugins.package.import').includes('…'));
  await win.loadFile(path.join(scratch, 'index.html'));
  // Hidden fixture windows need focus emulation for real DOM focusin/out.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const result = await win.webContents.executeJavaScript(`(async () => {
    const checks = [], calls = [];
    const check = (name, ok, evidence) => { checks.push({name, ok: Boolean(ok), evidence}); };
    const box = document.getElementById('settings'), scroll = document.getElementById('scroll');
    const tick = () => new Promise(r => setTimeout(r, 20));
    const data = {enabled:true, plugins:[{id:'alpha',trusted:true,types:['widget','page'],name:'Alpha',description:'Plugin description',version:'1.0.0',source:'user',status:'active',enabled:true,views:[{ref:'alpha/view',title:'View',surfaces:['home','page'],placements:{home:false}}],background:{supported:true,enabled:false},logs:[{at:0,level:'info',text:'Fixture ready'}],runtime:{state:'idle',cpuPercent:null,memoryMB:null}},{id:'beta',name:'Beta',source:'user',status:'disabled',enabled:false,views:[]}]};
    let pending, reject, previewPending, catalogCalls = 0, importResult = null, copyFailure = false;
    let catalogMode = 'success', previewMode = 'success', globalMode = 'success', savedMasterEnabled = true;
    const catalog = {entries:[{id:'demo',types:['page'],name:'Demo',description:'Example',author:'Author',version:'1.0.0',origin:{id:'custom-fixture',kind:'community'},versions:[{version:'1.0.0',compatible:true,installable:true,updateNotes:[]},{version:'2.0.0',compatible:true,installable:true,updateNotes:[]}],status:'available'}],sources:[]};
    const tooltips = TokenMonitorLimitWindowsView.createLimitWindowsView({document,tooltip:{hasOpened:()=>false,markOpened:()=>{},release:()=>{}}});
    const panel = TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:box,setDetailTooltip:tooltips.setDetailTooltip,getEnabled:()=>savedMasterEnabled,onCopyText:async text=>{if(copyFailure)throw Error('clipboard unavailable');calls.push(['copy',text])},onOpenExternal:async url=>{calls.push(['guide',url])},onSetEnabled:async enabled=>{calls.push(['global',enabled]);if(globalMode==='error')throw Error('settings write failed');savedMasterEnabled=enabled;data.enabled=enabled&&!data.safeMode;return structuredClone(data)},t:(key,args)=>key==='plugins.authoring.prompt'?'Fixture prompt with exact punctuation:':key==='plugins.ui.locationCount'?String(args.count)+' locations':key==='settings.plugins.actionFailed'?args.error:key,api:{
      list:async()=>structuredClone(data),
      catalog:()=>{catalogCalls++;return catalogMode==='deferred'?new Promise((yes,no)=>{pending=yes;reject=no}):Promise.resolve(catalog)},
      refreshSource:async id=>{calls.push(['refreshSource',id]);const source=catalog.sources.find(s=>s.id===id);source.error=source.nextError||'';return catalog},
      catalogDetails:async()=>({html:'',imageCount:0}),
      closeCatalogDetails:async()=>{},
      place:async(ref,surface,on)=>{calls.push(['place',ref,surface,on]);data.plugins[0].views[0].placements.home=on;return structuredClone(data)},
      setEnabled:async(id,on)=>{const p=data.plugins.find(p=>p.id===id);p.enabled=on;p.status=on?'active':'disabled';return structuredClone(data)},
      catalogPreview:async(source,id,version)=>{calls.push(['preview',version]);if(previewMode==='error')throw Error('preview rejected');if(previewMode==='deferred')await new Promise(resolve=>{previewPending=resolve});return {token:'token-'+version,id,name:'Demo',description:'Example',version,author:'Author',origin:{id:source,kind:'community'},operation:'install',sha256:'abc'}},
      cancelInstall:async token=>{calls.push(['cancel',token])},
      install:async token=>{calls.push(['install',token]);return structuredClone(data)},
      importPackage:async kind=>{calls.push(['import',kind]);return importResult},
      openFolder:async()=>{calls.push(['folder'])},reload:async()=>structuredClone(data)
    }});
    await panel.refresh();
    check('installed-version-shares-metadata-with-capability-labels',box.querySelector('.plugin-card-meta .plugin-version')?.textContent==='v1.0.0'&&box.querySelector('.plugin-card-meta .plugin-types')?.textContent==='plugins.type.widgetplugins.type.page');
    check('legacy-entry-does-not-invent-types',!box.querySelector('[data-plugin-id="beta"] .plugin-type'));
    data.plugins[0].author='Token Monitor · Official';await panel.refresh();
    const sourceIdentity=box.querySelector('.plugin-identity');
    check('host-source-label-is-separate-from-author-controlled-text',sourceIdentity.querySelector('.plugin-author').textContent==='Token Monitor · Official'&&sourceIdentity.querySelector('.plugin-origin-label').textContent==='settings.plugins.source.user'&&!sourceIdentity.querySelector('.plugin-author').contains(sourceIdentity.querySelector('.plugin-origin-label')));
    check('author-text-never-gets-a-trust-shield',!sourceIdentity.querySelector('.plugin-shield'));
    data.plugins[0].installation={origin:{kind:'community'}};await panel.refresh();
    check('community-author-cannot-spoof-official-shield',!box.querySelector('[data-plugin-id="alpha"] .plugin-shield')&&box.querySelector('[data-plugin-id="alpha"] .plugin-origin-label').textContent==='plugins.origin.community');
    data.plugins[0].installation={origin:{kind:'official'}};await panel.refresh();
    check('official-installed-identity-has-host-publisher-and-shield',Boolean(box.querySelector('[data-plugin-id="alpha"] .plugin-shield'))&&box.querySelector('[data-plugin-id="alpha"] .plugin-origin-official').textContent==='Token Monitor plugins.origin.official'&&!box.querySelector('[data-plugin-id="alpha"] .plugin-author'));
    delete data.plugins[0].installation;
    data.plugins[0].views[0].placements={home:true,page:false,tray:true};
    data.plugins[0].views[0].surfaces=['home','page','tray'];await panel.refresh();
    let locations=box.querySelector('.plugin-location-count');locations.focus({preventScroll:true});await tick();
    let locationTip=locations.querySelector('[role="tooltip"]');
    check('location-count-and-tooltip-list-selected-not-supported-surfaces',locations.firstChild.textContent==='2 locations'&&locationTip.textContent.includes('settings.plugins.surface.home')&&locationTip.textContent.includes('settings.plugins.surface.tray')&&!locationTip.textContent.includes('settings.plugins.surface.page')&&locations.getAttribute('aria-describedby')===locationTip.id);
    check('location-tooltip-opens-on-keyboard-focus-and-holds-refresh',locationTip.matches(':popover-open')&&panel.isInteracting(),{open:locationTip.matches(':popover-open'),hold:panel.isInteracting(),focus:document.activeElement.outerHTML});
    locations.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    check('location-tooltip-dismisses-with-escape',!locationTip.matches(':popover-open'));
    document.getElementById('outside').focus();locations.dispatchEvent(new PointerEvent('pointerenter'));await tick();
    check('location-tooltip-opens-on-pointer-hover',locationTip.matches(':popover-open')&&panel.isInteracting());
    locations.dispatchEvent(new PointerEvent('pointerleave'));check('location-tooltip-closes-on-pointer-leave',!locationTip.matches(':popover-open'));
    locations.focus({preventScroll:true});scroll.scrollTop=60;locations.click();await tick();
    check('location-count-opens-placement-settings-with-keyboard-focus',document.activeElement===box.querySelector('.plugin-views')&&Boolean(box.querySelector('.plugin-surface-chip')));
    box.querySelector('.plugin-surface-chip').click();await tick();
    box.querySelector('.plugin-back').click();await tick();
    check('placement-back-restores-count-focus-even-if-count-changes',document.activeElement===box.querySelector('.plugin-location-count')&&scroll.scrollTop===60&&document.activeElement.firstChild.textContent==='1 locations');
    data.plugins[0].status='disabled';data.plugins[0].enabled=false;await panel.refresh();box.querySelector('.plugin-location-count').click();await tick();
    check('disabled-plugin-preserves-readable-selected-locations',Boolean(box.querySelector('.plugin-views'))&&!box.querySelector('.plugin-surface-chip')&&box.querySelector('.plugin-views').textContent.includes('settings.plugins.surface.tray'));
    box.querySelector('.plugin-back').click();data.plugins[0].status='active';data.plugins[0].enabled=true;data.plugins[0].views[0].placements={home:false};data.plugins[0].views[0].surfaces=['home','page'];await panel.refresh();
    check('zero-selected-locations-is-explicit',box.querySelector('.plugin-location-count').firstChild.textContent==='0 locations'&&box.querySelector('.plugin-location-count [role="tooltip"]').textContent==='plugins.ui.noPlacements');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=32;canvas.getContext('2d').fillRect(4,4,24,24);data.plugins[0].identityIcon=canvas.toDataURL('image/png');await panel.refresh();await tick();
    const artwork=box.querySelector('.plugin-identity-art img');
    check('author-PNG-renders-in-host-identity-slot',artwork?.complete&&artwork.naturalWidth===32&&artwork.getBoundingClientRect().width===26);
    data.plugins[0].identityIcon='data:image/png;base64,AAAA';await panel.refresh();await tick();
    check('undecodable-artwork-falls-back-without-empty-slot',!box.querySelector('.plugin-identity-art img')&&Boolean(box.querySelector('.plugin-identity-art svg')));
    delete data.plugins[0].identityIcon;await panel.refresh();
    const tab = id=>box.querySelector('[data-tab="'+id+'"]');
    const click = text=>[...box.querySelectorAll('button')].find(n=>n.textContent===text).click();
    catalogMode='deferred';catalogCalls=0;
    scroll.scrollTop=60;
    const official=tab('discover');official.focus({preventScroll:true});const y=official.getBoundingClientRect().y;
    official.click();const during={y:official.getBoundingClientRect().y,focus:document.activeElement===official,connected:official.isConnected};
    official.click();tab('installed').click();
    check('pending-navigation-keeps-node-position-focus-and-one-request',during.y===y&&during.focus&&during.connected&&catalogCalls===1,{during,y,catalogCalls});
    scroll.scrollTop=70;pending(catalog);await tick();
    check('completion-retains-navigation-and-current-scroll',official===tab('discover')&&document.activeElement===official&&scroll.scrollTop===70&&official.getAttribute('aria-selected')==='true',{scroll:scroll.scrollTop});
    tab('installed').click();await tick();
    const community=tab('discover');community.focus({preventScroll:true});community.click();reject(Error('offline'));await tick();
    check('failed-tab-load-keeps-current-page-and-focus',tab('installed').getAttribute('aria-selected')==='true'&&document.activeElement===community&&box.querySelector('.plugin-action-error')?.textContent==='offline');
    community.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    check('keyboard-navigation-with-labelled-panel',document.activeElement===tab('installed')&&tab('installed').tabIndex===0&&[...box.querySelectorAll('[role="tab"]')].filter(n=>n.tabIndex===0).length===1&&box.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby')===tab('installed').id&&box.querySelector('[role="tablist"]')!==null);
    catalogMode='success';tab('installed').click();await tick();
    check('installed-cards-have-no-folds-pages-or-redundant-normal-status',!box.querySelector('.plugin-installed-card details, .plugin-installed-card .plugin-page-actions, .plugin-installed-card .plugin-status')&&box.querySelectorAll('.plugin-manage').length===2);
    let manage=box.querySelector('.plugin-manage');manage.focus({preventScroll:true});scroll.scrollTop=60;manage.click();await tick();
    check('settings-opens-dedicated-detail-with-back-focus',Boolean(box.querySelector('.plugin-detail'))&&!box.querySelector('.plugin-installed-card')&&document.activeElement===box.querySelector('.plugin-back')&&Boolean(box.querySelector('.plugin-page-actions')));
    let chip=box.querySelector('.plugin-surface-chip');chip.focus({preventScroll:true});scroll.scrollTop=100;chip.click();await tick();
    chip=box.querySelector('.plugin-surface-chip');
    check('placement-retains-logical-focus-scroll-and-detail',chip===document.activeElement&&chip.getAttribute('aria-pressed')==='true'&&scroll.scrollTop===100&&Boolean(box.querySelector('.plugin-detail')),{scroll:scroll.scrollTop,calls});
    box.querySelector('.plugin-diagnostics').click();await tick();
    check('diagnostics-shows-runtime-and-logs-outside-list',Boolean(box.querySelector('.plugin-log-lines'))&&Boolean(box.querySelector('.plugin-runtime'))&&!box.querySelector('.plugin-views'));
    click('plugins.ui.toSettings');await tick();
    check('diagnostics-return-restores-settings-entry-focus',document.activeElement===box.querySelector('.plugin-diagnostics')&&Boolean(box.querySelector('.plugin-views')));
    box.querySelector('.plugin-back').click();await tick();
    check('back-restores-list-position-and-logical-focus',document.activeElement===box.querySelector('.plugin-manage')&&scroll.scrollTop===60&&!box.querySelector('.plugin-detail'));
    const toggle=box.querySelector('.plugin-enable');toggle.focus({preventScroll:true});toggle.click();await tick();
    check('disable-does-not-reorder-plugin-or-lose-focus',[...box.querySelectorAll('[data-plugin-id]')].map(n=>n.dataset.pluginId).join(',')==='alpha,beta'&&document.activeElement===box.querySelector('.plugin-enable'));
    box.querySelector('.plugin-enable').click();await tick();
    check('trusted-unchanged-enable-skips-consent',data.plugins[0].enabled&&!box.querySelector('.plugin-consent'));
    box.querySelector('.plugin-enable').click();await tick();data.plugins[0].trusted=false;await panel.refresh();
    box.querySelector('.plugin-enable').click();await tick();
    check('changed-revision-still-requires-consent',Boolean(box.querySelector('.plugin-consent'))&&!data.plugins[0].enabled);
    click('settings.plugins.cancel');await tick();box.querySelector('.plugin-back').click();await tick();
    tab('discover').click();await tick();
    check('catalog-shares-identity-layout-with-no-inline-version-folds',Boolean(box.querySelector('.plugin-catalog .plugin-identity-art'))&&!box.querySelector('.plugin-catalog details'));
    box.querySelector('.plugin-toolbar > .plugin-inline-action').click();await tick();
    check('cancel-file-import-keeps-discover',tab('discover').getAttribute('aria-selected')==='true'&&!box.querySelector('.plugin-package-preview')&&calls.at(-1)?.[1]==='file');
    importResult={token:'local-file',id:'local-demo',name:'Local demo',description:'Private package',version:'1.0.0',types:['widget','page'],origin:{id:'local',kind:'local'},operation:'install',sha256:'abc'};
    box.querySelector('.plugin-toolbar > .plugin-inline-action').click();await tick();
    check('file-import-from-discover-opens-local-preview-in-installed',tab('installed').getAttribute('aria-selected')==='true'&&box.querySelector('.plugin-package-preview .plugin-types')?.textContent==='plugins.type.widgetplugins.type.page'&&box.querySelector('.plugin-package-preview .plugin-description')?.textContent==='Private package');
    click('settings.plugins.cancel');await tick();importResult=null;tab('discover').click();await tick();

    catalog.entries[0].installedVersion='1.0.0';catalog.entries[0].status='installed';await panel.refresh();
    check('discover-shows-bundled-without-custom-sources',box.querySelectorAll('[data-catalog-id]').length===1&&box.querySelector('.plugin-type')?.textContent==='plugins.type.page'&&!box.querySelector('.plugin-source-route'));
    catalog.entries.push({id:'third-party',name:'Third party',description:'Custom listing',version:'1.0.0',types:['appearance'],origin:{id:'custom',kind:'community',label:'Example source'},status:'incompatible'});await panel.refresh();
    check('discover-combines-origins-with-distinct-attribution',box.querySelectorAll('[data-catalog-id]').length===2&&box.querySelector('[data-catalog-id="third-party"] .plugin-origin-note')?.textContent==='Example source'&&!box.querySelector('[data-catalog-id="third-party"] .plugin-shield'));
    check('incompatible-card-explains-unavailability',box.querySelector('[data-catalog-id="third-party"] .plugin-card-meta').textContent.includes('plugins.catalog.incompatible'));
    box.querySelector('[data-catalog-id="third-party"] .plugin-catalog-title').click();await tick();
    check('incompatible-details-explain-unavailability-without-install',box.querySelector('dialog footer .plugin-risk')?.textContent==='plugins.catalog.incompatible'&&!box.querySelector('dialog .plugin-allow'));
    box.querySelector('.plugin-dialog-close').click();await tick();
    catalog.sources=[{id:'custom',kind:'community',label:'Cached source',nextError:'request failed'},{id:'empty',kind:'community',label:'Empty source',nextError:'invalid catalog'},{id:'healthy',kind:'community',label:'Healthy source'}];await panel.refresh();
    box.querySelector('.plugin-catalog-refresh button').click();await tick();
    check('discover-shows-each-returned-source-error-and-keeps-cached-entries',box.querySelector('.plugin-catalog').textContent.includes('Cached source: request failed')&&box.querySelector('.plugin-catalog').textContent.includes('Empty source: invalid catalog')&&box.querySelectorAll('[data-catalog-id]').length===2&&calls.filter(c=>c[0]==='refreshSource').length===3);
    await panel.refresh();
    check('discover-retains-source-errors-on-panel-refresh',box.querySelector('.plugin-catalog').textContent.includes('Cached source: request failed'));
    for(const source of catalog.sources)source.nextError='';box.querySelector('.plugin-catalog-refresh button').click();await tick();
    check('discover-clears-source-errors-after-successful-refresh',!box.querySelector('.plugin-catalog').textContent.includes('request failed')&&!box.querySelector('.plugin-catalog').textContent.includes('invalid catalog'));
    catalog.sources=[];
    const search=box.querySelector('.plugin-catalog-search');search.value='third party';search.dispatchEvent(new Event('input'));
    check('discover-search-spans-all-origins',box.querySelectorAll('[data-catalog-id]').length===1&&box.querySelector('[data-catalog-id="third-party"]'));
    search.value='';search.dispatchEvent(new Event('input'));catalog.entries.pop();await panel.refresh();
    const installedLink=box.querySelector('.plugin-installed-check');
    check('catalog-installed-check-uses-success-color-and-retains-navigation',Boolean(installedLink)&&installedLink.textContent==='plugins.catalog.installed'&&getComputedStyle(installedLink).color!=='rgba(0, 0, 0, 0)');
    installedLink.click();await tick();check('installed-check-navigates-to-installed-list',Boolean(box.querySelector('.plugin-installed-card')));
    delete catalog.entries[0].installedVersion;catalog.entries[0].status='available';tab('discover').click();await tick();

    click('plugins.package.install');await tick();
    check('catalog-install-opens-version-and-consent-review',Boolean(box.querySelector('.plugin-catalog-review .plugin-package-preview'))&&box.querySelectorAll('.plugin-catalog-review details').length===1);
    let select=box.querySelector('.plugin-version-picker select');select.focus({preventScroll:true});select.value='2.0.0';select.dispatchEvent(new Event('change'));await tick();
    check('version-change-replaces-token-and-retains-review-focus',document.activeElement===box.querySelector('.plugin-version-picker select')&&document.activeElement.value==='2.0.0'&&calls.some(c=>c[0]==='cancel'&&c[1]==='token-1.0.0')&&box.querySelector('.plugin-package-preview .plugin-version').textContent==='2.0.0');
    previewMode='error';select=box.querySelector('.plugin-version-picker select');select.value='1.0.0';select.dispatchEvent(new Event('change'));await tick();
    check('failed-version-preview-removes-stale-install-consent',!box.querySelector('.plugin-package-preview')&&box.querySelector('.plugin-catalog-review .plugin-action-error')?.textContent==='preview rejected'&&calls.some(c=>c[0]==='cancel'&&c[1]==='token-2.0.0'));
    click('plugins.ui.backCatalog');await tick();previewMode='success';
    catalog.entries[0].version='2.0.0';await panel.refresh();
    click('plugins.package.install');await tick();
    check('card-reentry-retains-selected-old-version-and-preview',box.querySelector('.plugin-version-picker select').value==='1.0.0'&&box.querySelector('.plugin-package-preview .plugin-version').textContent==='1.0.0'&&calls.at(-1)[1]==='1.0.0');
    click('plugins.ui.backCatalog');await tick();box.querySelector('.plugin-catalog-title').click();await tick();box.querySelector('dialog .plugin-allow').click();await tick();
    check('detail-reentry-retains-selected-old-version-and-preview',box.querySelector('.plugin-version-picker select').value==='1.0.0'&&box.querySelector('.plugin-package-preview .plugin-version').textContent==='1.0.0');
    click('plugins.ui.backCatalog');await tick();catalog.entries[0].versions[0].installable=false;await panel.refresh();click('plugins.package.install');await tick();
    check('unavailable-remembered-version-falls-back-to-current-installable-version',box.querySelector('.plugin-version-picker select').value==='2.0.0'&&box.querySelector('.plugin-package-preview .plugin-version').textContent==='2.0.0');
    click('plugins.ui.backCatalog');await tick();catalog.entries[0].versions[0].installable=true;catalog.entries[0].version='1.0.0';await panel.refresh();
    box.querySelector('.plugin-toolbar .plugin-more').click();await tick();click('plugins.catalog.sources');await tick();
    check('sources-open-as-route-without-nested-disclosures',Boolean(box.querySelector('.plugin-sources .plugin-source-form'))&&!box.querySelector('.plugin-sources details')&&document.activeElement===box.querySelector('.plugin-back'));
    const sourceUrl=box.querySelector('.plugin-source-form input');sourceUrl.value='https://example.test/catalog.json';sourceUrl.dispatchEvent(new Event('input'));click('plugins.ui.backCatalog');await tick();
    check('sources-back-restores-advanced-trigger-focus',document.activeElement===box.querySelector('.plugin-toolbar .plugin-more'));
    box.querySelector('.plugin-toolbar .plugin-more').click();await tick();click('plugins.catalog.sources');await tick();
    check('source-route-retains-unsaved-input',box.querySelector('.plugin-source-form input').value==='https://example.test/catalog.json');
    tab('installed').click();await tick();
    box.querySelector('.plugin-toolbar .plugin-more').click();await tick();
    check('developer-actions-use-accessible-popover',Boolean(box.querySelector('.plugin-menu:popover-open'))&&box.querySelector('.plugin-more').getAttribute('aria-expanded')==='true'&&document.activeElement===box.querySelector('.plugin-menu input'));
    const menu=box.querySelector('.plugin-menu:popover-open'), menuTrigger=box.querySelector('.plugin-toolbar .plugin-more');
    const reference=document.createElement('div');reference.className='select-control-popup';document.body.append(reference);
    const sharedSurface=()=>['backgroundColor','backgroundImage','backdropFilter','borderRadius','boxShadow'].every(k=>getComputedStyle(menu)[k]===getComputedStyle(reference)[k]);
    document.documentElement.style.setProperty('--bg','transparent');
    check('action-menu-reuses-host-plate-with-transparent-app-background',sharedSurface()&&getComputedStyle(menu).backgroundColor!=='rgba(0, 0, 0, 0)'&&getComputedStyle(menu).backdropFilter.includes('blur'));
    document.documentElement.classList.add('native-liquid-glass');
    check('action-menu-reuses-native-glass-plate',sharedSurface());
    document.documentElement.classList.remove('native-liquid-glass');document.documentElement.style.removeProperty('--bg');reference.remove();
    menu.hidePopover();await tick();menuTrigger.focus({preventScroll:true});menuTrigger.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));await tick();
    check('pointer-open-does-not-auto-select-master-row',document.activeElement===menuTrigger&&getComputedStyle(menu.querySelector('.plugin-global-switch')).backgroundColor==='rgba(0, 0, 0, 0)');
    menuTrigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));await tick();
    check('arrow-down-enters-menu-after-pointer-open',document.activeElement===menu.querySelector('input'));
    const menuItems=[...menu.querySelectorAll('input, button')];
    for(const [key,index] of [['End',4],['ArrowUp',3],['Home',0],['ArrowDown',1]]){menu.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));check('action-menu-key-'+key,document.activeElement===menuItems[index]);}
    menu.hidePopover();await tick();const menuWrap=menuTrigger.parentElement, menuParent=menuWrap.parentElement;document.body.append(menuWrap);menuTrigger.style.position='fixed';menuTrigger.style.bottom='8px';menuTrigger.style.right='8px';menuTrigger.click();await tick();
    check('action-menu-flips-above-bottom-trigger',menu.getBoundingClientRect().bottom<=menuTrigger.getBoundingClientRect().top&&menu.getBoundingClientRect().left>=8&&menu.getBoundingClientRect().right<=innerWidth-8,{menu:menu.getBoundingClientRect().toJSON(),trigger:menuTrigger.getBoundingClientRect().toJSON()});
    menu.hidePopover();await tick();menuParent.append(menuWrap);menuTrigger.style.cssText='';menuTrigger.click();await tick();
    click('settings.plugins.openFolder');await tick();
    check('popover-action-closes-and-executes-once',!box.querySelector('.plugin-menu:popover-open')&&calls.filter(c=>c[0]==='folder').length===1);
    check('more-trigger-is-svg-library-mask-not-text-dots',Boolean(box.querySelector('.plugin-toolbar .plugin-more-icon'))&&getComputedStyle(box.querySelector('.plugin-toolbar .plugin-more-icon')).maskImage.includes('ellipsis.svg')&&box.querySelector('.plugin-toolbar .plugin-more').textContent==='');
    const openGlobal=async()=>{box.querySelector('.plugin-toolbar .plugin-more').click();await tick();return box.querySelector('.plugin-menu input[role="switch"]')};
    let global=await openGlobal();
    check('global-switch-uses-shared-settings-control',global.checked&&global.closest('label').textContent==='settings.plugins.enableAll'&&getComputedStyle(global).appearance==='none'&&document.activeElement===global);
    const cardGap=()=>box.querySelector('.plugin-card').getBoundingClientRect().top-box.querySelector('.plugin-toolbar').getBoundingClientRect().bottom;
    const enabledGap=cardGap(), toolbarHeight=box.querySelector('.plugin-toolbar').getBoundingClientRect().height;
    const choices=JSON.stringify(data.plugins.map(p=>[p.id,p.enabled]));global.click();await tick();
    check('pause-status-stays-in-toolbar-without-moving-cards',box.querySelector('.plugin-toolbar-count')?.contains(box.querySelector('.plugin-paused'))&&Math.abs(cardGap()-enabledGap)<1&&box.querySelector('.plugin-toolbar').getBoundingClientRect().height===toolbarHeight,{before:enabledGap,after:cardGap()});
    check('global-off-persists-once-and-preserves-individual-selections',!data.enabled&&calls.filter(c=>c[0]==='global').length===1&&JSON.stringify(data.plugins.map(p=>[p.id,p.enabled]))===choices&&box.querySelector('.plugin-toolbar-count[role="status"]')?.getAttribute('aria-label').endsWith('plugins.ui.paused')&&box.querySelector('.plugin-paused')?.textContent==='plugins.ui.pausedShort'&&box.querySelector('[data-plugin-id="alpha"] input').disabled);
    global=await openGlobal();check('paused-switch-remains-reachable',!global.checked&&!global.disabled);global.click();await tick();
    check('resume-restores-saved-plugin-choices',data.enabled&&!box.querySelector('.plugin-paused')&&!box.querySelector('[data-plugin-id="alpha"] input').disabled&&JSON.stringify(data.plugins.map(p=>[p.id,p.enabled]))===choices&&calls.filter(c=>c[0]==='global').length===2);
    globalMode='error';global=await openGlobal();global.click();await tick();global=await openGlobal();
    check('failed-global-save-restores-authoritative-switch-and-focus',global.checked&&data.enabled&&!box.querySelector('.plugin-paused')&&box.querySelector('.plugin-action-error')?.textContent==='settings write failed'&&document.activeElement===global);
    globalMode='success';global.closest('.plugin-menu').hidePopover();data.safeMode=true;data.enabled=false;await panel.refresh();global=await openGlobal();
    check('safe-mode-master-reflects-saved-intent-not-runtime',global.checked&&savedMasterEnabled&&!data.enabled&&Boolean(box.querySelector('.plugin-paused'))&&box.querySelector('[data-plugin-id="alpha"] input').disabled);
    global.click();await tick();global=await openGlobal();
    check('safe-mode-can-persist-master-off',!global.checked&&!savedMasterEnabled&&!data.enabled&&calls.filter(c=>c[0]==='global').at(-1)[1]===false);
    data.safeMode=false;data.enabled=savedMasterEnabled;await panel.refresh();global=await openGlobal();
    check('leaving-safe-mode-retains-master-off',!global.checked&&!data.enabled&&Boolean(box.querySelector('.plugin-paused')));
    data.safeMode=true;await panel.refresh();global=await openGlobal();global.click();await tick();global=await openGlobal();
    check('safe-mode-still-blocks-runtime-when-master-on',global.checked&&savedMasterEnabled&&!data.enabled&&Boolean(box.querySelector('.plugin-paused'))&&box.querySelector('[data-plugin-id="alpha"] input').disabled);
    data.safeMode=false;data.enabled=savedMasterEnabled;await panel.refresh();await openGlobal();click('plugins.ui.about');await tick();
    check('authoring-is-secondary-route-with-focused-back',Boolean(box.querySelector('.plugin-about'))&&box.querySelector('.plugin-about p').textContent==='plugins.authoring.intro'&&document.activeElement===box.querySelector('.plugin-back'));
    const prompt=box.querySelector('.plugin-author-prompt');
    check('authoring-prompt-is-labelled-selectable-and-readonly',prompt.readOnly&&prompt.value==='Fixture prompt with exact punctuation:'&&prompt.getAttribute('aria-label')==='plugins.authoring.label'&&prompt.getBoundingClientRect().height>=220);
    box.querySelector('.plugin-copy-prompt').click();await tick();
    check('copy-uses-exact-visible-prompt-and-local-success-status',calls.at(-1)?.[0]==='copy'&&calls.at(-1)?.[1]===prompt.value&&box.querySelector('.plugin-copy-status[role="status"]').textContent==='plugins.authoring.copied');
    copyFailure=true;box.querySelector('.plugin-copy-prompt').click();await tick();
    check('clipboard-failure-selects-prompt-for-manual-copy',document.activeElement===prompt&&prompt.selectionStart===0&&prompt.selectionEnd===prompt.value.length&&box.querySelector('.plugin-copy-status').textContent==='plugins.authoring.copyFallback'&&!box.querySelector('.plugin-action-error'));copyFailure=false;
    box.querySelector('.plugin-about .plugin-guide-link').click();await tick();
    check('author-guide-uses-host-external-route',calls.at(-1)?.[0]==='guide'&&calls.at(-1)?.[1]==='https://javis-ai.com/token-monitor/docs/plugin-quickstart.html?lang=en');
    box.querySelector('.plugin-back').click();await tick();check('about-back-restores-more-trigger-focus',document.activeElement===box.querySelector('.plugin-toolbar .plugin-more'));
    check('removed-style-editor-has-no-tab-or-controls',!tab('style')&&!box.querySelector('.plugin-style-form')&&box.querySelectorAll('[role=tab]').length===2);
    tab('installed').click();await tick();catalogMode='deferred';tab('discover').focus();tab('discover').click();document.getElementById('outside').focus();pending(catalog);await tick();
    check('completion-does-not-steal-external-focus',document.activeElement.id==='outside');
    catalogMode='success';document.getElementById('after').style.display='none';scroll.style.height='400px';
    tab('installed').click();await tick();scroll.scrollTop=120;
    const shortTab=tab('discover');shortTab.focus({preventScroll:true});const shortTabY=shortTab.getBoundingClientRect().y, shortScroll=scroll.scrollTop;
    shortTab.click();await tick();
    check('short-tab-keeps-rail-position-without-downstream-spacer',scroll.scrollTop===shortScroll&&shortTab.getBoundingClientRect().y===shortTabY,{before:shortScroll,after:scroll.scrollTop,beforeY:shortTabY,afterY:shortTab.getBoundingClientRect().y});
    catalog.entries[0].versions.push({version:'3.0.0',compatible:true,installable:true,changelog:'Version three',updateNotes:[]});
    click('plugins.package.install');await tick();previewMode='deferred';
    let rapid=box.querySelector('.plugin-version-picker select');rapid.focus({preventScroll:true});rapid.value='2.0.0';rapid.dispatchEvent(new Event('change'));await tick();
    rapid.value='3.0.0';rapid.dispatchEvent(new Event('change'));
    let resolvePreview=previewPending;previewPending=null;resolvePreview();await tick();
    if(previewPending){resolvePreview=previewPending;previewPending=null;resolvePreview();await tick();}
    const rapidAligned=box.querySelector('.plugin-version-picker select').value==='3.0.0'&&box.querySelector('.plugin-package-preview .plugin-version').textContent==='3.0.0';
    box.querySelector('.plugin-allow').click();await tick();previewMode='success';
    check('rapid-version-changes-align-selection-preview-and-installed-token',rapidAligned&&calls.filter(c=>c[0]==='install').at(-1)?.[1]==='token-3.0.0',{lastInstall:calls.filter(c=>c[0]==='install').at(-1)});
    const pageShell=document.createElement('main');pageShell.className='shell plugin-page-mode title-icon-only';
    pageShell.innerHTML=${JSON.stringify(appHeader)};
    const pageBox=document.createElement('section');pageBox.id='pluginMainPanel';pageBox.className='plugin-main-panel';pageShell.append(pageBox);document.body.append(pageShell);
    window.tokenMonitorTrustedPlugins={views:async()=>({views:{}}),subscribe:()=>()=>{}};
    const demands=[], pageHost=TokenMonitorPluginViews.createPluginViewHost({document,window,t:k=>k,onDemand:(s,r)=>demands.push([s,r])});
    const headingContainer=pageShell.querySelector('#pluginPageHeading'),actionsContainer=pageShell.querySelector('#pluginPageActions');
    const pages=TokenMonitorPluginMainPages.create({document,container:pageBox,headingContainer,actionsContainer,host:pageHost,t:k=>k,openWindow:()=>{}});
    const routes=[{id:'plugin:alpha/view',ref:'alpha/view',title:'Alpha'},{id:'plugin:beta/view',ref:'beta/view',title:'Beta'}];
    const payload={surface:'page',views:Object.fromEntries(routes.map(route=>[route.ref,{id:'view',ref:route.ref,pluginId:route.ref.split('/')[0],revision:'test',status:'active',entry:'file://${scratch}/ui.mjs',css:[]}]))};
    pageHost.update(payload);pages.render(routes,'plugin:alpha/view');await tick();
    check('main-page-title-and-detach-use-native-header',headingContainer.querySelector('h2')?.textContent==='Alpha'&&Boolean(actionsContainer.querySelector('.plugin-main-detach'))&&!pageBox.querySelector('.plugin-main-detach'));
    const draft=pageBox.querySelector('input');draft.value='unsubmitted';
    pages.render(routes,'plugin:beta/view');await tick();pages.render(routes,'plugin:alpha/view');pageHost.update(payload);await tick();
    check('main-page-draft-survives-ordinary-page-switch-and-context-update',draft.isConnected&&draft.value==='unsubmitted'&&draft===pageBox.querySelector('input'));
    pages.render(routes.filter(p=>p.ref!=='alpha/view'),'home');
    check('removed-page-releases-retained-dom',!draft.isConnected&&pageBox.classList.contains('hidden'));
    await pageHost.dispose();pageShell.remove();
    // Network freshness must never hold the management UI or its drafts.
    const backgroundBox=document.createElement('div');document.body.append(backgroundBox);
    const backgroundCatalog={github:{enabled:true},entries:[{...catalog.entries[0],version:'1.0.0',status:'available'}],sources:Array.from({length:16},(_,i)=>({id:'source-'+i,kind:'community',label:'Source '+i}))};
    let finishDiscovery,discoveryCalls=0,activeSources=0,maxSources=0,sourceCalls=0;
    const waitingSources=[];
    const backgroundPanel=TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:backgroundBox,t:(key,args)=>key==='settings.plugins.actionFailed'?args.error:key,api:{
      list:async()=>({enabled:true,plugins:[]}),catalog:async()=>structuredClone(backgroundCatalog),
      discoverCatalog:()=>{discoveryCalls++;return new Promise(resolve=>{finishDiscovery=()=>resolve(structuredClone(backgroundCatalog))})},
      refreshSource:async id=>{sourceCalls++;activeSources++;maxSources=Math.max(maxSources,activeSources);try{await new Promise((resolve,reject)=>waitingSources.push({id,resolve,reject}))}finally{activeSources--}},
      catalogDetails:async()=>({html:'',imageCount:0}),
      closeCatalogDetails:async()=>{},
      catalogPreview:async(source,id,version)=>({token:'background-'+version,id,name:'Background package',version,origin:{id:source,kind:'community'},operation:'install',sha256:'abc'}),cancelInstall:async()=>{}
    }});
    const backgroundTab=id=>backgroundBox.querySelector('[data-tab="'+id+'"]');
    const backgroundClick=text=>[...backgroundBox.querySelectorAll('button')].find(n=>n.textContent===text).click();
    await backgroundPanel.refresh();backgroundTab('discover').click();await tick();
    check('discover-shows-cache-before-github-completes',backgroundTab('discover').getAttribute('aria-selected')==='true'&&Boolean(backgroundBox.querySelector('.plugin-card'))&&backgroundBox.getAttribute('aria-busy')==='false'&&discoveryCalls===1);
    backgroundTab('installed').click();await tick();backgroundTab('discover').click();await tick();
    check('pending-discovery-allows-navigation-and-coalesces-refresh',backgroundTab('discover').getAttribute('aria-selected')==='true'&&discoveryCalls===1);
    const backgroundSearch=backgroundBox.querySelector('.plugin-catalog-search');backgroundSearch.value='Example';backgroundSearch.dispatchEvent(new Event('input'));backgroundSearch.focus();backgroundSearch.setSelectionRange(2,2);
    backgroundCatalog.entries[0].description='Example refreshed';finishDiscovery();await tick();
    check('background-results-preserve-search-node-value-and-focus',backgroundSearch===backgroundBox.querySelector('.plugin-catalog-search')&&document.activeElement===backgroundSearch&&backgroundSearch.value==='Example'&&backgroundSearch.selectionStart===2&&backgroundBox.querySelector('.plugin-card .plugin-description').textContent==='Example refreshed');
    backgroundBox.querySelector('.plugin-catalog-refresh button').click();await tick();
    check('manual-refresh-bounds-custom-concurrency-without-blocking-github',activeSources===4&&maxSources===4&&discoveryCalls===2&&backgroundBox.getAttribute('aria-busy')==='false');
    backgroundClick('plugins.package.install');await tick();const backgroundPreview=backgroundBox.querySelector('.plugin-package-preview');
    check('package-review-stays-usable-during-network-refresh',Boolean(backgroundPreview)&&!backgroundPreview.querySelector('.plugin-allow').disabled);
    for(let wave=0;wave<4;wave++){
      for(const task of waitingSources.splice(0)){if(task.id==='source-0')task.reject(Error('IPC refresh failed'));else task.resolve()}
      await tick();
    }
    finishDiscovery();await tick();
    check('all-sources-refresh-after-one-ipc-failure-and-review-is-retained',sourceCalls===16&&maxSources===4&&backgroundBox.querySelector('.plugin-package-preview')===backgroundPreview);
    backgroundClick('plugins.ui.backCatalog');await tick();
    check('refresh-ipc-failure-is-visible-after-return',backgroundBox.querySelector('.plugin-catalog').textContent.includes('Source 0: IPC refresh failed')&&!backgroundBox.querySelector('.plugin-catalog-refresh button').disabled);
    backgroundTab('installed').click();await tick();backgroundTab('discover').click();await tick();
    const backgroundTitle=backgroundBox.querySelector('.plugin-catalog-title');backgroundTitle.focus();backgroundTitle.click();await tick();const backgroundDialog=backgroundBox.querySelector('dialog');
    backgroundCatalog.entries[0].description='Example after details';finishDiscovery();await tick();
    check('background-results-wait-for-open-details-to-close',backgroundBox.querySelector('.plugin-catalog-title')===backgroundTitle&&backgroundDialog.open);
    backgroundBox.querySelector('.plugin-dialog-close').click();await tick();
    check('closing-details-applies-fresh-results-and-restores-logical-focus',backgroundBox.querySelector('.plugin-card .plugin-description').textContent==='Example after details'&&document.activeElement===backgroundBox.querySelector('.plugin-catalog-title'));
    backgroundTab('installed').click();await tick();backgroundTab('discover').click();await tick();
    backgroundPanel.dispose();const disposedContent=backgroundBox.innerHTML;finishDiscovery();await tick();
    check('disposed-panel-ignores-late-catalog-completion',backgroundBox.innerHTML===disposedContent);backgroundBox.remove();
    const presetBox=document.createElement('div');document.body.append(presetBox);let presetDiscoverCalls=[];
    const presetData={entries:[],sources:[{id:'maintainer-fixture',kind:'maintainer',cached:false}],github:{enabled:false,entries:[]}};
    const presetPanel=TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:presetBox,t:key=>key,api:{
      list:async()=>({enabled:true,plugins:[]}),catalog:async()=>presetData,
      discoverCatalog:async force=>{presetDiscoverCalls.push(force);presetData.sources[0].cached=true;return presetData}
    }});
    await presetPanel.refresh();presetBox.querySelector('[data-tab="discover"]').click();await tick();
    check('maintainer-source-bootstraps-with-public-github-disabled',presetDiscoverCalls.length===1&&presetDiscoverCalls[0]===false);
    presetBox.querySelector('.plugin-catalog-refresh button').click();await tick();
    check('maintainer-only-refresh-checks-preset-source',presetDiscoverCalls.length===2&&presetDiscoverCalls[1]===true);
    presetPanel.dispose();presetBox.remove();
    const officialBox=document.createElement('div');document.body.append(officialBox);
    let officialPreview={id:'official-fixture',name:'Official fixture',version:'1.0.0',token:'official-token',operation:'install',origin:{id:'bundled',kind:'official'},sha256:'abc'};
    const officialList={enabled:true,plugins:[]};const officialActions=[];
    const officialCatalog={entries:[],sources:[],github:{enabled:false,entries:[{id:'cached/external',name:'Hidden cached repo',origin:{id:'github-discovery',kind:'community'}}]}};
    const officialPanel=TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:officialBox,t:key=>key,api:{
      list:async()=>officialList,catalog:async()=>officialCatalog,discoverCatalog:()=>{throw Error('disabled discovery reached')},
      importPackage:async()=>officialPreview,cancelInstall:async()=>{},install:async(token,options)=>{officialActions.push({token,options});return officialList},
      setEnabled:async(id,enabled)=>{officialActions.push({id,enabled});officialList.plugins[0].enabled=enabled;officialList.plugins[0].trusted=true;return officialList}
    }});
    const officialClick=text=>[...officialBox.querySelectorAll('button')].find(n=>n.textContent===text).click();
    await officialPanel.refresh();officialBox.querySelector('[data-tab="discover"]').click();await tick();
    check('disabled-public-discovery-hides-section-cached-repos-and-unused-refresh',!officialBox.textContent.includes('plugins.catalog.github')&&!officialBox.textContent.includes('Hidden cached repo')&&!officialBox.textContent.includes('plugins.catalog.lastChecked')&&!officialBox.querySelector('.plugin-catalog-refresh'));
    officialClick('plugins.package.import');await tick();
    check('official-install-has-simple-copy-and-explicit-action',officialBox.querySelector('.plugin-allow').textContent==='plugins.package.installEnable'&&!officialBox.querySelector('.plugin-package-preview .plugin-risk')&&officialBox.textContent.includes('plugins.package.officialInstall'));
    officialClick('plugins.package.installEnable');await tick();
    check('official-install-still-approves-exact-preview-token',officialActions.at(-1).token==='official-token'&&officialActions.at(-1).options.trustInstall===true&&officialActions.at(-1).options.trustUpdate===false);
    officialPreview.operation='update';officialPreview.token='update-token';officialClick('plugins.package.import');await tick();
    check('official-update-has-simple-copy',officialBox.querySelector('.plugin-allow').textContent==='plugins.package.update'&&!officialBox.querySelector('.plugin-package-preview .plugin-risk'));
    officialClick('plugins.package.update');await tick();
    check('official-update-still-approves-exact-revision',officialActions.at(-1).token==='update-token'&&officialActions.at(-1).options.trustUpdate===true);
    officialPreview.operation='install';officialList.enabled=false;await officialPanel.refresh();officialClick('plugins.package.import');await tick();
    check('official-master-off-install-stays-off',officialBox.querySelector('.plugin-allow').textContent==='plugins.package.installOnly'&&officialBox.textContent.includes('plugins.package.officialEnableLater'));
    officialClick('plugins.package.installOnly');await tick();check('official-master-off-does-not-grant-trust',officialActions.at(-1).options.trustInstall===false);
    officialList.enabled=true;officialPreview.origin={id:'custom',kind:'community'};await officialPanel.refresh();officialClick('plugins.package.import');await tick();
    check('community-package-retains-trust-warning-and-action',officialBox.querySelector('.plugin-allow').textContent==='plugins.package.trustInstall'&&officialBox.querySelector('.plugin-package-preview .plugin-risk')?.textContent==='plugins.trusted.warning');
    officialClick('settings.plugins.cancel');await tick();
    officialPreview.origin={id:'maintainer-fixture',kind:'maintainer'};await officialPanel.refresh();officialClick('plugins.package.import');await tick();
    check('maintainer-package-uses-simple-action-and-shield',officialBox.querySelector('.plugin-allow').textContent==='plugins.package.installEnable'&&!officialBox.querySelector('.plugin-package-preview .plugin-risk')&&Boolean(officialBox.querySelector('.plugin-package-preview .plugin-shield')));
    officialClick('settings.plugins.cancel');await tick();
    officialList.plugins=[{id:'official-fixture',name:'Official fixture',version:'1.0.0',source:'user',status:'needsApproval',enabled:false,trusted:false,installation:{origin:{kind:'official'}},views:[]}];await officialPanel.refresh();
    check('official-pending-revision-uses-enable-labels',officialBox.querySelector('.plugin-manage').textContent==='settings.plugins.enable'&&officialBox.querySelector('.plugin-status').textContent==='plugins.package.enableRequired');
    officialBox.querySelector('.plugin-enable').click();await tick();
    check('official-enable-confirmation-uses-simple-copy',officialBox.querySelector('.plugin-allow').textContent==='settings.plugins.enable'&&!officialBox.querySelector('.plugin-consent .plugin-risk'));
    officialClick('settings.plugins.enable');await tick();check('official-enable-remains-explicit',officialActions.at(-1).id==='official-fixture'&&officialActions.at(-1).enabled===true);
    officialPanel.dispose();officialBox.remove();
    // New discovery details remain inert until explicit package review.
    catalogMode='success';
    let imageResolve;
    const detailsBox=document.createElement('div');document.body.append(detailsBox);
    const shot=canvas.toDataURL('image/png');
    const officialEntry={...catalog.entries[0],id:'official-detail',name:'Official detail',author:'Hidden credit',origin:{id:'official',kind:'official'},repository:'https://github.com/owner/repo'};
    const maintainerEntry={...officialEntry,id:'maintainer-detail',name:'Maintainer detail',origin:{id:'maintainer-fixture',kind:'maintainer'},installedVersion:'0.9.0'};
    const customEntry={...officialEntry,id:'custom-detail',author:'Token Monitor 社群',origin:{id:'custom-fixture',kind:'community',label:'Token Monitor 官方'},featured:true,official:true};
    const repoEntry={id:'owner/repo',name:'Community repo',author:'owner',description:'Repository',origin:{id:'github-discovery',kind:'community'},status:'repository',stars:42};
    let shotCalls=0,readmeCalls=0,closeCalls=0,longReadme=false;
    const detailsPanel=TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:detailsBox,t:key=>key,api:{
      list:async()=>({enabled:true,plugins:[]}),catalog:async()=>({entries:[maintainerEntry,customEntry,officialEntry],github:{enabled:true,entries:[repoEntry],lastFetched:1700000000000},sources:[]}),
      closeCatalogDetails:async()=>{closeCalls++},
      catalogReadmeImage:()=>{shotCalls++;return new Promise(resolve=>{imageResolve=resolve})},
      catalogDetails:async()=>{readmeCalls++;return {documentId:'fixture',imageCount:longReadme?3:1,html:longReadme?'<p><span data-readme-image="0">First</span></p><div style="height:2000px"></div><p><span data-readme-image="1">Second</span></p><p><span data-readme-image="2">Third</span></p>':'<h1>README heading</h1><p>Before image.</p><p><span data-readme-image="0" aria-label="Author image"></span></p><p>After image.</p>&lt;script&gt;untrusted&lt;/script&gt;'}}
    }});
    await detailsPanel.refresh();detailsBox.querySelector('[data-tab="discover"]').click();await tick();
    const refreshButton=detailsBox.querySelector('.plugin-catalog-refresh button').getBoundingClientRect(),refreshTime=detailsBox.querySelector('.plugin-catalog-refresh .settings-note').getBoundingClientRect();
    check('catalog-refresh-time-aligns-with-button',Math.abs(refreshButton.y+refreshButton.height/2-refreshTime.y-refreshTime.height/2)<1);
    check('details-media-is-lazy-and-official-credit-hidden',shotCalls===0&&!detailsBox.textContent.includes('Hidden credit'));
    check('official-card-shows-host-publisher-community-card-shows-owner-only',detailsBox.querySelector('[data-catalog-id="official-detail"] .plugin-origin-official')?.textContent==='Token Monitor plugins.origin.official'&&Boolean(detailsBox.querySelector('[data-catalog-id="official-detail"] .plugin-shield'))&&detailsBox.querySelector('[data-catalog-id="owner/repo"] .plugin-source')?.textContent==='owner');
    check('github-stars-only-on-community-card',detailsBox.querySelector('[data-catalog-id="owner/repo"] .plugin-stars')?.textContent.includes('42')&&!detailsBox.querySelector('[data-catalog-id="official-detail"] .plugin-stars'));
    check('featured-group-official-first-and-installed-maintainer-keeps-position',JSON.stringify([...detailsBox.querySelector('.plugin-catalog-group').querySelectorAll('[data-catalog-id]')].map(n=>n.dataset.catalogId))===JSON.stringify(['official-detail','maintainer-detail'])&&detailsBox.querySelector('.plugin-catalog-group h3').textContent==='plugins.catalog.featured');
    check('maintainer-shield-brand-hides-personal-credit',detailsBox.querySelector('[data-catalog-id="maintainer-detail"] .plugin-source')?.textContent==='Token Monitor plugins.origin.maintainer'&&Boolean(detailsBox.querySelector('[data-catalog-id="maintainer-detail"] .plugin-shield')));
    check('custom-title-author-flags-cannot-get-shield-or-featured-group',!detailsBox.querySelector('[data-catalog-id="custom-detail"] .plugin-shield')&&detailsBox.querySelector('[data-catalog-id="custom-detail"]').closest('section').querySelector('h3').textContent==='plugins.catalog.custom');
    const title=detailsBox.querySelector('[data-catalog-id="official-detail"] .plugin-catalog-title');title.focus();title.click();await tick();
    const dialog=detailsBox.querySelector('dialog');
    check('official-detail-shows-same-host-publisher',dialog.querySelector('.plugin-origin-official')?.textContent==='Token Monitor plugins.origin.official'&&Boolean(dialog.querySelector('.plugin-shield')));
    check('details-opens-with-version-before-types',dialog.open&&dialog.querySelector('.plugin-card-meta').firstChild.className==='plugin-version');
    await new Promise(r=>setTimeout(r,80));
    check('official-visible-readme-images-load-automatically-once',!dialog.querySelector('.plugin-readme-load')&&shotCalls===1);
    imageResolve(shot);await tick();
    check('small-readme-image-keeps-intrinsic-width',dialog.querySelector('.plugin-screenshot img')?.getBoundingClientRect().width===32);
    dialog.querySelector('.plugin-screenshot').click();await tick();
    check('image-opens-above-parent-details',detailsBox.querySelectorAll('dialog[open]').length===2);
    detailsBox.querySelector('.plugin-image-dialog .plugin-dialog-close').click();await tick();
    check('image-close-keeps-parent-open',dialog.open&&detailsBox.querySelectorAll('dialog').length===1&&closeCalls===0);
    const rect=dialog.getBoundingClientRect();
    check('narrow-details-header-footer-fit',rect.left>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight&&dialog.querySelector('footer').getBoundingClientRect().bottom<=innerHeight);
    dialog.dispatchEvent(new PointerEvent('pointerdown',{clientX:0,clientY:0}));dialog.dispatchEvent(new MouseEvent('click',{clientX:0,clientY:0}));await tick();
    check('outside-dismiss-restores-title-focus',!dialog.isConnected&&document.activeElement===title&&closeCalls===1);
    title.click();await new Promise(r=>setTimeout(r,80));detailsBox.querySelector('.plugin-dialog-close').click();await tick();imageResolve(shot);await tick();
    check('late-image-cannot-resurrect-closed-details',!detailsBox.querySelector('dialog'));
    detailsBox.querySelector('[data-catalog-id="maintainer-detail"] .plugin-catalog-title').click();await new Promise(r=>setTimeout(r,80));
    check('maintainer-images-also-load-automatically',shotCalls===3&&!detailsBox.querySelector('.plugin-readme-load'));
    imageResolve(shot);await tick();detailsBox.querySelector('.plugin-dialog-close').click();await tick();
    detailsBox.querySelector('[data-catalog-id="owner/repo"] .plugin-catalog-title').click();await tick();
    check('github-detail-name-only-shows-owner',detailsBox.querySelector('dialog .plugin-source')?.textContent==='owner'&&!detailsBox.querySelector('dialog .plugin-shield'));
    check('repository-readme-preserves-markdown-order-and-inert-html',readmeCalls===4&&detailsBox.querySelector('.plugin-catalog-readme h1')?.textContent==='README heading'&&detailsBox.querySelector('.plugin-catalog-readme').textContent.includes('<script>untrusted</script>')&&!detailsBox.querySelector('.plugin-catalog-readme script'));
    check('third-party-images-still-require-explicit-load',Boolean(detailsBox.querySelector('.plugin-readme-load'))&&shotCalls===3);
    detailsBox.querySelector('.plugin-readme-load').click();await tick();
    check('third-party-click-starts-image-load',shotCalls===4);imageResolve(shot);await tick();
    detailsBox.querySelector('.plugin-dialog-close').click();await tick();
    detailsBox.querySelector('[data-catalog-id="custom-detail"] .plugin-catalog-title').click();await tick();
    check('spoofed-custom-author-still-needs-explicit-images',shotCalls===4&&Boolean(detailsBox.querySelector('.plugin-readme-load')));
    detailsBox.querySelector('.plugin-dialog-close').click();await tick();
    longReadme=true;title.click();await new Promise(r=>setTimeout(r,80));
    check('featured-offscreen-images-wait-for-scroll',shotCalls===5);
    imageResolve(shot);await new Promise(r=>setTimeout(r,80));
    check('featured-below-fold-not-fetched-after-first-image',shotCalls===5);
    const scrollBody=detailsBox.querySelector('.plugin-catalog-dialog-body');scrollBody.scrollTop=scrollBody.scrollHeight;await new Promise(r=>setTimeout(r,80));
    check('featured-scroll-starts-next-image-serially',shotCalls===6);
    detailsBox.querySelector('.plugin-dialog-close').click();await tick();imageResolve(shot);await tick();
    check('closing-featured-details-cancels-queued-offscreen-image',shotCalls===6&&!detailsBox.querySelector('dialog'));
    longReadme=false;
    title.click();await new Promise(r=>setTimeout(r,80));imageResolve(shot);await tick();detailsBox.querySelector('.plugin-screenshot').click();await tick();
    window.finishDetailsTest=()=>{detailsPanel.dispose();detailsBox.remove()};
    return {checks};
  })()`);
  for (let depth=1;depth>=0;depth--) {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await new Promise(r=>setTimeout(r,40));
    result.checks.push({name:'native-escape-details-depth-'+depth,ok:await win.webContents.executeJavaScript('document.querySelectorAll("dialog[open]").length === '+depth)});
  }
  await win.webContents.executeJavaScript('window.finishDetailsTest()');
  // Exercise Chromium's actual pointer/keyboard modality, not just synthetic DOM clicks.
  const point = await win.webContents.executeJavaScript(`(async()=>{
    document.querySelector('[data-tab="installed"]').click();
    await new Promise(r=>setTimeout(r,30));
    document.querySelector('.plugin-menu:popover-open')?.hidePopover();
    const trigger=document.querySelector('.plugin-toolbar .plugin-more');trigger.scrollIntoView({block:'center'});
    const r=trigger.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  for (const type of ['mouseMoved','mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});
  await new Promise(r=>setTimeout(r,40));
  const pointer = await win.webContents.executeJavaScript(`(()=>{const menu=document.querySelector('.plugin-menu:popover-open');return Boolean(menu)&&document.activeElement===document.querySelector('.plugin-toolbar .plugin-more')&&getComputedStyle(menu.querySelector('.plugin-global-switch')).backgroundColor==='rgba(0, 0, 0, 0)'})()`);
  result.checks.push({name:'native-pointer-menu-open-has-no-master-row-selection',ok:pointer});
  const key=async(key,code,windowsVirtualKeyCode)=>{
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,...(code==='Space'?{text:' ',unmodifiedText:' '}: {})});
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});
    await new Promise(r=>setTimeout(r,40));
  };
  await key('Escape','Escape',27);
  result.checks.push({name:'native-escape-closes-pointer-menu-and-retains-trigger-focus',ok:await win.webContents.executeJavaScript(`!document.querySelector('.plugin-menu:popover-open')&&document.activeElement===document.querySelector('.plugin-toolbar .plugin-more')`)});
  await key(' ','Space',32);
  result.checks.push({name:'native-keyboard-menu-open-retains-switch-focus-indicator',ok:await win.webContents.executeJavaScript(`Boolean(document.querySelector('.plugin-menu:popover-open'))&&document.activeElement===document.querySelector('.plugin-menu input')&&document.activeElement.matches(':focus-visible')`)});
  await key('Escape','Escape',27);
  await key('ArrowUp','ArrowUp',38);
  result.checks.push({name:'native-arrow-up-opens-menu-at-last-action',ok:await win.webContents.executeJavaScript(`Boolean(document.querySelector('.plugin-menu:popover-open'))&&document.activeElement===[...document.querySelectorAll('.plugin-menu button')].at(-1)`)});
  // Use the actual settings DOM/wrappers inside the shell: an isolated plugin
  // panel cannot catch positioned descendants extending the outer scroll range.
  const appSource = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
  const wrappers = appSource.match(/function initSettingsAnimationWrappers\(\) \{[\s\S]*?\n\}/)[0];
  const scrollChecks = await win.webContents.executeJavaScript(`(async () => {
    const template = new DOMParser().parseFromString(${JSON.stringify(appHtml)}, 'text/html');
    document.body.innerHTML = '<main class="shell settings-open"><header style="height:32px;flex-shrink:0">Σ</header></main>';
    const shell = document.querySelector('.shell'), panel = template.getElementById('settingsPanel');
    panel.classList.remove('hidden'); shell.append(panel);
    const total = template.querySelector('.total-panel'); total.style.flexShrink = '0'; shell.append(total);
    const footer = document.createElement('footer'); footer.style.cssText = 'height:32px;flex-shrink:0'; shell.append(footer);
    ${wrappers}; initSettingsAnimationWrappers();
    const sync = document.getElementById('syncSettingsDetails'), details = document.getElementById('pluginsSettingsDetails');
    sync.firstElementChild.innerHTML = '<div style="height:700px">Devices</div>';
    sync.classList.remove('hidden'); sync.parentElement.classList.add('expanded');
    const box = document.getElementById('pluginSettingsList');
    const scrollData = { enabled: true, plugins: [{ id: 'scroll-fixture', name: 'Monitor', version: '1.0.0', description: 'CPU and memory readings. Sample only while visible or while approved background checks need data.', source: 'user', status: 'disabled', enabled: false,
      views: [] }] };
    const host = TokenMonitorPluginSettings.createPluginSettingsPanel({ document, container: box, t: key => key,
      api: { list: async () => scrollData } });
    const wait = () => new Promise(resolve => setTimeout(resolve, 300));
    const measure = () => {
      panel.scrollTop = panel.scrollHeight;
      return { height: panel.scrollHeight, gap: total.getBoundingClientRect().top - panel.lastElementChild.getBoundingClientRect().bottom };
    };
    await wait(); const baseline = measure();
    await host.refresh(); await wait(); const hidden = measure();
    sync.classList.add('hidden'); details.classList.remove('hidden'); await wait();
    const open = box.getBoundingClientRect().height > 100 && details.getBoundingClientRect().height > 100;
    await host.refresh(); details.classList.add('hidden'); sync.classList.remove('hidden'); await wait(); const closed = measure();
    host.dispose();
    return [
      { name: 'hidden-last-plugin-refresh-adds-no-phantom-scroll-space', ok: Math.abs(hidden.height - baseline.height) <= 1 && Math.abs(hidden.gap - baseline.gap) <= 1, evidence: { baseline, hidden } },
      { name: 'last-plugin-opening-keeps-content-visible', ok: open },
      { name: 'plugin-close-at-bottom-restores-original-scroll-range', ok: Math.abs(closed.height - baseline.height) <= 1 && Math.abs(closed.gap - baseline.gap) <= 1, evidence: { baseline, closed } }
    ];
  })()`);
  const authorChecks = await win.webContents.executeJavaScript(`(async () => {
    const box = document.createElement('div'); document.body.append(box);
    const view = { id: 'editor', ref: 'demo/editor', revision: 'one', surfaces: ['settings', 'home'], placements: { home: false } };
    const data = { enabled: true, plugins: [{ id: 'demo', name: 'Demo', source: 'user', version: '1.0.0', revision: 'one', settingsIdentity: 'one', status: 'active', enabled: true, trusted: true, views: [view] }] };
    let input, disabledButton, finish;
    const host = TokenMonitorPluginSettings.createPluginSettingsPanel({ document, container: box, t: key => key,
      api: { list: async () => data, place: () => new Promise((resolve, reject) => { finish = fail => fail ? reject(Error('fixture placement failed')) : resolve(data); }) },
      mountSettings: node => {
        if (node.firstChild) return;
        input = document.createElement('input'); input.value = 'retained draft';
        disabledButton = document.createElement('button'); disabledButton.disabled = true;
        node.append(input, disabledButton);
      } });
    await host.refresh(); box.querySelector('.plugin-manage').click();
    const checks = [], original = input;
    for (const fail of [false, true]) {
      const chip = box.querySelector('.plugin-surface-chip'); chip.focus(); chip.click();
      checks.push({ name: 'author-controls-locked-during-' + (fail ? 'failure' : 'success'), ok: input.disabled && disabledButton.disabled && box.getAttribute('aria-busy') === 'true' });
      finish(fail); await new Promise(resolve => setTimeout(resolve, 0));
      checks.push({ name: 'author-controls-restored-after-' + (fail ? 'failure' : 'success'), ok: input === original && box.contains(input) && !input.disabled && disabledButton.disabled && input.value === 'retained draft' && input.getAttribute('aria-disabled') === 'false' && box.getAttribute('aria-busy') === 'false' && Boolean(box.querySelector('.plugin-action-error')) === fail });
      input.focus(); input.setSelectionRange(input.value.length, input.value.length);
      document.execCommand('insertText', false, '!');
      checks.push({ name: 'author-can-continue-editing-after-' + (fail ? 'failure' : 'success'), ok: document.activeElement === input && input.value === 'retained draft!' });
      input.value = 'retained draft';
    }
    host.dispose(); box.remove(); return checks;
  })()`);
  result.checks.push(...authorChecks);
  result.checks.push(...scrollChecks);
  for (const check of result.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`, check.evidence || '');
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(result,null,2));
  console.log('Evidence:', path.join(scratch, 'results.json'));
  assert.ok(result.checks.every(check => check.ok), 'Plugin settings UI regression checks failed');
  win.destroy();app.quit();
}
app.whenReady().then(main).catch(error=>{console.error(error);app.exit(1);});
