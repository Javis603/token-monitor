'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TYPES, TARGETS, pageSnapshot } = require('../../shared/plugins/webUi');
const { readBounded } = require('./package');
const { createRateLimiter } = require('./supervisor');
const { capabilityError, createCapabilityLane, isCapabilityRequest } = require('./capabilities');
const { publicSettings } = require('./settings');
// Internal resource policy; not author-controlled or a user-facing setting.
const WARM_TTL_MS = 30_000, WARM_LIMIT = 3, WARM_MEMORY_KB = 256 * 1024, LIFECYCLE_TIMEOUT_MS = 750;
const SCHEME = 'tm-plugin-ui';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
const CONNECTION_ALLOWLIST = '(response-origin);webrtc=block';
const NETWORK_FEATURES = ['ConnectionAllowlists', 'OverrideConnectionAllowlistOriginTrial'];
const WEB_UI_SCHEME = Object.freeze({ scheme: SCHEME, privileges: Object.freeze({ standard: true, secure: true }) });
// Chromium 150 requires the origin-trial override for this native policy.
// CSP connect-src, browser permissions and WebRequest do not cover WebRTC.
// Activate support before ready; only responses carrying our header opt in.
function configureWebUiNetworkIsolation(commandLine) {
  const names = value => value.split(',').map(entry => entry.trim()).filter(Boolean);
  const featureName = entry => entry.split(/[<:]/, 1)[0];
  const disabled = names(commandLine.getSwitchValue('disable-features')).map(featureName);
  if (NETWORK_FEATURES.some(name => disabled.includes(name))) throw new Error('Rich UI network isolation cannot be disabled');
  const enabled = names(commandLine.getSwitchValue('enable-features'));
  for (const name of NETWORK_FEATURES) if (!enabled.some(entry => featureName(entry) === name)) enabled.push(name);
  commandLine.appendSwitch('enable-features', enabled.join(','));
}
function registerWebUiScheme(protocol, commandLine = require('electron').app.commandLine) {
  configureWebUiNetworkIsolation(commandLine);
  protocol.registerSchemesAsPrivileged([WEB_UI_SCHEME]);
}
function boundsFor(raw, size, zoom = 1, minimum = 40) {
  if (!raw || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(raw[key]))) return null;
  const x = Math.max(0, Math.ceil(raw.x * zoom)), y = Math.max(0, Math.ceil(raw.y * zoom));
  const width = Math.min(Math.floor(raw.width * zoom), size[0] - x);
  const height = Math.min(Math.floor(raw.height * zoom), size[1] - y);
  return width >= minimum && height >= minimum ? { x, y, width, height } : null;
}
function themeContext(raw) {
  const colors = {};
  for (const key of ['background', 'text', 'muted', 'accent', 'border']) {
    const value = raw?.colors?.[key];
    if (typeof value === 'string' && /^(#[a-f0-9]{3,8}|rgba?\([0-9.,% /]+\))$/i.test(value)) colors[key] = value;
  }
  return { colors, dark: raw?.dark !== false, reducedMotion: raw?.reducedMotion === true, font: typeof raw?.font === 'string' && raw.font.length <= 512 && /^[\p{L}\p{N}\s,.'"_-]+$/u.test(raw.font) ? raw.font : 'system-ui' };
}
function createWebUi({ electron, manager, bus, isMainSender, surfaceContext = () => null, surfacePlaced = () => false, presentationContext = () => null, documentCapabilities = {}, file }) {
  const { WebContentsView, BrowserWindow, ipcMain, session } = electron;
  let selections = {}, disposed = false;
  const mounted = new Map(), parked = new Map();
  const allItems = () => [...mounted.values(), ...parked.keys()];
  const sessions = new Map();
  try { const raw = JSON.parse(readBounded(file, 8192)); selections = Object.fromEntries(TARGETS.filter(k => typeof raw[k] === 'string').map(k => [k, raw[k].slice(0, 80)])); } catch {}
  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(temp, file);
    selections = next;
  }
  const channel = (item, name) => `plugins:${item.presentation ? 'presentation' : item.floating ? 'surface' : 'web'}:${name}`;
  const viewRefFor = info => info.document.target === 'settings' ? info.pluginId : `${info.pluginId}/${info.document.view}`;
  function authorized(item, allowHidden = false) {
    manager.webDocument(item.ref);
    if (item.presentation) {
      const scope = presentationContext({ sender: item.host, senderFrame: item.host.mainFrame }, item.target, viewRefFor(item));
      if (!scope || !allowHidden && !scope.visible) throw new Error('presentation owner revoked');
    }
  }
  function stop(reason = '', key = 'main') {
    const old = mounted.get(key);
    if (old) destroy(old, reason);
  }
  function destroy(old, reason = '') {
    if (old.dead) return;
    old.dead = true;
    old.capabilityLane.close();
    if (mounted.get(old.key) === old) mounted.delete(old.key);
    parked.delete(old);
    clearTimeout(old.expiry); clearTimeout(old.lifecycleDeadline);
    old.view.webContents.debugger.removeListener('detach', old.detached);
    clearInterval(old.watchdog); clearTimeout(old.resizeDeadline); bus.clearDemand(old.owner); manager.setWebVisible(old.owner, null); old.unsubscribe?.(); documentCapabilities.release?.(old.owner);
    old.window.removeListener('hide', old.hidden); old.window.removeListener('minimize', old.hidden); old.window.removeListener('closed', old.closed);
    try { old.window.contentView.removeChildView(old.view); } catch {}
    if (!old.view.webContents.isDestroyed()) old.view.webContents.close({ waitForBeforeUnload: false });
    old.assets = {};
    old.window.removeListener('resize', old.resized);
    old.host.removeListener('render-process-gone', old.closed);
    old.host.removeListener('destroyed', old.closed);
    if (old.floating && !old.parked && !old.window.isDestroyed()) { old.window.setFocusable(false); old.host.focus(); }
    if (reason && !old.parked && !old.host.isDestroyed()) old.host.send(channel(old, 'failed'), old.floating || old.presentation ? { ref: old.ref, instance: old.instance, reason } : reason);
  }
  function presentationMemory() {
    const metrics = electron.app?.getAppMetrics?.() || [];
    const pids = new Set([...mounted.values()].filter(item => item.presentation).map(item => item.view.webContents.getOSProcessId()));
    return [...pids].reduce((total, pid) => total + (metrics.find(metric => metric.pid === pid)?.memory?.workingSetSize || 0), 0);
  }
  function trimCache() {
    const metrics = electron.app?.getAppMetrics?.() || [];
    const bytes = () => {
      const pids = new Set([...parked.keys()].map(item => item.view.webContents.getOSProcessId()));
      // Without a resident-memory reading there is no verified cache budget.
      return [...pids].reduce((total, pid) => total + (metrics.find(m => m.pid === pid)?.memory?.workingSetSize ?? Infinity), 0);
    };
    while (parked.size && (parked.size > WARM_LIMIT || bytes() > WARM_MEMORY_KB)) destroy(parked.keys().next().value);
  }
  function transition(item, state, complete) {
    const epoch = ++item.epoch;
    item.resuming = true;
    clearTimeout(item.lifecycleDeadline);
    item.lifecycleDeadline = setTimeout(() => destroy(item, 'load-failed'), LIFECYCLE_TIMEOUT_MS);
    // Serialize freeze/thaw even when hover reverses before Chromium replies.
    item.lifecycle = item.lifecycle.then(async () => {
      if (item.dead) return;
      const debug = item.view.webContents.debugger;
      if (!item.ownsDebugger) {
        if (debug.isAttached()) throw new Error('lifecycle control unavailable');
        debug.attach('1.3'); item.ownsDebugger = true;
      }
      await debug.sendCommand('Page.setWebLifecycleState', { state });
      if (item.dead || item.epoch !== epoch) return;
      item.resuming = false;
      if (state === 'frozen') clearTimeout(item.lifecycleDeadline);
      complete(epoch);
    }).catch(() => destroy(item, 'load-failed'));
  }
  function park(key) {
    const item = mounted.get(key);
    if (!item) return;
    // Incomplete/failed documents never enter the cache or finish in hiding.
    if (!item.ready || item.awaitingResume || disposed || item.document.retainMs === 0) { destroy(item); return; }
    item.capabilityLane.close();
    mounted.delete(key); item.parked = true; item.present = false;
    if (item.presentation && item.view.webContents.isFocused()) item.host.focus();
    item.view.setVisible(false); clearTimeout(item.resizeDeadline);
    bus.clearDemand(item.owner); manager.setWebVisible(item.owner, null); documentCapabilities.release?.(item.owner);
    if (item.floating && !item.window.isDestroyed()) { item.window.setFocusable(false); item.host.focus(); }
    parked.set(item, true);
    const retainMs = item.document.retainMs ?? WARM_TTL_MS;
    if (retainMs !== 'until-evicted') {
      // Node timers overflow past ~24.8 days. Chunk long author durations
      // against a monotonic deadline instead of silently expiring after 1ms.
      const deadline = performance.now() + retainMs;
      const expire = () => {
        if (item.dead || !item.parked) return;
        const remaining = deadline - performance.now();
        if (remaining <= 0) { destroy(item); return; }
        item.expiry = setTimeout(expire, Math.min(2147483647, Math.ceil(remaining)));
        item.expiry.unref?.();
      };
      expire();
    }
    transition(item, 'frozen', () => {});
    trimCache();
  }
  function resume(item) {
    parked.delete(item); clearTimeout(item.expiry); item.parked = false;
    item.capabilityLane = createCapabilityLane();
    item.awaitingResume = true; item.authorityRestored = false; mounted.set(item.key, item);
    transition(item, 'active', epoch => {
      // Capability, placement and host ownership are rechecked at adoption;
      // changes during the async thaw also destroy the retained document.
      authorized(item);
      if (item.target !== 'settings') manager.setWebVisible(item.owner, item.ref);
      if (item.sources.length) bus.setDemand(item.owner, { sources: item.sources.map(s => manager.webSource(item.ref, s)), intervalMs: manager.webDocument(item.ref).manifest.visible.intervalMs });
      item.view.webContents.send('plugins:web:context', item.context);
      item.view.webContents.send('plugins:web:data', reading(item));
      if (manager.getPublicAuthorSettings) {
        try { item.view.webContents.send('plugins:web:settings', manager.getPublicAuthorSettings(item.pluginId)); } catch { /* No schema is a valid document. */ }
      }
      item.view.webContents.send('plugins:web:resume', epoch);
    });
  }
  function allowed(event, charge = true) {
    const item = [...mounted.values()].find(item => item.view.webContents === event.sender);
    if (!item || item.resuming || event.sender !== item.view.webContents || event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== item.url) throw new Error('document capability revoked');
    authorized(item);
    if (charge && !item.limiter.take()) { stop('rate-limit', item.key); throw new Error('web UI rate limit'); }
    return item;
  }
  // Lifecycle interruptions are not author errors: the bridge keeps the
  // subscription intent and replays it once the document is restored.
  const suspendedReply = () => ({ __tmCapability: 1, ok: false, error: capabilityError(Object.assign(new Error('capability suspended'), { code: 'capability-suspended' })) });
  function suspended(event) {
    const item = allItems().find(item => item.view.webContents === event.sender);
    return !!item && !item.dead && event.senderFrame === event.sender.mainFrame && (item.parked || item.resuming || item.awaitingResume && !item.authorityRestored);
  }
  function reading(item) {
    return Object.fromEntries(item.sources.map(source => [source, bus.read(manager.webSource(item.ref, source))]));
  }
  ipcMain.handle('plugins:web:call', (event, op, args) => {
    const request = isCapabilityRequest(op, args);
    if (request && suspended(event)) return suspendedReply();
    const item = allowed(event, !request);
    if (op === 'resumed') {
      // Authority returns first so the bridge can replay subscriptions; the
      // retained DOM stays hidden until their initial snapshots have landed.
      if (!item.awaitingResume || item.authorityRestored || args !== item.epoch) return false;
      item.authorityRestored = true; clearTimeout(item.lifecycleDeadline);
      // Lifecycle control is held only while parked/thawing, so ordinary
      // developer tools remain available on an active document.
      if (item.ownsDebugger) { item.ownsDebugger = false; item.view.webContents.debugger.detach(); }
      // A slow refresh must not reveal stale DOM: discard the cached copy and
      // let the host load a fresh document instead.
      item.lifecycleDeadline = setTimeout(() => {
        if (item.dead || !item.awaitingResume) return;
        destroy(item);
        if (!item.host.isDestroyed()) item.host.send(channel(item, 'ready'));
      }, LIFECYCLE_TIMEOUT_MS);
      return true;
    }
    if (op === 'refreshed') {
      if (!item.awaitingResume || !item.authorityRestored || args !== item.epoch) return false;
      item.awaitingResume = false; item.authorityRestored = false; clearTimeout(item.lifecycleDeadline);
      item.host.send(channel(item, 'ready'));
      return true;
    }
    if (op === 'present') {
      item.prepared = true;
      notifyReady(item);
      return true;
    }
    if (op === 'context') return item.context;
    if (['data.query', 'data.subscribe', 'data.unsubscribe', 'settings.get', 'settings.update', 'settings.reset'].includes(op)) {
      if (!documentCapabilities.call) throw new Error('unsupported capability');
      if (!request) throw new Error('invalid capability request');
      const epoch = item.epoch;
      let pending;
      try {
        pending = item.capabilityLane.run(op, args, () => {
          if (item.dead || item.parked || item.epoch !== epoch || mounted.get(item.key) !== item) throw new Error('document capability revoked');
          authorized(item);
          return documentCapabilities.call(item, op, args);
        });
      } catch (error) {
        if (error.code === 'request-limit') destroy(item, 'rate-limit');
        throw error;
      }
      return pending.then(value => {
        if (item.dead || item.parked || item.epoch !== epoch || mounted.get(item.key) !== item) throw new Error('document capability revoked');
        authorized(item);
        return { __tmCapability: 1, ok: true, value };
      }).catch(error => item.epoch !== epoch && !item.dead ? suspendedReply() : { __tmCapability: 1, ok: false, error: capabilityError(error) });
    }
    if (op === 'subscribe') {
      if (item.target === 'settings') throw new Error('settings documents use the business data API');
      if (!Array.isArray(args) || args.length > 16 || !args.every(s => typeof s === 'string' && manager.webReadAllowed(item.ref, s))) throw new Error('source permission denied');
      item.sources = [...new Set(args)];
      const intervalMs = manager.webDocument(item.ref).manifest.visible.intervalMs;
      bus.setDemand(item.owner, { sources: item.sources.map(source => manager.webSource(item.ref, source)), intervalMs });
      return reading(item);
    }
    if (op === 'restore') {
      if (item.floating || item.presentation) throw new Error('restore is only available for original App pages');
      const next = { ...selections }; delete next[item.target]; save(next); item.host.send('plugins:web:restore'); stop(); return true;
    }
    if (['get', 'set', 'delete'].includes(op)) return manager.webStorage(item.ref, op, args?.key, args?.value);
    if (op === 'send') {
      return Promise.resolve().then(() => manager.webSend(item.ref, args))
        .then(value => ({ __tmCapability: 1, ok: true, value }), error => ({ __tmCapability: 1, ok: false, error: capabilityError(error) }));
    }
    throw new Error('unsupported capability');
  });
  const offSettings = manager.onAuthorSettings?.((pluginId, value) => {
    for (const item of mounted.values()) {
      if (item.pluginId !== pluginId || item.dead || item.resuming || item.awaitingResume && !item.authorityRestored) continue;
      try { authorized(item); item.view.webContents.send('plugins:web:settings', publicSettings(value)); } catch { destroy(item, 'unavailable'); }
    }
  });
  const changed = manager.onChanged(() => {
    for (const item of allItems()) {
      try { authorized(item, item.parked); if (manager.webDocument(item.ref).revision !== item.revision) destroy(item, 'changed'); } catch { destroy(item, 'unavailable'); }
    }
  });
  function mount(host, info, rect, context, key = 'main', floating = null, contentScale = 1, present = true) {
    const win = BrowserWindow.fromWebContents(host);
    if (!win || !win.isVisible() || win.isMinimized()) { park(key); return; }
    const bounds = boundsFor(rect, win.getContentSize(), host.getZoomFactor(), floating?.kind === 'rail' ? 16 : 40);
    if (!bounds) { park(key); return; }
    let current = mounted.get(key);
    if (current && (current.ref !== info.ref || current.revision !== info.revision || current.host !== host)) { park(key); current = null; }
    if (!current) {
      const cached = [...parked.keys()].find(item => item.key === key && item.ref === info.ref && item.revision === info.revision && item.host === host);
      if (cached) {
        current = cached; current.context = context; current.present = present;
        current.view.setBounds(bounds); current.view.webContents.setZoomFactor(host.getZoomFactor() * contentScale);
        resume(current);
      }
    }
    if (!current) {
      // Discovery owns validated bytes for this revision; mounting never rereads a package.
      const assets = info.assets;
      if (!assets || !Object.hasOwn(assets, info.document.entry)) throw new Error('document assets unavailable');
      const origin = `${SCHEME}://${crypto.randomBytes(12).toString('hex')}`;
      const url = `${origin}/${info.document.entry}`;
      let ses = sessions.get(info.pluginId);
      if (!ses) {
        ses = session.fromPartition(`tm-web-${info.pluginId}`, { cache: false }); sessions.set(info.pluginId, ses);
        ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        ses.setPermissionCheckHandler(() => false);
        ses.on('will-download', event => event.preventDefault());
        ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allItems().some(item => item.session === ses && details.url.startsWith(`${item.origin}/`)) }));
        ses.protocol.handle(SCHEME, request => {
          const item = allItems().find(item => item.session === ses && request.url.startsWith(`${item.origin}/`));
          if (!item || item.session !== ses || request.method !== 'GET' || !request.url.startsWith(`${item.origin}/`)) return new Response('', { status: 403 });
          const name = request.url.slice(item.origin.length + 1);
          if (!Object.hasOwn(item.assets, name)) return new Response('', { status: 404 });
          return new Response(item.assets[name], { headers: { 'Content-Type': TYPES[name.split('.').at(-1)], 'Content-Security-Policy': CSP, 'Connection-Allowlist': CONNECTION_ALLOWLIST, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
        });
      }
      const view = new WebContentsView({ webPreferences: { session: ses, preload: path.join(__dirname, 'webPreload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, navigateOnDragDrop: false, backgroundThrottling: true, spellcheck: false } });
      view.setBackgroundColor(floating ? '#00000000' : context.theme.colors.background || '#17191c');
      const item = { ...info, key, floating, ref: info.ref, target: info.document.target, host, window: win, view, session: ses, assets, origin, url, context, ready: false, loaded: false, prepared: false, present, sources: [], owner: `web:${view.webContents.id}`, capabilityLane: createCapabilityLane(), limiter: createRateLimiter({ capacity: 100, perSecond: 30 }), dead: false, parked: false, epoch: 0, lifecycle: Promise.resolve(), hidden: () => { if (mounted.get(key) === item) park(key); }, closed: () => destroy(item), detached: () => { if (item.ownsDebugger) destroy(item, 'load-failed'); }, resized: () => { if (mounted.get(key) === item) suspendGeometry(key); } };
      mounted.set(key, item);
      view.webContents.debugger.on('detach', item.detached);
      if (item.target !== 'settings') manager.setWebVisible(item.owner, item.ref);
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) view.webContents.on(name, event => event.preventDefault());
      view.webContents.on('render-process-gone', () => { destroy(item, 'renderer-stopped'); });
      view.webContents.on('unresponsive', () => { destroy(item, 'unresponsive'); });
      item.unsubscribe = bus.subscribe(ids => { if (mounted.get(key) === item && !item.resuming && item.sources.some(s => ids.has(manager.webSource(item.ref, s)))) view.webContents.send('plugins:web:data', reading(item)); });
      for (const event of ['hide', 'minimize']) win.on(event, item.hidden);
      win.on('closed', item.closed);
      win.on('resize', item.resized);
      host.on('render-process-gone', item.closed);
      host.on('destroyed', item.closed);
      if (floating) attachSurfaceInput(item);
      if (item.presentation) {
        view.webContents.on('before-input-event', (event, input) => {
          if (input.key === 'Escape' && input.type === 'keyDown') { event.preventDefault(); host.focus(); }
        });
      }
      let outstanding = false;
      item.watchdog = setInterval(() => {
        const metrics = electron.app?.getAppMetrics?.().find(metric => metric.pid === view.webContents.getOSProcessId());
        if ((metrics?.memory?.workingSetSize || 0) > 256 * 1024) { destroy(item, 'memory-budget'); return; }
        trimCache();
        if (item.presentation && !item.parked && presentationMemory() > 512 * 1024) { destroy(item, 'memory-budget'); return; }
        if (item.dead || item.parked || item.resuming || item.awaitingResume) return;
        if (outstanding) { destroy(item, 'unresponsive'); return; }
        outstanding = true;
        view.webContents.executeJavaScript('0').catch(() => {}).finally(() => { outstanding = false; });
      }, 5000); item.watchdog.unref?.();
      // Reveal only after navigation and initial bridge setup have settled.
      view.setVisible(false);
      view.webContents.once('did-finish-load', () => {
        if (mounted.get(key) !== item || host.isDestroyed()) return;
        item.loaded = true;
        notifyReady(item);
      });
      win.contentView.addChildView(view); view.setBounds(bounds); view.webContents.setZoomFactor(host.getZoomFactor() * contentScale);
      void view.webContents.loadURL(url).catch(() => { if (mounted.get(key) === item) stop('load-failed', key); });
    } else {
      clearTimeout(current.resizeDeadline); current.present = present; current.context = context; current.view.setBounds(bounds); current.view.setVisible(current.ready && !current.resuming && !current.awaitingResume && present); current.view.webContents.setZoomFactor(host.getZoomFactor() * contentScale);
      if (!current.resuming) current.view.webContents.send('plugins:web:context', context);
    }
  }
  function notifyReady(item) {
    if (mounted.get(item.key) !== item || item.host.isDestroyed() || !item.loaded || !item.prepared || item.ready) return;
    item.ready = true;
    // Preparation includes the initial context/storage/subscription promises,
    // not merely navigation. The host still owns eligibility and reveal.
    item.host.send(channel(item, 'ready'));
  }
  function suspendGeometry(key) {
    const item = mounted.get(key);
    if (!item) return;
    if (item.presentation) { park(key); item.host.send(channel(item, 'ready')); return; }
    if (!item.floating) { stop('', key); return; }
    item.present = false; item.view.setVisible(false);
    clearTimeout(item.resizeDeadline);
    // A visible shell resize must not reload a document. If the host never
    // supplies a fresh rectangle, bounded teardown still releases its demand.
    item.resizeDeadline = setTimeout(() => { if (mounted.get(key) === item) stop('suspended', key); }, 750);
    item.host.send('plugins:surface:ready');
  }
  function requireMain(event) {
    if (!isMainSender(event) || event.senderFrame && event.senderFrame !== event.sender.mainFrame) throw new Error('main window required');
  }
  ipcMain.handle('plugins:web:select', (event, target, ref) => {
    requireMain(event);
    if (!TARGETS.includes(target)) throw new Error('unsupported target');
    const next = { ...selections };
    if (ref) { const info = manager.webDocument(ref); if (info.document.target !== target) throw new Error('target mismatch'); next[target] = ref; }
    else delete next[target];
    save(next); stop();
    for (const item of [...parked.keys()]) if (!item.floating && item.target === target) destroy(item);
    return { ...selections };
  });
  ipcMain.handle('plugins:web:sync', (event, input) => {
    requireMain(event);
    if (disposed || !input?.visible) { park('main'); return { selections }; }
    const snapshot = pageSnapshot(input.snapshot);
    const ref = selections[snapshot.target];
    if (!ref) { park('main'); return { selections }; }
    try {
      const info = manager.webDocument(ref);
      if (info.document.target !== snapshot.target) throw new Error('target mismatch');
      mount(event.sender, { ...info, ref }, input.rect, { snapshot, theme: themeContext(input.theme) });
      return { selections, mounted: mounted.get('main')?.ready === true && !mounted.get('main')?.resuming && !mounted.get('main')?.awaitingResume };
    } catch (error) { stop(); return { selections, error: error.message }; }
  });
  // Host-only batch: each native surface supplies its currently visible content
  // rectangles. Plugin documents cannot invoke this channel or name a host window.
  ipcMain.handle('plugins:surface:sync', (event, input) => {
    const host = event.sender;
    const scope = surfaceContext(event, input?.surface);
    if (!scope || event.senderFrame !== host.mainFrame) throw new Error('surface host required');
    const prefix = `surface:${host.id}:`;
    const keep = new Set(), refs = [];
    if (!disposed && (scope.visible || scope.preparing) && input?.visible && Array.isArray(input.entries)) {
      for (const entry of input.entries.slice(0, 16)) {
        try {
          const info = manager.webDocument(entry.ref);
          const viewRef = `${info.pluginId}/${info.document.view}`;
          if (info.document.target !== input.surface || info.document.variant !== (scope.kind === 'rail' ? 'compact' : 'full') || !surfacePlaced(viewRef, input.surface)) continue;
          const key = `${prefix}${entry.ref}`;
          // The host owns these bounds; entry scripts never supply geometry.
          const context = { locale: info.locale, surface: input.surface, variant: info.document.variant, theme: themeContext(input.theme), viewport: { width: entry.rect?.width, height: entry.rect?.height } };
          mount(host, { ...info, ref: entry.ref }, entry.rect, context, key, scope, Number.isFinite(entry.scale) ? Math.max(.5, Math.min(3, entry.scale)) : 1, scope.visible === true && entry.present !== false);
          if (mounted.has(key)) { keep.add(key); if (mounted.get(key).ready && !mounted.get(key).resuming && !mounted.get(key).awaitingResume && mounted.get(key).present) refs.push(entry.ref); }
        } catch { /* declarative fallback remains visible */ }
      }
    }
    for (const key of [...mounted.keys()]) if (key.startsWith(prefix) && !keep.has(key)) park(key);
    return { mounted: refs };
  });
  // Trusted host presentation only. The author bridge cannot name a window,
  // view, rectangle or instance. Main supplies independent placement authority.
  ipcMain.handle('plugins:presentation:sync', (event, input) => {
    const host = event.sender, surface = input?.surface;
    if (!['home', 'page', 'settings'].includes(surface) || event.senderFrame !== host.mainFrame || !presentationContext(event, surface, null)) throw new Error('presentation host required');
    const prefix = `presentation:${host.id}:${surface}:`, keep = new Set(), ready = [];
    if (!disposed && input.visible && Array.isArray(input.entries)) {
      for (const entry of input.entries.slice(0, 4)) {
        try {
          if (!entry || !/^[a-zA-Z0-9-]{1,64}$/.test(entry.instance)) continue;
          const info = manager.webDocument(entry.ref), viewRef = viewRefFor(info);
          if (info.document.target !== surface || (info.document.variant || 'full') !== 'full' || entry.viewRef !== viewRef || !presentationContext(event, surface, viewRef)?.visible) continue;
          const key = `${prefix}${entry.instance}:${entry.ref}`;
          if (keep.has(key)) continue;
          // Reject clipping instead of shifting the native document over shell UI.
          const rect = entry.rect, win = BrowserWindow.fromWebContents(host), zoom = host.getZoomFactor();
          if (!win || !rect || !['x','y','width','height'].every(k => Number.isFinite(rect[k])) || rect.x < 0 || rect.y < 0 || rect.width < 40 || rect.height < 40 || (rect.x + rect.width) * zoom > win.getContentSize()[0] || (rect.y + rect.height) * zoom > win.getContentSize()[1]) continue;
          // Active admission is separate from the bounded frozen cache.
          if (!mounted.has(key) && [...mounted.values()].filter(item => item.presentation).length >= 8 || !mounted.has(key) && presentationMemory() > 512 * 1024) continue;
          const context = { locale: info.locale, surface, variant: 'full', theme: themeContext(input.theme), viewport: { width: rect.width, height: rect.height } };
          mount(host, { ...info, ref: entry.ref, presentation: true, instance: entry.instance }, rect, context, key);
          const item = mounted.get(key);
          if (item) { keep.add(key); if (item.ready && !item.resuming && !item.awaitingResume) ready.push(entry.instance); }
        } catch { /* Preserve the lightweight fallback. */ }
      }
    }
    for (const key of [...mounted.keys()]) if (key.startsWith(prefix) && !keep.has(key)) park(key);
    return { mounted: ready };
  });
  function attachSurfaceInput(item) {
    const { view, host, window: win, floating, key } = item;
    // Native interception cannot be suppressed by author JS. Compact rail art
    // remains a host drag/click target, never an interactive mini browser.
    view.webContents.on('before-mouse-event', (event, mouse) => {
      if (mounted.get(key) !== item) return;
      if (floating.kind === 'rail') {
        event.preventDefault();
        const rect = view.getBounds();
        host.sendInputEvent({ ...mouse, x: mouse.x + rect.x, y: mouse.y + rect.y });
      } else if (mouse.type === 'mouseDown') {
        win.setFocusable(true); win.focus(); view.webContents.focus();
      }
    });
    view.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'Escape' && input.type === 'keyDown') {
        event.preventDefault(); win.setFocusable(false); host.focus();
        host.send('plugins:surface:escape');
      }
    });
    // Do not keep an always-on-top window keyboard-active after the user leaves.
    const blur = () => { if (!win.isDestroyed()) win.setFocusable(false); };
    win.on('blur', blur);
    view.webContents.once('destroyed', () => win.removeListener('blur', blur));
  }
  return { stop, presentations: () => [...mounted.values()].filter(item => item.presentation), cached: () => [...parked.keys()], current: () => mounted.get('main') || null, surfaces: () => [...mounted.values()].filter(item => item.floating),
    releasePresentationHost(host) {
      for (const item of allItems()) if (item.presentation && item.host === host) destroy(item);
    },
    refreshWindowVisibility(win) {
      // Covers original model/tool/device documents as well as presentations.
      // A host notification reconciles native state; it never revokes ownership.
      if (!win || win.isDestroyed()) return;
      if (win.isVisible() && !win.isMinimized()) return;
      for (const item of [...mounted.values()]) if (item.window === win) park(item.key);
    },
    refreshPresentations() {
      for (const item of allItems()) if (item.presentation) {
        try {
          authorized(item, true);
          const scope = presentationContext({ sender: item.host, senderFrame: item.host.mainFrame }, item.target, viewRefFor(item));
          if (!scope?.visible && !item.parked) park(item.key);
        } catch { destroy(item, 'unavailable'); }
      }
    },
    refreshSurfaces() {
      for (const item of allItems()) if (item.floating) {
        const scope = surfaceContext({ sender: item.host }, item.target);
        if (!surfacePlaced(`${item.pluginId}/${item.document.view}`, item.target)) destroy(item, 'suspended');
        else if (!item.parked && !scope?.visible && !scope?.preparing) park(item.key);
        else if (!item.parked && !scope.visible) { item.present = false; item.view.setVisible(false); }
      }
    },
    dispose() { disposed = true; for (const item of allItems()) destroy(item); changed(); offSettings?.(); for (const channel of ['plugins:web:call', 'plugins:web:select', 'plugins:web:sync', 'plugins:surface:sync', 'plugins:presentation:sync']) ipcMain.removeHandler(channel); for (const ses of sessions.values()) { ses.protocol.unhandle(SCHEME); void ses.clearStorageData(); } }
  };
}
module.exports = { SCHEME, CSP, WEB_UI_SCHEME, configureWebUiNetworkIsolation, registerWebUiScheme, boundsFor, themeContext, createWebUi };
