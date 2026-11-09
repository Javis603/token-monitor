'use strict';
// Called by the isolated plugin runtime fixture; never loads a real profile.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function proof({ BrowserWindow, ipcMain, win, runtime, settings, stats, root, evidence, js, waitFor, capture, nativeProofSurfaces }) {
  fs.mkdirSync(evidence, { recursive: true });
  await js("openViewFromTray('home'); renderHomeIfVisible();");
  await waitFor("document.querySelector('.home-limit-account-head')?.parentElement?.parentElement?.textContent.includes('API credits')", 'Home module');
  assert.equal(await js("state.stats.limits.providers.some(row=>row.provider.startsWith('plugin:'))"), false, 'raw stats remain unchanged');
  await capture('home-after.png');
  if (process.env.TM_NATIVE_HOME_BASELINE) {
    const current = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
    const functions = ['homeLimitRows', 'renderHomeLimitModule'];
    const restore = functions.map(name => {
      const match = current.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
      assert.ok(match, `Missing app.js function: ${name}`);
      return match[0];
    }).join('\n');
    await js(fs.readFileSync(process.env.TM_NATIVE_HOME_BASELINE, 'utf8'));
    await js('renderHomeIfVisible()'); await capture('home-before.png');
    await js(restore); await js('renderHomeIfVisible()');
  }
  await js("tokenMonitor.updateSettings({edgeDockEnabled:true,edgeDockItems:[{type:'limit',provider:'plugin:synthetic-limits:one'},{type:'limit',provider:'plugin:synthetic-limits:two'},{type:'plugin',ref:'synthetic-limits/native-card'}]})");
  await js("openSettingsPanel();setSettingsSectionExpanded('window',true);syncDockControls();displaySettings.open('edgeDock');displaySettings.open('edgeDock');edgeDockComposer.render();els.edgeDockComposer.scrollIntoView({block:'center'});");
  await js("els.edgeDockComposer.querySelector('.edge-dock-composer-item').click()");
  await pause(500);
  await js("els.edgeDockComposer.scrollIntoView({block:'center'})");
  await capture('composer-active.png');
  assert.equal(await js("els.edgeDockComposer.querySelectorAll('.edge-dock-composer-mark > span').length>=3"), true, 'module/custom-view icons in composer');
  const iconPoint = await js("(()=>{const image=els.edgeDockComposer.querySelector('.edge-dock-composer-item img');const r=image.getBoundingClientRect();window.pluginIconDragStarts=0;window.observePluginIconDrag=e=>{window.pluginIconDragStarts++;e.preventDefault()};document.addEventListener('dragstart',window.observePluginIconDrag,true);return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  win.webContents.sendInputEvent({ type: 'mouseMove', ...iconPoint });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...iconPoint, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: iconPoint.x + i * 5, y: iconPoint.y, button: 'left' });
    await pause(20);
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: iconPoint.x + 30, y: iconPoint.y, button: 'left', clickCount: 1 });
  const nativeIconDragStarts = await js("window.pluginIconDragStarts");
  assert.equal(nativeIconDragStarts, 0, 'plugin images must not initiate native browser drags');
  await js("document.removeEventListener('dragstart',window.observePluginIconDrag,true)");
  const projected = require('../src/electron/plugins/limitsPresentation').projectPluginLimits(stats, runtime.limitsSnapshot());
  const dockSettings = { ...settings, edgeDockEnabled: true, edgeDockMode: 'always', edgeDockSide: 'right', edgeDockItems: [{ type: 'limit', provider: 'plugin:synthetic-limits:one' }, { type: 'limit', provider: 'plugin:synthetic-limits:two' }],
    notchEnabled: true, notchRefreshEnabled: true, notchShape: 'pill', notchSummaryMode: 'tray', trayContent: 'barsAllSessions', limitProviders: 'plugin:synthetic-limits:one,plugin:synthetic-limits:two', notchBuiltinPages: ['home', 'limits', 'sessions'], notchHoverAction: 'open', notchHoverDelayMs: 0 };
  const cells = require('../src/electron/renderer/edgeDock/presentation').buildEdgeDockCells(projected, { items: dockSettings.edgeDockItems });
  assert.equal(cells.length, 2);
  const windows = [];
  class RecordingWindow extends BrowserWindow {
    constructor(options) { super(options); windows.push(this); this.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.log('SURFACE', message); }); }
    loadFile(file, options) {
      nativeProofSurfaces.set(this.webContents.id, options.query.surface === 'notch' ? 'notch' : 'edgeDock');
      return super.loadFile(file, options);
    }
  }
  const display = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1200, height: 900 }, workArea: { x: 0, y: 30, width: 1200, height: 870 } };
  const screen = new EventEmitter();
  screen.getAllDisplays = () => [display]; screen.getPrimaryDisplay = () => display;
  screen.getDisplayMatching = () => display; screen.getDisplayNearestPoint = () => display;
  screen.point = { x: 600, y: 15 }; screen.getCursorScreenPoint = () => screen.point;
  const mainSource = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
  const refreshContext = vm.createContext({ pluginRuntime: runtime, deviceRuntimeHandle: null, hubModeGeneration: 1, statsPushRevision: 0,
    edgeDockManualStats: null, fetchStats: async () => stats, repaintDockSurfaces() {}, console });
  const refreshFunctions = ['refreshManualStats', 'refreshStatsFromEdgeDock'].map(name => {
    const match = mainSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
    assert.ok(match, `Missing main.js function: ${name}`);
    return match[0];
  }).join('\n');
  vm.runInContext('let manualStatsRefreshInFlight = null;\n' + refreshFunctions, refreshContext);
  const common = { BrowserWindow: RecordingWindow, ipcMain, screen, getSettings: () => dockSettings, platform: 'darwin',
    rendererDir: path.join(root, 'src/electron/renderer'), prefersReducedMotion: () => true, primaryButtonDown: () => false, nativeGlass: () => false,
    canRefreshLimits: () => true, onRefreshLimits: () => refreshContext.refreshStatsFromEdgeDock() };
  const notch = require('../src/electron/notch/controller').createNotchController({ ...common,
    preloadPath: path.join(root, 'src/electron/notch/preload.js'), readScreens: () => ({ screens: [], mainDisplayId: 1 }) });
  const dock = require('../src/electron/edgeDock/controller').createEdgeDockController({ ...common,
    preloadPath: path.join(root, 'src/electron/edgeDock/preload.js') });
  try {
    runtime.demandLimits(true, 'fixture.native-refresh');
    notch.setAppearance({ ...settings, language: 'zh-TW', reduceMotion: 'on' });
    notch.setData(require('../src/electron/notch/data').buildNotchData(projected, cells, dockSettings)); notch.sync();
    dock.setAppearance({ ...settings, language: 'zh-TW', reduceMotion: 'on' }); dock.setCells(cells); dock.sync();
    await pause(900);
    const bySurface = async name => {
      for (const surfaceWin of windows) if (!surfaceWin.isDestroyed() && await surfaceWin.webContents.executeJavaScript(`new URLSearchParams(location.search).get('surface')===${JSON.stringify(name)}`)) return surfaceWin;
      throw Error(`Missing native surface ${name}`);
    };
    const notchWin = await bySurface('notch');
    ipcMain.emit('topNotch:press', { sender: notchWin.webContents }); await pause(300);
    await notchWin.webContents.executeJavaScript("document.querySelector('[data-page=limits][role=tab]').click()"); await pause(250);
    assert.equal(await notchWin.webContents.executeJavaScript("document.querySelector('.notch-page-limits').textContent.includes('API credits')"), true);
    assert.equal(notch.quotaVisibility().panel, true);
    const beforeRefresh = runtime.limitsSnapshot().providers[0].updatedAt;
    assert.equal((await notchWin.webContents.executeJavaScript('tokenMonitorEdgeDock.refreshLimits()')).ok, true);
    for (let n = 0; n < 50 && runtime.limitsSnapshot().providers[0].updatedAt === beforeRefresh; n++) await pause(40);
    assert.notEqual(runtime.limitsSnapshot().providers[0].updatedAt, beforeRefresh, 'native Refresh resamples the real synthetic plugin registry');
    fs.writeFileSync(path.join(evidence, 'notch-limits.png'), (await notchWin.webContents.capturePage()).toPNG());
    const metadataOnly = require('../src/electron/plugins/limitsPresentation').projectPluginLimits({ ...stats, limits: { providers: [] } }, { modules: runtime.limitsSnapshot().modules, providers: [] });
    const summaryOnly = require('../src/electron/notch/data').buildNotchData(metadataOnly, [], { ...dockSettings, notchSummaryMode: 'custom', notchCustomLayout: { items: [{ type: 'icon', icon: 'provider', source: { provider: 'plugin:synthetic-limits:one' } }] } });
    assert.equal(summaryOnly.summary.items[0].providerCell, undefined);
    notch.setData(summaryOnly); await pause(200);
    assert.equal(await notchWin.webContents.executeJavaScript("providerLabel('plugin:synthetic-limits:one')"), 'API credits');
    assert.equal(await notchWin.webContents.executeJavaScript("state.payload.cells.length===0 && !state.payload.summary.items[0].providerCell && !!document.querySelector('.notch-summary .edge-dock-mark.is-plugin .row-icon-codex')"), true);
    fs.writeFileSync(path.join(evidence, 'notch-fixed-icon-no-reading.png'), (await notchWin.webContents.capturePage()).toPNG());
    notch.setData(require('../src/electron/notch/data').buildNotchData(projected, cells, dockSettings));
    const railWin = await bySurface('rail');
    assert.equal(await railWin.webContents.executeJavaScript("document.querySelectorAll('.edge-dock-cell').length>=2"), true);
    fs.writeFileSync(path.join(evidence, 'dock-rail.png'), (await railWin.webContents.capturePage()).toPNG());
    ipcMain.emit('edgeDock:click', { sender: railWin.webContents }, { cellIndex: 0 }); await pause(300);
    const cardWin = await bySurface('bubble');
    assert.equal(await cardWin.webContents.executeJavaScript("document.body.textContent.includes('API credits')"), true);
    const cardRect = await cardWin.webContents.executeJavaScript("(()=>{const r=document.querySelector('.edge-dock-card').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-8),y:Math.max(0,Math.floor(r.y)-8),width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16}})()");
    fs.writeFileSync(path.join(evidence, 'dock-card.png'), (await cardWin.webContents.capturePage(cardRect)).toPNG());
    // Remove built-in readings so their fallback artwork cannot satisfy this proof.
    await js("state.stats={...state.stats,limits:{...state.stats.limits,providers:[]}}");
    const sourceProviders = await js("TokenMonitorTrayText.pickConfiguredLimitProviders(desktopSurfaceStats(),{limitProviders:state.settings.limitProviders,limitProviderOrder:state.settings.limitProviderOrder}).map(pick=>pick.provider)");
    assert.equal(sourceProviders.length, 2);
    assert.ok(sourceProviders.every(id => id.startsWith('plugin:')));
    const trayImages = await js("(()=>{const modes=['barsAllSessions','limitsAllSessions'];return modes.map(mode=>({mode,image:trayDataUrlForMode(mode,44,{}, {stats:desktopSurfaceStats()})}));})()");
    for (const item of trayImages) { assert.match(item.image, /^data:image\/png/); fs.writeFileSync(path.join(evidence, `tray-${item.mode}.png`), Buffer.from(item.image.split(',')[1], 'base64')); }
    await js("openViewFromTray('home');state.settings.floatingBubbleContent='barsAllSessions';applyFloatingBubbleState({collapsed:true,side:'right'});renderFloatingBubbleContent();");
    await pause(250);
    assert.equal(await js("state.floatingBubble.collapsed && state.stats.limits.providers.length===0 && desktopLimitRecords().length===2 && desktopLimitRecords().every(row=>row.provider.startsWith('plugin:')) && !!els.floatingBubbleContent.querySelector('img')"), true);
    const bubbleRect = await js("(()=>{const r=els.floatingBubbleContent.getBoundingClientRect();return {x:Math.floor(r.x)-8,y:Math.floor(r.y)-8,width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16}})()");
    fs.writeFileSync(path.join(evidence, 'floating-bubble.png'), (await win.webContents.capturePage(bubbleRect)).toPNG());
    const fixedLayout = { items: [{ type: 'icon', icon: 'provider', source: { provider: 'plugin:synthetic-limits:one' } }] };
    const fixedBitmap = () => js(`renderCustomTrayLayout(desktopSurfaceStats(),${JSON.stringify(fixedLayout)})`);
    assert.match(await fixedBitmap(), /^data:image\/png/);
    await js("applyFloatingBubbleState({collapsed:false});openSettingsPanel();setSettingsSectionExpanded('window',true);pluginApi.setEnabled('synthetic-limits',false)");
    await waitFor("state.pluginCatalog.plugins.find(p=>p.id==='synthetic-limits')?.status==='disabled'", 'disabled catalog');
    await js("displaySettings.open('edgeDock');edgeDockComposer.render();els.edgeDockComposer.scrollIntoView({block:'center'});");
    assert.equal(await js("els.edgeDockComposer.querySelectorAll('.is-unavailable').length>=3"), true);
    await js("els.edgeDockComposer.querySelectorAll('.edge-dock-composer-item')[2].click()");
    await capture('composer-disabled.png');
    const inactive = require('../src/electron/plugins/limitsPresentation').projectPluginLimits(stats, runtime.limitsSnapshot());
    assert.equal(require('../src/electron/renderer/edgeDock/presentation').buildEdgeDockCells(inactive, { items: dockSettings.edgeDockItems }).length, 0);
    assert.equal(await fixedBitmap(), null, 'disabled fixed icons emit no Tray/Bubble bitmap');
    assert.equal(require('../src/electron/notch/data').buildNotchData(inactive, [], { notchSummaryMode: 'custom', notchCustomLayout: fixedLayout }).summary, null);
    await js(`tokenMonitor.updateSettings({floatingBubbleContent:'custom',floatingBubbleCustomLayout:${JSON.stringify(fixedLayout)}})`);
    await js("openViewFromTray('home');applyFloatingBubbleState({collapsed:true,side:'right'})");
    assert.equal(await js("!!els.floatingBubbleContent.querySelector('img')"), false);
    runtime.manager.setEnabled('synthetic-limits', true);
    await waitFor("state.pluginCatalog.limits.modules.length===2 && !!els.floatingBubbleContent.querySelector('img')", 'fixed Bubble icon restored');
    assert.match(await fixedBitmap(), /^data:image\/png/);
    runtime.manager.setEnabled('synthetic-limits', false);
    await waitFor("state.pluginCatalog.limits.modules.length===0 && !els.floatingBubbleContent.querySelector('img')", 'visible Bubble drops disabled fixed icon');

    fs.writeFileSync(path.join(evidence, 'proof.json'), JSON.stringify({ modules: cells.map(cell => cell.provider), rawStatsUntouched: true, nativeManualRefresh: true, fixedIconDisableRestore: true, standaloneNotchMetadata: true, nativeIconDragStarts, trayAndBubbleProviders: sourceProviders, inactiveCells: 0, surfaceCount: windows.length }, null, 2));
  } finally { dock.stop(); notch.dispose(); runtime.demandLimits(false, 'fixture.native-refresh'); }
};
