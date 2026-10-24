'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const listen = (channel, callback) => {
  if (typeof callback !== 'function') throw new TypeError('callback required');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
// Wait for the page's initial bridge work to settle before offering its first
// presentation. Every call still uses the same document capability checks.
// This is a one-shot opening barrier, not an animation or background service.
let pending = 0, loaded = false, presented = false, presentationTimer;
function offerPresentation() {
  clearTimeout(presentationTimer);
  if (!loaded || pending || presented) return;
  presentationTimer = setTimeout(() => {
    if (pending || presented) return;
    presented = true;
    void ipcRenderer.invoke('plugins:web:call', 'present').catch(() => {});
  }, 32);
}
function call(op, args) {
  pending++; clearTimeout(presentationTimer);
  return ipcRenderer.invoke('plugins:web:call', op, args).then(result => {
    if (result?.__tmCapability !== 1) return result;
    if (result.ok) return result.value;
    // Error custom fields are lost across contextBridge; keep a plain record.
    return Promise.reject({ message: result.error.message, code: result.error.code, fields: result.error.fields });
  }).finally(() => { pending--; offerPresentation(); });
}
window.addEventListener('DOMContentLoaded', () => { loaded = true; offerPresentation(); }, { once: true });
window.addEventListener('pagehide', () => { presented = true; clearTimeout(presentationTimer); }, { once: true });
// Internal resume barrier follows context/data delivery in IPC order. It does
// not expose lifecycle control to author code or require author cooperation.
const settingsListeners = new Set();
const businessSubscriptions = new Map();
let businessSequence = 0;
ipcRenderer.on('plugins:web:business', (_event, event) => {
  const entry = businessSubscriptions.get(event.id);
  if (!entry) return;
  const settle = entry.settle; entry.settle = null;
  try { entry.callback(event.value); } finally { settle?.(); }
});
// A lifecycle interruption keeps the intent for resume; any other failure is
// final and reported to the author once.
function subscribeBusiness(id, entry) {
  return call('data.subscribe', { id, query: entry.query }).then(() => true, error => {
    if (error?.code === 'capability-suspended' || businessSubscriptions.get(id) !== entry) return false;
    businessSubscriptions.delete(id);
    entry.callback({ type: 'error', error: error.message, code: error.code, fields: error.fields });
    return false;
  });
}
// Parking clears host demand. Resume re-registers explicit subscriptions only
// after the host has restored this document's authority, and reports the
// document refreshed once each replayed subscription has delivered its first
// event. The host keeps the retained DOM hidden until then.
ipcRenderer.on('plugins:web:resume', (_event, epoch) => {
  void ipcRenderer.invoke('plugins:web:call', 'resumed', epoch).then(restored => {
    if (!restored) return;
    const refreshes = [...businessSubscriptions].map(([id, entry]) => new Promise(resolve => {
      entry.settle = resolve;
      void subscribeBusiness(id, entry).then(ok => { if (!ok) { entry.settle = null; resolve(); } });
    }));
    if (settingsListeners.size) void call('settings.get', {}).then(deliverSettings).catch(() => {});
    return Promise.all(refreshes).then(() => ipcRenderer.invoke('plugins:web:call', 'refreshed', epoch));
  }).catch(() => {});
});
function deliverSettings(value) {
  for (const listener of settingsListeners) { try { listener(value); } catch { /* Isolate author observers. */ } }
}
ipcRenderer.on('plugins:web:settings', (_event, value) => deliverSettings(value));
// Fixed capability methods, never expose ipcRenderer or an IPC channel argument.
contextBridge.exposeInMainWorld('tm', Object.freeze({
  version: 1,
  context: () => call('context'),
  onContext: callback => listen('plugins:web:context', callback),
  subscribe: sources => call('subscribe', sources),
  onData: callback => listen('plugins:web:data', callback),
  restoreOriginal: () => call('restore'),
  settings: Object.freeze({
    get: () => call('settings.get', {}),
    update: input => call('settings.update', input),
    reset: input => call('settings.reset', input),
    onChange(callback) {
      if (typeof callback !== 'function') throw new TypeError('callback required');
      settingsListeners.add(callback); return () => settingsListeners.delete(callback);
    }
  }),
  data: Object.freeze({
    query: query => call('data.query', { query }),
    subscribe(query, callback) {
      if (typeof callback !== 'function') throw new TypeError('callback required');
      if (businessSubscriptions.size >= 16) throw new Error('subscription limit');
      const id = `q${++businessSequence}`;
      const entry = { query, callback, settle: null };
      businessSubscriptions.set(id, entry);
      void subscribeBusiness(id, entry);
      return () => {
        if (businessSubscriptions.get(id) !== entry) return;
        businessSubscriptions.delete(id); entry.settle?.(); entry.settle = null;
        void call('data.unsubscribe', { id }).catch(() => {});
      };
    }
  }),
  storage: Object.freeze({
    get: key => call('get', { key }),
    set: (key, value) => call('set', { key, value }),
    delete: key => call('delete', { key })
  })
}));
