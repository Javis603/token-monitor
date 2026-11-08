'use strict';
// Called by the isolated plugin runtime fixture; never loads a real profile.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
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
    const restore = functions.map(name => current.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0]).join('\n');
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
  const projected = require('../src/electron/plugins/limitsPresentation').projectPluginLimits(stats, runtime.limitsSnapshot());
  const dockSettings = { ...settings, edgeDockEnabled: true, edgeDockMode: 'always', edgeDockSide: 'right', edgeDockItems: [{ type: 'limit', provider: 'plugin:synthetic-limits:one' }, { type: 'limit', provider: 'plugin:synthetic-limits:two' }],
    notchEnabled: true, notchShape: 'pill', notchSummaryMode: 'tray', trayContent: 'barsAllSessions', limitProviders: 'plugin:synthetic-limits:one,plugin:synthetic-limits:two', notchBuiltinPages: ['home', 'limits', 'sessions'], notchHoverAction: 'open', notchHoverDelayMs: 0 };
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
  const common = { BrowserWindow: RecordingWindow, ipcMain, screen, getSettings: () => dockSettings, platform: 'darwin',
    rendererDir: path.join(root, 'src/electron/renderer'), prefersReducedMotion: () => true, primaryButtonDown: () => false, nativeGlass: () => false };
  const notch = require('../src/electron/notch/controller').createNotchController({ ...common,
    preloadPath: path.join(root, 'src/electron/notch/preload.js'), readScreens: () => ({ screens: [], mainDisplayId: 1 }) });
  const dock = require('../src/electron/edgeDock/controller').createEdgeDockController({ ...common,
    preloadPath: path.join(root, 'src/electron/edgeDock/preload.js') });
  try {
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
    fs.writeFileSync(path.join(evidence, 'notch-limits.png'), (await notchWin.webContents.capturePage()).toPNG());
    const railWin = await bySurface('rail');
    assert.equal(await railWin.webContents.executeJavaScript("document.querySelectorAll('.edge-dock-cell').length>=2"), true);
    fs.writeFileSync(path.join(evidence, 'dock-rail.png'), (await railWin.webContents.capturePage()).toPNG());
    ipcMain.emit('edgeDock:click', { sender: railWin.webContents }, { cellIndex: 0 }); await pause(300);
    const cardWin = await bySurface('bubble');
    assert.equal(await cardWin.webContents.executeJavaScript("document.body.textContent.includes('API credits')"), true);
    const cardRect = await cardWin.webContents.executeJavaScript("(()=>{const r=document.querySelector('.edge-dock-card').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-8),y:Math.max(0,Math.floor(r.y)-8),width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16}})()");
    fs.writeFileSync(path.join(evidence, 'dock-card.png'), (await cardWin.webContents.capturePage(cardRect)).toPNG());
    const trayImages = await js("(()=>{const modes=['barsAllSessions','limitsAllSessions'];return modes.map(mode=>({mode,image:trayDataUrlForMode(mode,44,{}, {stats:desktopSurfaceStats()})}));})()");
    for (const item of trayImages) { assert.match(item.image, /^data:image\/png/); fs.writeFileSync(path.join(evidence, `tray-${item.mode}.png`), Buffer.from(item.image.split(',')[1], 'base64')); }
    await js("openViewFromTray('home');state.settings.floatingBubbleContent='barsAllSessions';applyFloatingBubbleState({collapsed:true,side:'right'});renderFloatingBubbleContent();");
    await pause(250);
    assert.equal(await js("state.floatingBubble.collapsed && !!els.floatingBubbleContent.querySelector('img')"), true);
    const bubbleRect = await js("(()=>{const r=els.floatingBubbleContent.getBoundingClientRect();return {x:Math.floor(r.x)-8,y:Math.floor(r.y)-8,width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16}})()");
    fs.writeFileSync(path.join(evidence, 'floating-bubble.png'), (await win.webContents.capturePage(bubbleRect)).toPNG());
    await js("applyFloatingBubbleState({collapsed:false});openSettingsPanel();setSettingsSectionExpanded('window',true);pluginApi.setEnabled('synthetic-limits',false)");
    await waitFor("state.pluginCatalog.plugins.find(p=>p.id==='synthetic-limits')?.status==='disabled'", 'disabled catalog');
    await js("displaySettings.open('edgeDock');edgeDockComposer.render();els.edgeDockComposer.scrollIntoView({block:'center'});");
    assert.equal(await js("els.edgeDockComposer.querySelectorAll('.is-unavailable').length>=3"), true);
    await js("els.edgeDockComposer.querySelectorAll('.edge-dock-composer-item')[2].click()");
    await capture('composer-disabled.png');
    const inactive = require('../src/electron/plugins/limitsPresentation').projectPluginLimits(stats, runtime.limitsSnapshot());
    assert.equal(require('../src/electron/renderer/edgeDock/presentation').buildEdgeDockCells(inactive, { items: dockSettings.edgeDockItems }).length, 0);
    fs.writeFileSync(path.join(evidence, 'proof.json'), JSON.stringify({ modules: cells.map(cell => cell.provider), rawStatsUntouched: true, inactiveCells: 0, surfaceCount: windows.length }, null, 2));
  } finally { dock.stop(); notch.dispose(); }
};
