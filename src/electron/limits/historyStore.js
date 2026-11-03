'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { limitWindowKey } = require('../../shared/limits/usageItems');
const { historyAccountKey } = require('./historyIdentity');
const { dayKey, historyReadings } = require('../renderer/limits/historyModel');

function historyWindow(window) {
  return historyReadings(window).primary;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function accountId(scope, provider) { return digest([scope, historyAccountKey(provider)]); }
function windowId(scope, provider, window, reading) {
  const identity = [scope, historyAccountKey(provider), limitWindowKey(window), reading.unit];
  if (['credits', 'spend'].includes(window.metric) && reading.unit === 'pp') identity.push(window.currency || 'credits');
  return digest(identity);
}

function createLimitsHistoryStore(filePath, { now = Date.now, onError = () => {}, onChange = () => {} } = {}) {
  let worker = null;
  let sequence = 0;
  let closed = false;
  const pending = new Map();
  function failed(error) {
    onError(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  function rpc(method, args) {
    if (closed) return Promise.reject(new Error('Quota history is closed'));
    if (!worker) {
      worker = new Worker(path.join(__dirname, 'historyWorker.js'), { workerData: { filePath } });
      worker.on('message', message => {
        if (!message.id) { onError(new Error(message.error)); return; }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (!pending.size) worker.unref();
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
      });
      worker.on('error', failed);
      worker.on('exit', code => { if (!closed || code !== 0) { closed = true; failed(new Error(`Quota history worker exited (${code})`)); } });
    }
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
  }
  async function record(scope, limits) {
    const actions = [];
    for (const provider of limits?.providers || []) {
      const account = accountId(scope, provider);
      const source = digest([provider.sourceDeviceId || '', provider.source || '', provider.sourceDetail || '']);
      if (provider.status !== 'ok' || provider.stale) { actions.push({ account, source, failed: true }); continue; }
      const at = Date.parse(provider.updatedAt);
      if (!Number.isFinite(at)) continue;
      const windows = [];
      for (const window of provider.windows || []) {
        const { primary, raw } = historyReadings(window);
        // A raw-only reading ends any previously observed percentage interval.
        if (['credits', 'spend'].includes(window.metric) && primary?.unit !== 'pp') {
          windows.push({ id: windowId(scope, provider, window, { unit: 'pp' }), point: { at, missing: true } });
        }
        for (const reading of [primary, raw].filter(Boolean)) {
          windows.push({ id: windowId(scope, provider, window, reading), point: { at, ...reading,
            reset: Number.isFinite(Date.parse(window.resetsAt)) ? Date.parse(window.resetsAt) : null,
            interval: Math.max(60_000, Number(limits.refreshMs) || 300_000) } });
        }
      }
      if (windows.length) actions.push({ account, source, windows });
    }
    if (!actions.length || closed) return;
    try { await rpc('record', [actions, now()]); }
    catch (error) { onError(error); }
    onChange();
  }
  async function query(scope, provider, range = { grain: 'day', day: dayKey(now()) }) {
    const windows = (provider.windows || []).filter(historyWindow).map(window => {
      const reading = historyWindow(window);
      const key = ['credits', 'spend'].includes(window.metric)
        ? JSON.stringify([limitWindowKey(window), window.currency || 'credits']) : limitWindowKey(window);
      return { id: windowId(scope, provider, window, reading), key, window, provider: provider.provider,
        unit: reading.unit, balance: reading.balance };
    });
    try { return await rpc('query', [windows, range, now()]); }
    catch (error) {
      onError(error);
      return { persistent: false, range, windows: windows.map(({ key, window, unit, balance }) => ({ key, window, unit, balance, points: [] })) };
    }
  }
  async function flush() { if (worker && !closed) await rpc('flush', []); }
  async function close() {
    if (!worker || closed) { closed = true; return; }
    const completion = rpc('close', []);
    closed = true;
    await completion;
  }
  function closeSync() {
    if (!worker || closed) return;
    const shutdown = new SharedArrayBuffer(4);
    worker.postMessage({ method: 'close', args: [], shutdown });
    if (Atomics.wait(new Int32Array(shutdown), 0, 0, 3000) === 'timed-out') onError(new Error('Quota history shutdown timed out'));
    closed = true;
  }
  return { record, query, flush, close, closeSync };
}
module.exports = { createLimitsHistoryStore, historyWindow };
