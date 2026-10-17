'use strict';

const path = require('node:path');
const tokenRate = require('./renderer/tokenRatePresentation');
const trayLayout = require('../shared/trayLayout');

// Explicit DTO: never send settingsForRenderer(), credentials or session trees
// to the painter. It only needs totals, quota records and the selected layout.
function trayRenderInput(stats, settings, extra = {}) {
  const keys = ['trayContent', 'trayCustomLayout', 'showTrayProviderBadge', 'showLimitUsed',
    'limitProviders', 'limitProviderOrder', 'limitsEnabled', 'currency', 'compactTokenUnits',
    'maskLimitAccountEmails', 'locale'];
  const safeSettings = Object.fromEntries(keys.map((key) => [key, settings[key]]));
  const periods = Object.fromEntries(Object.entries(stats?.periods || {}).map(([name, period]) => [name, {
    totalTokens: period?.totalTokens, costUsd: period?.costUsd,
    clients: period?.clients, clientCosts: period?.clientCosts
  }]));
  return { ...extra, settings: safeSettings, stats: { periods, limits: stats?.limits } };
}

function createTrayRateTracker({ now = Date.now } = {}) {
  const trackers = new Map();
  let context = '';
  let allScope = false;
  return {
    reset() { trackers.clear(); context = ''; allScope = false; },
    observe(stats, settings, source) {
      const nextContext = JSON.stringify([source, settings.hubMode, settings.deviceId, settings.clients]);
      if (context !== nextContext) { trackers.clear(); context = nextContext; }
      const items = trayLayout.liveTokenRateItemsForSurfaces([{
        enabled: settings.showTrayIcon !== false, content: settings.trayContent, layout: settings.trayCustomLayout
      }]);
      allScope = tokenRate.isSharedSyncMode(settings.hubMode);
      const scopes = new Set(items.map((item) => allScope && item.rateScope === 'all' ? 'all' : 'device'));
      for (const scope of scopes) {
        const selection = tokenRate.selectLiveTokenRatePeriods(stats, settings.deviceId, settings.hubMode, scope);
        let tracker = trackers.get(scope);
        if (!tracker) {
          tracker = tokenRate.createLiveTokenRateGroupTracker({ now });
          tracker.reset(selection.entries);
          trackers.set(scope, tracker);
        } else tracker.observe(selection.entries);
      }
      for (const scope of trackers.keys()) if (!scopes.has(scope)) trackers.delete(scope);
    },
    samples() {
      const device = trackers.get('device')?.getSample() || null;
      return { device, all: allScope ? trackers.get('all')?.getSample() || null : device };
    },
    nextExpiryAt() {
      return Math.min(...[...trackers.values()].map((tracker) => tracker.nextExpiryAt()).filter(Number.isFinite));
    }
  };
}

function createTrayImageService({ BrowserWindow, ipcMain, applyIcons, onFailure = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let win = null;
  let ready = false;
  let desired = null;
  let pending = null;
  let nextId = 0;
  let timeout = null;
  let retry = null;
  let stopped = false;
  let acceptedArtwork = '';

  function artworkKey(input) {
    return JSON.stringify([input.platform, input.systemDarkUi, input.settings.showTrayProviderBadge]);
  }

  function fail(target) {
    if (win !== target) return;
    clearTimer(timeout);
    timeout = null;
    win = null;
    ready = false;
    pending = null;
    if (!target.isDestroyed()) target.destroy();
    onFailure();
    // One owned timer, rather than an immediate renderer-crash restart loop.
    if (!stopped && desired && retry === null) retry = setTimer(() => { retry = null; pump(); }, 5000);
  }

  function pump() {
    if (stopped || !desired || pending || retry !== null) return;
    if (!win) {
      const target = new BrowserWindow({
        width: 1, height: 1, show: false, skipTaskbar: true, focusable: false,
        webPreferences: { preload: path.join(__dirname, 'trayImagePreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      win = target;
      target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      target.webContents.on('will-navigate', (event) => event.preventDefault());
      target.webContents.on('render-process-gone', () => fail(target));
      target.once('closed', () => fail(target));
      timeout = setTimer(() => fail(target), 10_000);
      target.loadFile(path.join(__dirname, 'renderer', 'trayImage.html')).catch(() => fail(target));
      return;
    }
    if (!ready) return;
    pending = { id: ++nextId, input: desired };
    const target = win;
    timeout = setTimer(() => fail(target), 10_000);
    win.webContents.send('trayImage:render', { ...pending, input: {
      ...desired, renderArtwork: acceptedArtwork !== artworkKey(desired)
    } });
  }

  function onReady(event) {
    if (stopped || !win || event.sender !== win.webContents) return;
    clearTimer(timeout);
    timeout = null;
    ready = true;
    pump();
  }

  function onRendered(event, result) {
    if (stopped || !win || !pending || event.sender !== win.webContents || result?.id !== pending.id) return;
    if (result.error) { fail(win); return; }
    clearTimer(timeout);
    timeout = null;
    const renderedInput = pending.input;
    const current = renderedInput === desired;
    pending = null;
    if (current && result.icons && typeof result.icons === 'object') {
      acceptedArtwork = artworkKey(renderedInput);
      applyIcons(result.icons);
    }
    if (!current) pump();
  }
  ipcMain.on('trayImage:ready', onReady);
  ipcMain.on('trayImage:rendered', onRendered);

  return {
    update(input) { desired = input; pump(); },
    owns: (other) => other === win,
    stop() {
      stopped = true;
      desired = null;
      pending = null;
      clearTimer(timeout);
      clearTimer(retry);
      ipcMain.removeListener('trayImage:ready', onReady);
      ipcMain.removeListener('trayImage:rendered', onRendered);
      const old = win;
      win = null;
      if (old && !old.isDestroyed()) old.destroy();
    }
  };
}

module.exports = { createTrayImageService, createTrayRateTracker, trayRenderInput };
