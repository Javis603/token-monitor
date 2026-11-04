'use strict';

const path = require('node:path');
const { CARD_MOVE_MS, CARD_SPRING, advanceCardFrame } = require('../cardSpring');
const motionPreference = require('../motionPreference');
const { attachNativeMaterialVisibility, syncNativeMaterialVisibility, getNativeMaterialState } = require('../nativeMaterialVisibility');

function historyBounds(owner, rect, workArea, zoom = 1) {
  const width = Math.min(Math.round(310 * zoom), workArea.width - 16);
  const height = Math.min(Math.round(420 * zoom), workArea.height - 16);
  const right = owner.x + owner.width + 8;
  const left = owner.x - width - 8;
  const x = right + width <= workArea.x + workArea.width - 8 ? right
    : left >= workArea.x + 8 ? left : owner.x + owner.width - width;
  return {
    x: Math.round(Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - width - 8))),
    y: Math.round(Math.max(workArea.y + 8, Math.min(owner.y + rect.y * zoom - 22, workArea.y + workArea.height - height - 8))),
    width, height
  };
}

function createLimitsHistoryController({ BrowserWindow, screen, ipcMain, isOwner, read, logger = console.log, setTimer = setTimeout, clearTimer = clearTimeout, getOpenMode = () => 'hover', getMaterialOptions = () => ({ enabled: false }), now = Date.now, setFrameTimer = setInterval, clearFrameTimer = clearInterval }) {
  let win = null;
  let owner = null;
  let key = '';
  let source = '';
  let ready = false;
  let visible = false;
  let timer = null;
  let ownerListeners = [];
  let revision = 0;
  let pendingOpen = null;
  let activated = false;
  let anchor = null;
  let currentPayload = null;
  let renderSequence = 0;
  let expectedRender = 0;
  let placement = null;
  let animatePlacement = false;
  let frameMotion = null;
  let frameTimer = null;
  let rendererReducedMotion = false;

  function inside(point, bounds) {
    return bounds && point.x >= bounds.x && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
  }
  function crossingGap(point) {
    if (!anchor || !win?.isVisible()) return false;
    const panel = win.getBounds();
    const left = panel.x >= anchor.x + anchor.width ? anchor.x + anchor.width : panel.x + panel.width;
    const right = panel.x >= anchor.x + anchor.width ? panel.x : anchor.x;
    return right >= left && inside(point, { x: left, y: Math.min(anchor.y, panel.y), width: right - left,
      height: Math.max(anchor.y + anchor.height, panel.y + panel.height) - Math.min(anchor.y, panel.y) });
  }

  function reducedMotion() {
    return rendererReducedMotion || motionPreference.shouldReduceMotion(currentPayload?.appearance?.reduceMotion, currentPayload?.appearance?.systemReducedMotion === true);
  }
  function cancelFrameMotion() {
    clearFrameTimer(frameTimer);
    frameTimer = null;
    frameMotion = null;
  }
  function advanceFrame() {
    const motion = frameMotion;
    if (!motion || !visible || !win || win.isDestroyed()) return;
    const elapsed = now() - motion.startedAt;
    const done = elapsed >= CARD_MOVE_MS || reducedMotion();
    const frame = advanceCardFrame(motion, elapsed, CARD_SPRING, done);
    win.setBounds({ ...frame, width: Math.max(1, frame.width), height: Math.max(1, frame.height) });
    if (done) cancelFrameMotion();
  }
  function placeFrame(target, animate) {
    if (frameMotion && !reducedMotion() && Object.keys(target).every(key => frameMotion.to[key] === target[key])) return;
    const from = win.getBounds();
    const velocity = frameMotion?.velocity || {};
    const moving = win.isVisible() && (animate || frameMotion) && !reducedMotion()
      && Object.keys(target).some(key => from[key] !== target[key]);
    cancelFrameMotion();
    if (!moving) { win.setBounds(target); return; }
    frameMotion = { keys: Object.keys(target), from, to: target, velocity: { ...velocity }, initialVelocity: velocity,
      startedAt: now(), workArea: placement.workArea };
    advanceFrame();
    if (frameMotion) frameTimer = setFrameTimer(advanceFrame, 16);
  }
  function syncMaterial() { syncNativeMaterialVisibility(win, getMaterialOptions()); }
  function send(payload, opening = false) {
    currentPayload = payload;
    expectedRender = ++renderSequence;
    syncMaterial();
    win.webContents.send('limitsHistory:render', { ...payload, opening: opening || !win.isVisible(), renderToken: expectedRender,
      layoutWidth: placement.bounds.width / win.webContents.getZoomFactor(), nativeMaterial: getNativeMaterialState(win) });
  }
  function cancelClose() { clearTimer(timer); timer = null; }
  function hide() {
    revision += 1;
    pendingOpen = null;
    activated = false;
    anchor = null;
    cancelClose();
    visible = false;
    currentPayload = null;
    expectedRender = ++renderSequence;
    placement = null;
    rendererReducedMotion = false;
    animatePlacement = false;
    cancelFrameMotion();
    key = '';
    if (owner && !owner.isDestroyed?.()) owner.webContents.send('limitsHistory:state', false);
    if (win && !win.isDestroyed()) win.hide();
    ownerListeners.forEach(([event, listener]) => owner?.removeListener(event, listener));
    ownerListeners = [];
    owner = null;
  }
  function leave() {
    cancelClose();
    if (visible && !activated) timer = setTimer(() => {
      timer = null;
      const point = screen.getCursorScreenPoint();
      if (!visible || activated || containsPoint(point) || inside(point, anchor)) return;
      if (crossingGap(point)) return leave();
      hide();
    }, 600);
  }
  async function refresh() {
    if (getOpenMode() === 'off') return hide();
    if (!visible || !ready) return;
    if (getOpenMode() === 'click' && !activated) return hide();
    const request = ++revision;
    try {
      const payload = await read(key);
      if (request !== revision || !visible) return;
      if (payload === undefined) return; // superseded read, not a removed account
      if (!payload || payload.source !== source) return hide();
      send(payload);
    } catch (error) { logger(`[limits-history] ${error.message}`); }
  }
  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    ready = false;
    win = new BrowserWindow({
      width: 310, height: 420, show: false, frame: false, focusable: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, transparent: !(process.platform === 'win32' && getMaterialOptions().enabled), backgroundColor: '#00000000',
      hasShadow: true,
      ...(process.platform === 'darwin' ? { type: 'panel', acceptFirstMouse: true, vibrancy: 'hud', visualEffectState: 'active' } : {}),
      ...(process.platform === 'win32' && getMaterialOptions().enabled ? { backgroundMaterial: 'acrylic' } : {}),
      webPreferences: { preload: path.join(__dirname, 'historyPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    attachNativeMaterialVisibility(win, getMaterialOptions);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('did-finish-load', () => {
      ready = true;
      if (visible && currentPayload) send(currentPayload, true);
    });
    win.on('closed', () => { hide(); win = null; ready = false; });
    win.loadFile(path.join(__dirname, '../renderer/limits/history.html')).catch(error => {
      logger(`[limits-history] ${error.message}`);
      hide();
    });
    return win;
  }

  async function open(sender, request) {
    const parent = BrowserWindow.fromWebContents(sender);
    if (!parent || !isOwner(parent) || !parent.isVisible() || getOpenMode() === 'off') return false;
    if (typeof request?.key !== 'string' || request.key.length > 2048) return false;
    const rect = request.rect;
    if (!rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k]))) return false;
    const interactive = request.interactive === true;
    if (!interactive && (getOpenMode() === 'click' || activated || containsPoint(screen.getCursorScreenPoint()))) return false;
    if (visible && owner === parent && key === request.key) {
      cancelClose();
      if (interactive) {
        if (activated) hide();
        else activated = true;
      }
      return true;
    }
    // Loading the reusable renderer and reading SQLite need not wait for each other.
    const panel = ensureWindow();
    const requestRevision = ++revision;
    pendingOpen = { parent, key: request.key, interactive };
    const cancelPending = () => {
      if (requestRevision === revision) { pendingOpen = null; revision += 1; }
    };
    parent.once('blur', cancelPending);
    let payload;
    try { payload = await read(request.key); }
    catch (error) {
      if (requestRevision === revision) pendingOpen = null;
      logger(`[limits-history] ${error.message}`);
      return false;
    }
    finally { parent.removeListener('blur', cancelPending); }
    if (requestRevision !== revision) return false;
    pendingOpen = null;
    if (!payload || getOpenMode() === 'off' || parent.isDestroyed() || !parent.isVisible() || !interactive && getOpenMode() === 'click') return false;
    if (owner !== parent) {
      hide();
      owner = parent;
      for (const event of ['blur', 'hide', 'closed', 'move', 'resize', 'minimize']) {
        const listener = () => hide();
        owner.on(event, listener);
        ownerListeners.push([event, listener]);
      }
    }
    cancelClose();
    animatePlacement = visible && key !== request.key;
    key = request.key;
    source = payload.source;
    currentPayload = payload;
    const opening = !visible || !panel.isVisible();
    visible = true;
    activated = interactive;
    parent.webContents.send('limitsHistory:state', true, key);
    const bounds = parent.getBounds();
    const zoom = parent.webContents.getZoomFactor();
    anchor = { x: bounds.x + rect.x * zoom, y: bounds.y + rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
    panel.webContents.setZoomFactor(zoom);
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const target = historyBounds(bounds, rect, workArea, zoom);
    placement = { bounds: target, workArea };
    if (opening) panel.setBounds(target);
    if (ready) send(payload, opening);
    return true;
  }

  function containsPoint(point) {
    if (!visible || !win?.isVisible()) return false;
    return inside(point, win.getBounds());
  }

  function register() {
    ipcMain.handle('limitsHistory:open', (event, request) => open(event.sender, request));
    ipcMain.on('limitsHistory:leave', (event, leavingKey) => {
      if (event.sender === pendingOpen?.parent.webContents && leavingKey === pendingOpen.key && !pendingOpen.interactive) {
        pendingOpen = null;
        revision += 1;
      }
      if (event.sender === win?.webContents || event.sender === owner?.webContents && leavingKey === key) leave();
    });
    ipcMain.on('limitsHistory:enter', (event, enteringKey) => {
      if (event.sender === win?.webContents) {
        cancelClose();
        if (pendingOpen && !pendingOpen.interactive) { pendingOpen = null; revision += 1; }
      } else if (event.sender === owner?.webContents && enteringKey === key) cancelClose();
    });
    ipcMain.on('limitsHistory:close', event => {
      if (event.sender === win?.webContents || event.sender === owner?.webContents || event.sender === pendingOpen?.parent.webContents) {
        hide();
      }
    });
    ipcMain.on('limitsHistory:resize', (event, height, renderToken, animate, reduce) => {
      if (event.sender !== win?.webContents || !visible || !Number.isFinite(height) || renderToken !== expectedRender) return;
      rendererReducedMotion = reduce === true;
      const workArea = placement.workArea;
      const nextHeight = Math.min(Math.max(250, Math.ceil(height * win.webContents.getZoomFactor())), workArea.height - 16);
      const target = { ...placement.bounds, height: nextHeight,
        y: Math.round(Math.max(workArea.y + 8, Math.min(anchor.y - 22, workArea.y + workArea.height - nextHeight - 8))) };
      placeFrame(target, animatePlacement || animate === true);
      animatePlacement = false;
      if (!win.isVisible()) win.showInactive();
    });
  }

  function dispose() {
    hide();
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }
  return { register, refresh, hide, containsPoint, syncMaterial, dispose };
}

module.exports = { createLimitsHistoryController, historyBounds };
