'use strict';
/* eslint preserve-caught-error: off -- Do not retain transport/crypto causes that may contain authorization material. */

// Convenience for trusted backends, not a sandbox against OS-user code.
// Raw Authorization stays in main. Each connection owns an ephemeral web session.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readRegularFileNoFollow, writePrivateJsonAtomic } = require('../../shared/credentialStore');
const { createSessionProxyApplier, sessionProxyConfig } = require('../networkProxy');
const keyPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Host-owned adapter. Plugin or renderer input cannot choose a bearer destination.
function connectionConfig(args) {
  if (args.adapter !== 'openai') throw Error('web-session-unsupported-adapter');
  return { loginUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    requestUrl: 'https://api.openai.com/v1/dashboard/billing/credit_grants', scopeHeaders: ['OpenAI-Organization'] };
}
// JWT expiry is a display/reconnect hint only; successful server capture is the
// authorization check. Opaque tokens have unknown expiry and rely on HTTP 401.
function authorizationExpiry(authorization) {
  try {
    const value = JSON.parse(Buffer.from(authorization.slice(7).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(value.exp) && value.exp > 0 && value.exp < 8640000000000 ? value.exp * 1000 : null;
  } catch { return null; }
}
function createPluginWebSessions({ electron, fetchImpl, directory, active, getSettings = () => ({}), timeoutMs = 180000, platform = process.platform, changed = () => {} }) {
  const { BrowserWindow, session, safeStorage, dialog } = electron;
  const live = new Map(), requests = new Map(), failures = new Map(), versions = new Map();
  let disposed = false;
  const identity = (id, key) => {
    if (!keyPattern.test(id) || !keyPattern.test(key)) throw Error('web-session-invalid-key');
    const ref = `${id}/${key}`;
    if (!versions.has(ref)) versions.set(ref, 0);
    return ref;
  };
  const file = ref => path.join(directory, `${ref.split('/')[0]}--${createHash('sha256').update(ref).digest('hex')}.json`);
  async function encryption() {
    const backend = safeStorage?.getSelectedStorageBackend?.();
    if (platform === 'linux' && !/^(gnome_libsecret|kwallet[56]?)$/.test(backend || '')) throw Error('web-session-secure-storage-unavailable');
    if (!safeStorage?.isAsyncEncryptionAvailable || !await safeStorage.isAsyncEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw Error('web-session-secure-storage-unavailable');
  }
  async function read(ref) {
    await encryption();
    try {
      const doc = JSON.parse(readRegularFileNoFollow(file(ref), { maxBytes: 65536 }));
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(doc.encrypted, 'base64'));
      const value = JSON.parse(decrypted.result);
      const config = connectionConfig({ adapter: 'openai' });
      if (value.requestUrl !== config.requestUrl || value.loginUrl !== config.loginUrl) throw Error('invalid-destination');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error('web-session-storage-unavailable');
    }
  }
  async function save(ref, value, current) {
    await encryption();
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(value));
    if (!current()) return false;
    writePrivateJsonAtomic(file(ref), { version: 1, encrypted: encrypted.toString('base64') });
    return true;
  }

  function stop(ref) {
    const entry = live.get(ref);
    if (!entry) return;
    live.delete(ref); clearTimeout(entry.timer);
    entry.browserSession?.webRequest.onBeforeSendHeaders(null);
    entry.browserSession?.webRequest.onCompleted(null);
    if (entry.window && !entry.window.isDestroyed()) entry.window.destroy();
    void entry.browserSession?.clearStorageData().catch(() => {});
  }
  function available(id) { if (disposed || !active(id)) throw Error('web-session-plugin-inactive'); }
  async function status(id, key) {
    available(id); const ref = identity(id, key);
    if (live.has(ref)) return { state: 'connecting' };
    if (failures.has(ref)) return { state: 'error', error: failures.get(ref) };
    const stored = await read(ref);
    available(id);
    if (stored?.expiresAt && stored.expiresAt <= Date.now()) return { state: 'reconnectRequired' };
    return { state: stored ? 'connected' : 'notConnected', ...(stored?.expiresAt ? { expiresAt: new Date(stored.expiresAt).toISOString() } : {}) };
  }
  async function connect(id, args) {
    available(id); const ref = identity(id, args.key), config = connectionConfig(args), version = versions.get(ref) || 0;
    await encryption();
    available(id);
    if (version !== (versions.get(ref) || 0)) return { state: 'notConnected' };
    if (live.has(ref)) return { state: 'connecting' };
    failures.delete(ref);
    const entry = {}; live.set(ref, entry);
    try {
      const consent = await dialog.showMessageBox({ type: 'question', title: 'Connect plugin account',
        message: `${id}: connect a website account?`,
        detail: `Sign in at ${config.loginUrl}\nAllow authenticated GET requests to ${config.requestUrl}\nThe host saves the captured authorization encrypted on this device.`,
        buttons: ['Cancel', 'Connect'], defaultId: 0, cancelId: 0 });
      if (live.get(ref) !== entry || disposed || !active(id)) return { state: 'notConnected' };
      if (consent.response !== 1) { stop(ref); return { state: 'notConnected' }; }
      const browserSession = session.fromPartition(`plugin-web-login-${randomUUID()}`);
      entry.browserSession = browserSession;
      await createSessionProxyApplier({ getSession: () => browserSession, getConfig: () => sessionProxyConfig(getSettings()) }).ensureReady();
      if (live.get(ref) !== entry || disposed || !active(id)) return { state: 'notConnected' };
      browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      const win = new BrowserWindow({ width: 980, height: 760, title: `${id} — Sign in`,
        webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true } });
      entry.window = win;
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('https://')) event.preventDefault(); });
      const candidates = new Map();
      browserSession.webRequest.onBeforeSendHeaders({ urls: [config.requestUrl] }, (details, callback) => {
        const headers = details.requestHeaders;
        const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
        if (details.url === config.requestUrl && details.method === 'GET' && details.webContentsId === win.webContents.id
          && typeof authorization === 'string' && /^Bearer [^\s\x00-\x1f\x7f]+$/.test(authorization)) {
          const scoped = {};
          for (const name of config.scopeHeaders) {
            const value = Object.entries(headers).find(([header]) => header.toLowerCase() === name.toLowerCase())?.[1];
            if (typeof value === 'string' && !/[\r\n]/.test(value)) scoped[name] = value;
          }
          if (config.scopeHeaders.every(name => Object.hasOwn(scoped, name))) candidates.set(details.id, { authorization, headers: scoped, expiresAt: authorizationExpiry(authorization) });
        }
        callback({ requestHeaders: headers });
      });
      browserSession.webRequest.onCompleted({ urls: [config.requestUrl] }, async details => {
        const candidate = candidates.get(details.id); candidates.delete(details.id);
        if (!candidate || details.statusCode < 200 || details.statusCode >= 300 || live.get(ref) !== entry || !active(id)) return;
        const current = () => live.get(ref) === entry && !disposed && active(id);
        try { if (await save(ref, { ...config, ...candidate }, current) && current()) { stop(ref); changed(id, args.key); } }
        catch (_) { if (current()) { failures.set(ref, 'web-session-storage-unavailable'); stop(ref); } }
      });
      win.once('closed', () => { if (live.get(ref) === entry) stop(ref); });
      entry.timer = setTimeout(() => stop(ref), timeoutMs); entry.timer.unref?.();
      void win.loadURL(config.loginUrl).catch(() => stop(ref));
      return { state: 'connecting' };
    } catch (_) {
      if (live.get(ref) !== entry) return { state: 'notConnected' };
      stop(ref); throw Error('web-session-connect-failed');
    }
  }
  async function request(id, key) {
    available(id); const ref = identity(id, key), version = versions.get(ref) || 0;
    const stored = await read(ref);
    available(id);
    if (version !== (versions.get(ref) || 0)) throw Error('web-session-request-cancelled');
    if (!stored || stored.expiresAt && stored.expiresAt <= Date.now()) return { status: 401, body: null };
    const controller = new AbortController();
    const owners = requests.get(ref) || new Set(); requests.set(ref, owners); owners.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      // No cookies or redirects: a captured bearer may go only to its confirmed URL.
      const response = await fetchImpl(stored.requestUrl, {
        method: 'GET', headers: { ...stored.headers, Authorization: stored.authorization, Accept: 'application/json' },
        credentials: 'omit', redirect: 'error', signal: controller.signal
      });
      if (controller.signal.aborted || !active(id) || disposed) throw Error('inactive');
      if (!response.ok) { if ([401, 403].includes(response.status)) failures.set(ref, 'reconnect-required'); return { status: response.status, body: null }; }
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 262144) { controller.abort(); throw Error('too-large'); }
        chunks.push(Buffer.from(chunk));
      }
      available(id);
      if (controller.signal.aborted) throw Error('cancelled');
      return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch (_) { throw Error('web-session-request-failed'); }
    finally { clearTimeout(timeout); owners.delete(controller); if (!owners.size) requests.delete(ref); }
  }
  function cancelPlugin(id) {
    for (const ref of versions.keys()) if (ref.startsWith(`${id}/`)) {
      versions.set(ref, versions.get(ref) + 1);
      stop(ref);
      for (const controller of requests.get(ref) || []) controller.abort();
    }
  }
  function disconnect(id, key) {
    available(id); const ref = identity(id, key); versions.set(ref, (versions.get(ref) || 0) + 1); failures.delete(ref); stop(ref);
    for (const controller of requests.get(ref) || []) controller.abort();
    try { fs.unlinkSync(file(ref)); } catch (error) { if (error.code !== 'ENOENT') throw Error('web-session-storage-unavailable'); }
    changed(id, key);
    return { state: 'notConnected' };
  }
  function forget(id) {
    identity(id, 'default'); cancelPlugin(id);
    for (const ref of failures.keys()) if (ref.startsWith(`${id}/`)) failures.delete(ref);
    let files;
    try { files = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw Error('web-session-storage-unavailable'); }
    for (const name of files) if (new RegExp(`^${id}--[a-f0-9]{64}\\.json$`).test(name)) fs.unlinkSync(path.join(directory, name));
  }
  return { status, connect, request, disconnect, cancelPlugin, forget,
    cancelInactive() { for (const ref of versions.keys()) if (!active(ref.split('/')[0])) cancelPlugin(ref.split('/')[0]); },
    dispose() { disposed = true; for (const ref of live.keys()) stop(ref); for (const owners of requests.values()) for (const controller of owners) controller.abort(); } };
}
module.exports = { createPluginWebSessions, connectionConfig };
