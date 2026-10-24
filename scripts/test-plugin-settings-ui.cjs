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
  fs.writeFileSync(path.join(scratch, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${root}/src/electron/renderer/styles.css"><link rel="stylesheet" href="file://${root}/src/electron/renderer/pluginViews.css"><style>body{overflow:auto}#scroll{display:block;height:500px;overflow:auto}#before{height:80px}#after{height:600px}</style></head><body><div id="scroll" class="settings-panel"><div id="before"></div><div id="settings"></div><div id="after"></div></div><button id="outside">Outside</button><script src="file://${root}/src/electron/renderer/pluginViews.js"></script><script src="file://${root}/src/electron/renderer/limits/windowsView.js"></script><script src="file://${root}/src/electron/renderer/selectControl.js"></script><script src="file://${root}/src/electron/renderer/pluginSettings.js"></script><script src="file://${root}/src/electron/renderer/pluginMainPages.js"></script></body></html>`);
  win = new BrowserWindow({ show: false, width: 361, height: 799, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const appHtml=fs.readFileSync(path.join(root,'src/electron/renderer/index.html'),'utf8');
  assert.ok(!appHtml.includes('id="pluginsEnabledInput"')&&!appHtml.includes('data-i18n="settings.plugins.intro"'));
  const i18n=require(path.join(root,'src/electron/renderer/i18n.js'));
  for (const locale of i18n.LANGUAGE_OPTIONS.filter(item=>item.value!=='auto').map(item=>item.value)) assert.ok(!i18n.translate(locale,'plugins.package.import').includes('…'));
  await win.loadFile(path.join(scratch, 'index.html'));
  // Hidden fixture windows need focus emulation for real DOM focusin/out.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const result = await win.webContents.executeJavaScript(`(async () => {
    const checks = [], errors = [], calls = [];
    const check = (name, ok, evidence) => { checks.push({name, ok: Boolean(ok), evidence}); };
    const box = document.getElementById('settings'), scroll = document.getElementById('scroll');
    const tick = () => new Promise(r => setTimeout(r, 20));
    const data = {enabled:true, plugins:[{id:'alpha',name:'Alpha',description:'Plugin description',version:'1.0.0',source:'builtin',status:'active',enabled:true,permissions:[],hosts:[],views:[{ref:'alpha/view',title:'View',surfaces:['home','page'],placements:{home:false}}],background:{supported:true,enabled:false},logs:[{at:0,level:'info',text:'Fixture ready'}],runtime:{state:'idle',cpuPercent:null,memoryMB:null}},{id:'beta',name:'Beta',source:'builtin',status:'disabled',enabled:false,permissions:[],hosts:[],views:[]}]};
    let pending, reject, previewPending, catalogCalls = 0;
    let catalogMode = 'deferred', previewMode = 'success', globalMode = 'success', savedMasterEnabled = true;
    const catalog = {entries:[{id:'demo',name:'Demo',description:'Example',author:'Author',version:'1.0.0',origin:{id:'official',kind:'official'},versions:[{version:'1.0.0',compatible:true,installable:true},{version:'2.0.0',compatible:true,installable:true}],status:'available'}],sources:[]};
    const tooltips = TokenMonitorLimitWindowsView.createLimitWindowsView({document,tooltip:{hasOpened:()=>false,markOpened:()=>{},release:()=>{}}});
    const panel = TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:box,setDetailTooltip:tooltips.setDetailTooltip,getEnabled:()=>savedMasterEnabled,onSetEnabled:async enabled=>{calls.push(['global',enabled]);if(globalMode==='error')throw Error('settings write failed');savedMasterEnabled=enabled;data.enabled=enabled&&!data.safeMode;return structuredClone(data)},t:(key,args)=>key==='plugins.ui.locationCount'?String(args.count)+' locations':key,onError:e=>errors.push(e.message),api:{
      list:async()=>structuredClone(data),
      catalog:()=>{catalogCalls++;return catalogMode==='deferred'?new Promise((yes,no)=>{pending=yes;reject=no}):Promise.resolve(catalog)},
      place:async(ref,surface,on)=>{calls.push(['place',ref,surface,on]);data.plugins[0].views[0].placements.home=on;return structuredClone(data)},
      setEnabled:async(id,on)=>{const p=data.plugins.find(p=>p.id===id);p.enabled=on;p.status=on?'active':'disabled';return structuredClone(data)},
      catalogPreview:async(source,id,version)=>{calls.push(['preview',version]);if(previewMode==='error')throw Error('preview rejected');if(previewMode==='deferred')await new Promise(resolve=>{previewPending=resolve});return {token:'token-'+version,id,name:'Demo',description:'Example',version,author:'Author',origin:{id:source,kind:'official'},permissions:[],hosts:[],risk:{},operation:'install',sha256:'abc'}},
      cancelInstall:async token=>{calls.push(['cancel',token])},
      install:async token=>{calls.push(['install',token]);return structuredClone(data)},
      openFolder:async()=>{calls.push(['folder'])},reload:async()=>structuredClone(data)
    }});
    await panel.refresh();
    data.plugins[0].author='Token Monitor · Official';await panel.refresh();
    const sourceIdentity=box.querySelector('.plugin-identity');
    check('host-source-label-is-separate-from-author-controlled-text',sourceIdentity.querySelector('.plugin-author').textContent==='Token Monitor · Official'&&sourceIdentity.querySelector('.plugin-origin-label').textContent==='settings.plugins.source.builtin'&&!sourceIdentity.querySelector('.plugin-author').contains(sourceIdentity.querySelector('.plugin-origin-label')));
    check('only-host-official-origin-gets-shield',Boolean(sourceIdentity.querySelector('.plugin-shield')));
    const officialSource=sourceIdentity.querySelector('.plugin-source');
    check('official-attribution-is-one-green-line-with-host-owned-source',officialSource.firstElementChild.classList.contains('plugin-shield')&&getComputedStyle(officialSource).flexWrap==='nowrap'&&getComputedStyle(officialSource.querySelector('.plugin-author')).color===getComputedStyle(officialSource.querySelector('.plugin-origin-label')).color&&getComputedStyle(officialSource.querySelector('.plugin-origin-label')).borderTopWidth==='0px');
    data.plugins[0].installation={origin:{kind:'community'}};await panel.refresh();
    check('community-author-cannot-spoof-official-shield',!box.querySelector('[data-plugin-id="alpha"] .plugin-shield')&&box.querySelector('[data-plugin-id="alpha"] .plugin-origin-label').textContent==='plugins.origin.community');
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
    scroll.scrollTop=60;
    const official=tab('official');official.focus({preventScroll:true});const y=official.getBoundingClientRect().y;
    official.click();const during={y:official.getBoundingClientRect().y,focus:document.activeElement===official,connected:official.isConnected};
    official.click();tab('community').click();
    check('pending-navigation-keeps-node-position-focus-and-one-request',during.y===y&&during.focus&&during.connected&&catalogCalls===1,{during,y,catalogCalls});
    scroll.scrollTop=70;pending(catalog);await tick();
    check('completion-retains-navigation-and-current-scroll',official===tab('official')&&document.activeElement===official&&scroll.scrollTop===70&&official.getAttribute('aria-selected')==='true',{scroll:scroll.scrollTop});
    const community=tab('community');community.focus({preventScroll:true});community.click();reject(Error('offline'));await tick();
    check('failed-tab-load-keeps-current-page-and-focus',official.getAttribute('aria-selected')==='true'&&document.activeElement===community&&errors.at(-1)==='offline');
    community.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    check('keyboard-navigation-with-labelled-panel',document.activeElement===tab('installed')&&tab('installed').tabIndex===0&&[...box.querySelectorAll('[role="tab"]')].filter(n=>n.tabIndex===0).length===1&&box.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby')===official.id&&box.querySelector('[role="tablist"]')!==null);
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
    tab('official').click();await tick();
    check('catalog-shares-identity-layout-with-no-inline-version-folds',Boolean(box.querySelector('.plugin-catalog .plugin-identity-art'))&&!box.querySelector('.plugin-catalog details'));
    catalog.entries[0].installedVersion='1.0.0';catalog.entries[0].status='installed';await panel.refresh();
    const installedLink=box.querySelector('.plugin-installed-check');
    check('catalog-installed-check-uses-success-color-and-retains-navigation',Boolean(installedLink)&&installedLink.textContent==='plugins.catalog.installed'&&getComputedStyle(installedLink).color===getComputedStyle(box.querySelector('.plugin-origin-official')).color);
    installedLink.click();await tick();check('installed-check-navigates-to-installed-list',Boolean(box.querySelector('.plugin-installed-card')));
    delete catalog.entries[0].installedVersion;catalog.entries[0].status='available';tab('official').click();await tick();

    click('plugins.package.install');await tick();
    check('catalog-install-opens-version-and-consent-review',Boolean(box.querySelector('.plugin-catalog-review .plugin-package-preview'))&&box.querySelectorAll('.plugin-catalog-review details').length===1);
    let select=box.querySelector('.plugin-version-picker select');select.focus({preventScroll:true});select.value='2.0.0';select.dispatchEvent(new Event('change'));await tick();
    check('version-change-replaces-token-and-retains-review-focus',document.activeElement===box.querySelector('.plugin-version-picker select')&&document.activeElement.value==='2.0.0'&&calls.some(c=>c[0]==='cancel'&&c[1]==='token-1.0.0')&&box.querySelector('.plugin-package-preview .plugin-version').textContent==='2.0.0');
    previewMode='error';select=box.querySelector('.plugin-version-picker select');select.value='1.0.0';select.dispatchEvent(new Event('change'));await tick();
    check('failed-version-preview-removes-stale-install-consent',!box.querySelector('.plugin-package-preview')&&errors.at(-1)==='preview rejected'&&calls.some(c=>c[0]==='cancel'&&c[1]==='token-2.0.0'));
    click('plugins.ui.backCatalog');await tick();previewMode='success';
    tab('community').click();await tick();click('plugins.catalog.sources');await tick();
    check('sources-open-as-route-without-nested-disclosures',Boolean(box.querySelector('.plugin-sources .plugin-source-form'))&&!box.querySelector('.plugin-sources details')&&document.activeElement===box.querySelector('.plugin-back'));
    const sourceUrl=box.querySelector('.plugin-source-form input');sourceUrl.value='https://example.test/catalog.json';sourceUrl.dispatchEvent(new Event('input'));click('plugins.ui.backCatalog');await tick();click('plugins.catalog.sources');await tick();
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
    check('failed-global-save-restores-authoritative-switch-and-focus',global.checked&&data.enabled&&!box.querySelector('.plugin-paused')&&errors.at(-1)==='settings write failed'&&document.activeElement===global);
    globalMode='success';global.closest('.plugin-menu').hidePopover();data.safeMode=true;data.enabled=false;await panel.refresh();global=await openGlobal();
    check('safe-mode-master-reflects-saved-intent-not-runtime',global.checked&&savedMasterEnabled&&!data.enabled&&Boolean(box.querySelector('.plugin-paused'))&&box.querySelector('[data-plugin-id="alpha"] input').disabled);
    global.click();await tick();global=await openGlobal();
    check('safe-mode-can-persist-master-off',!global.checked&&!savedMasterEnabled&&!data.enabled&&calls.filter(c=>c[0]==='global').at(-1)[1]===false);
    data.safeMode=false;data.enabled=savedMasterEnabled;await panel.refresh();global=await openGlobal();
    check('leaving-safe-mode-retains-master-off',!global.checked&&!data.enabled&&Boolean(box.querySelector('.plugin-paused')));
    data.safeMode=true;await panel.refresh();global=await openGlobal();global.click();await tick();global=await openGlobal();
    check('safe-mode-still-blocks-runtime-when-master-on',global.checked&&savedMasterEnabled&&!data.enabled&&Boolean(box.querySelector('.plugin-paused'))&&box.querySelector('[data-plugin-id="alpha"] input').disabled);
    data.safeMode=false;data.enabled=savedMasterEnabled;await panel.refresh();await openGlobal();click('plugins.ui.about');await tick();
    check('plugin-explanation-is-secondary-route-with-focused-back',Boolean(box.querySelector('.plugin-about'))&&box.querySelector('.plugin-about p').textContent==='settings.plugins.intro'&&document.activeElement===box.querySelector('.plugin-back'));
    box.querySelector('.plugin-back').click();await tick();check('about-back-restores-more-trigger-focus',document.activeElement===box.querySelector('.plugin-toolbar .plugin-more'));
    check('removed-style-editor-has-no-tab-or-controls',!tab('style')&&!box.querySelector('.plugin-style-form')&&box.querySelectorAll('[role=tab]').length===3);
    tab('installed').click();await tick();catalogMode='deferred';tab('official').focus();tab('official').click();document.getElementById('outside').focus();pending(catalog);await tick();
    check('completion-does-not-steal-external-focus',document.activeElement.id==='outside');
    catalogMode='success';document.getElementById('after').style.display='none';scroll.style.height='400px';
    tab('installed').click();await tick();scroll.scrollTop=120;
    const shortTab=tab('official');shortTab.focus({preventScroll:true});const shortTabY=shortTab.getBoundingClientRect().y, shortScroll=scroll.scrollTop;
    shortTab.click();await tick();
    check('short-tab-keeps-rail-position-without-downstream-spacer',scroll.scrollTop===shortScroll&&shortTab.getBoundingClientRect().y===shortTabY,{before:shortScroll,after:scroll.scrollTop,beforeY:shortTabY,afterY:shortTab.getBoundingClientRect().y});
    catalog.entries[0].versions.push({version:'3.0.0',compatible:true,installable:true,changelog:'Version three'});
    click('plugins.package.install');await tick();previewMode='deferred';
    let rapid=box.querySelector('.plugin-version-picker select');rapid.focus({preventScroll:true});rapid.value='2.0.0';rapid.dispatchEvent(new Event('change'));await tick();
    rapid.value='3.0.0';rapid.dispatchEvent(new Event('change'));
    let resolvePreview=previewPending;previewPending=null;resolvePreview();await tick();
    if(previewPending){resolvePreview=previewPending;previewPending=null;resolvePreview();await tick();}
    const rapidAligned=box.querySelector('.plugin-version-picker select').value==='3.0.0'&&box.querySelector('.plugin-package-preview .plugin-version').textContent==='3.0.0';
    box.querySelector('.plugin-allow').click();await tick();previewMode='success';
    check('rapid-version-changes-align-selection-preview-and-installed-token',rapidAligned&&calls.filter(c=>c[0]==='install').at(-1)?.[1]==='token-3.0.0',{lastInstall:calls.filter(c=>c[0]==='install').at(-1)});
    const pageBox=document.createElement('div');document.body.append(pageBox);
    const demands=[], pageHost=TokenMonitorPluginViews.createPluginViewHost({document,window,t:k=>k,onDemand:(s,r)=>demands.push([s,r]),onInteraction:()=>{}});
    const pages=TokenMonitorPluginMainPages.create({document,container:pageBox,host:pageHost,t:k=>k,openWindow:()=>{}});
    const routes=[{id:'plugin:alpha/view',ref:'alpha/view',title:'Alpha'},{id:'plugin:beta/view',ref:'beta/view',title:'Beta'}];
    const payload=(ref,revision=1)=>({surface:'page',views:{[ref]:{status:'ok',revision,tree:{type:'input',action:'note',label:'Note',value:'saved'}}}});
    pages.render(routes,'plugin:alpha/view');pageHost.update(payload('alpha/view'));
    const draft=pageBox.querySelector('input');draft.value='unsubmitted';draft.dispatchEvent(new Event('input'));
    pages.render(routes,'plugin:beta/view');pageHost.update(payload('beta/view'));pageHost.update({surface:'page',views:{}});
    pages.render(routes,'plugin:alpha/view');pageHost.update(payload('alpha/view',2));
    check('main-page-draft-survives-switch-empty-push-and-worker-restart',draft.isConnected&&draft.value==='unsubmitted'&&draft===pageBox.querySelector('input'));
    pageHost.update({surface:'page',views:{'alpha/view':{status:'ok',revision:2,tree:{type:'input',action:'note',label:'Note',value:'unsubmitted'}}}});
    pageHost.update(payload('alpha/view',2));check('acknowledged-main-page-draft-resumes-model-updates',draft.value==='saved');
    pages.render(routes.filter(p=>p.ref!=='alpha/view'),'home');
    check('removed-page-releases-retained-dom',!draft.isConnected&&pageBox.classList.contains('hidden'));
    return {checks,errors};
  })()`);
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
    const scrollData = { enabled: true, plugins: [{ id: 'scroll-fixture', name: 'Monitor', version: '1.0.0', description: 'CPU and memory readings. Sample only while visible or while approved background checks need data.', source: 'builtin', status: 'disabled', enabled: false,
      permissions: ['notify', 'sys.cpu', 'sys.memory', 'tm.pages', 'ui.web'], hosts: [], views: [] }] };
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
  result.checks.push(...scrollChecks);
  for (const check of result.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`, check.evidence || '');
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(result,null,2));
  console.log('Evidence:', path.join(scratch, 'results.json'));
  assert.ok(result.checks.every(check => check.ok), 'Plugin settings UI regression checks failed');
  win.destroy();app.quit();
}
app.whenReady().then(main).catch(error=>{console.error(error);app.exit(1);});
