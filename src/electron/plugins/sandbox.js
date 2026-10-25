'use strict';

// Process isolation for plugin code. Each plugin with code gets its own hidden,
// Chromium-sandboxed renderer on an in-memory session with every permission,
// navigation, download and non-plugin request denied. The host page runs the
// plugin in a Worker whose inherited CSP has no network, script or frame
// sources, so a plugin can only talk to main through validated messages.
//
// A separate process per plugin is deliberate: one plugin exhausting memory or
// crashing its renderer cannot take others with it, and app.getAppMetrics()
// attributes CPU and memory to the plugin that used them.

const fs = require('node:fs');
const path = require('node:path');

const SCHEME = 'tm-plugin';
const PARTITION = 'tm-plugins';
const HOST_DIR = path.join(__dirname, 'host');
const HOST_FILES = Object.freeze({ '/host.html': 'text/html; charset=utf-8', '/runtime.js': 'text/javascript; charset=utf-8', '/message.js': 'text/javascript; charset=utf-8' });
const PLUGIN_HOST_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const { MAX_CODE_BYTES } = require('./contracts');

// The Worker is created from a blob: URL and inherits this policy, so plugin
// code has no fetch/XHR/WebSocket/EventSource (connect-src), cannot import or
// eval script (script-src), and cannot open frames or nested documents.
const HOST_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  'worker-src blob:',
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

// Must run before app 'ready'. `standard` gives each plugin id its own origin
// (and with site isolation its own process); `secure` keeps Worker and crypto
// APIs available without granting any network privilege.
const PLUGIN_SCHEME = Object.freeze({ scheme: SCHEME, privileges: Object.freeze({ standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false }) });
function registerPluginScheme(protocol) {
  protocol.registerSchemesAsPrivileged([PLUGIN_SCHEME]);
}

function hostUrl(pluginId) {
  return `${SCHEME}://${pluginId}/host.html`;
}

function requestAllowed(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${SCHEME}:`) return Object.hasOwn(HOST_FILES, parsed.pathname) && PLUGIN_HOST_RE.test(parsed.hostname);
    return parsed.protocol === 'blob:' || parsed.protocol === 'devtools:';
  } catch {
    return false;
  }
}

function readPluginCode(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_CODE_BYTES) throw new Error(`main code must be a file under ${MAX_CODE_BYTES / 1024} KB`);
  return fs.readFileSync(file, 'utf8');
}

function workerSource(code) {
  const message = fs.readFileSync(path.join(HOST_DIR, 'message.js'), 'utf8');
  const prelude = fs.readFileSync(path.join(HOST_DIR, 'prelude.js'), 'utf8');
  // The plugin body gets its own function scope so its declarations cannot
  // collide with the prelude; `self` and `tm` remain its globals.
  return `${message}\n${prelude}\n;(function pluginMain() {\n${code}\n}).call(self);\nself.postMessage({ type: 'ready' });\n`;
}

function createPluginSandbox({ electron, onMessage, onExit, log = () => {} }) {
  const { BrowserWindow, session, app } = electron;
  const processes = new Map();
  let ses = null;

  function ensureSession() {
    if (ses) return ses;
    ses = session.fromPartition(PARTITION, { cache: false });
    ses.protocol.handle(SCHEME, async (request) => {
      const url = new URL(request.url);
      const type = HOST_FILES[url.pathname];
      if (!type || !PLUGIN_HOST_RE.test(url.hostname)) return new Response('', { status: 404 });
      const body = await fs.promises.readFile(path.join(HOST_DIR, url.pathname.slice(1)));
      return new Response(body, {
        headers: {
          'content-type': type,
          'content-security-policy': HOST_CSP,
          'x-content-type-options': 'nosniff',
          'x-dns-prefetch-control': 'off',
          'cache-control': 'no-store'
        }
      });
    });
    // Defence in depth behind the CSP: nothing but the host page, its script
    // and the Worker blob may load in this session, whatever a plugin tries.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = requestAllowed(details.url);
      if (!allowed) log(`[plugins] blocked request from sandbox: ${String(details.url).slice(0, 120)}`);
      callback({ cancel: !allowed });
    });
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler?.(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    ses.setSpellCheckerEnabled?.(false);
    return ses;
  }

  function exit(pluginId, reason, expected = processes.get(pluginId)) {
    const record = processes.get(pluginId);
    if (!record || record !== expected) return;
    processes.delete(pluginId);
    try { if (!record.win.isDestroyed()) record.win.destroy(); } catch {}
    if (!record.stopping) onExit(pluginId, reason);
  }

  function start(pluginId, { codeFile }) {
    if (!PLUGIN_HOST_RE.test(pluginId)) throw new Error('invalid plugin id');
    stop(pluginId);
    const source = workerSource(readPluginCode(codeFile));
    const win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      focusable: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: false,
      webPreferences: {
        session: ensureSession(),
        preload: path.join(HOST_DIR, 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        enableWebSQL: false,
        webgl: false,
        images: false,
        spellcheck: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        autoplayPolicy: 'document-user-activation-required',
        // Main drives the schedule with explicit ticks; Chromium must not
        // stretch the host page's watchdog timers while it is hidden.
        backgroundThrottling: false
      }
    });
    const webContents = win.webContents;
    const record = { win, webContents, booted: false, stopping: false, startedAt: Date.now(), privateKB: 0 };
    processes.set(pluginId, record);
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.on('will-navigate', (event) => event.preventDefault());
    webContents.on('will-redirect', (event) => event.preventDefault());
    webContents.on('will-frame-navigate', (event) => {
      if (event.url !== hostUrl(pluginId)) event.preventDefault();
    });
    webContents.on('will-attach-webview', (event) => event.preventDefault());
    webContents.setWebRTCIPHandlingPolicy?.('disable_non_proxied_udp');
    webContents.on('render-process-gone', (_event, details) => exit(pluginId, `crashed:${details?.reason || 'unknown'}`, record));
    webContents.on('unresponsive', () => exit(pluginId, 'unresponsive', record));
    webContents.on('did-fail-load', (_event, code, description) => exit(pluginId, `load-failed:${code}:${description}`, record));
    webContents.ipc.on('plugin-host:memory', (_event, privateKB) => {
      if (processes.get(pluginId) === record && Number.isFinite(privateKB) && privateKB >= 0) record.privateKB = privateKB;
    });
    // ipc scoped to this webContents: the sender, not the payload, names the plugin.
    webContents.ipc.on('plugin-host:message', (_event, message) => {
      if (!processes.has(pluginId) || processes.get(pluginId) !== record) return;
      if (message?.type === 'host-ready' && !record.booted) {
        record.booted = true;
        webContents.send('plugin-host:message', { type: 'boot', source });
        return;
      }
      if (message?.type === 'fatal') {
        exit(pluginId, typeof message.reason === 'string' ? message.reason : 'fatal', record);
        return;
      }
      onMessage(pluginId, message);
    });
    win.loadURL(hostUrl(pluginId)).catch((error) => exit(pluginId, `load-failed:${error.message}`, record));
    return record;
  }

  function stop(pluginId) {
    const record = processes.get(pluginId);
    if (!record) return;
    record.stopping = true;
    exit(pluginId, 'stopped');
  }

  function kill(pluginId, reason) {
    const record = processes.get(pluginId);
    if (!record) return;
    try { record.webContents.forcefullyCrashRenderer(); } catch {}
    exit(pluginId, reason);
  }

  function send(pluginId, message) {
    const record = processes.get(pluginId);
    if (!record?.booted || record.webContents.isDestroyed()) return false;
    record.webContents.send('plugin-host:message', message);
    return true;
  }

  // Per-plugin CPU (percent of one core) and resident memory from Chromium's
  // own process accounting.
  function metrics() {
    const byPid = new Map(app.getAppMetrics().map((entry) => [entry.pid, entry]));
    const out = {};
    for (const [pluginId, record] of processes) {
      let pid = 0;
      try { pid = record.webContents.getOSProcessId(); } catch {}
      const entry = byPid.get(pid);
      out[pluginId] = {
        pid,
        cpuPercent: entry ? Math.round((entry.cpu?.percentCPUUsage || 0) * 10) / 10 : 0,
        memoryMB: Math.round(Math.max(record.privateKB, entry?.memory?.workingSetSize || 0) / 102.4) / 10
      };
    }
    return out;
  }

  return {
    start,
    stop,
    kill,
    send,
    metrics,
    running: () => [...processes.keys()],
    owns: (win) => [...processes.values()].some((record) => record.win === win),
    isRunning: (pluginId) => processes.has(pluginId),
    stopAll() {
      for (const pluginId of [...processes.keys()]) stop(pluginId);
    }
  };
}

module.exports = {
  HOST_CSP,
  PLUGIN_SCHEME,
  PARTITION,
  SCHEME,
  createPluginSandbox,
  hostUrl,
  readPluginCode,
  registerPluginScheme,
  requestAllowed,
  workerSource
};
