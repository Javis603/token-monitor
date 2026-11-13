'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { limitWindowKey } = require('../../shared/limits/usageItems');
const { hashKey } = require('../../shared/hashKey');
const { historyAccountKey, portableHistoryAccount: hasHistoryAccountIdentity } = require('./historyIdentity');
const { dayKey, historyReadings } = require('../renderer/limits/historyModel');

function historyWindow(window) {
  return historyReadings(window).primary;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function portableHistoryAccount(provider) {
  // CLI can hash an organization label; that derived key is not an account.
  const organizationOnly = provider.provider === 'claude' && provider.source === 'cli'
    && !provider.accountEmail && provider.accountName
    && provider.accountKey === hashKey('claude-cli', provider.accountName);
  return hasHistoryAccountIdentity(provider) && !organizationOnly;
}
function historyScope(scope, provider) { return portableHistoryAccount(provider) ? 'account-v2' : scope; }
function accountId(scope, provider) { return digest([historyScope(scope, provider), historyAccountKey(provider)]); }
function windowId(scope, provider, window, reading, legacy = false) {
  if (!legacy) scope = historyScope(scope, provider);
  const identity = [scope, historyAccountKey(provider), limitWindowKey(window), reading.unit];
  if (['credits', 'spend'].includes(window.metric) && reading.unit === 'pp') identity.push(window.currency || 'credits');
  return digest(identity);
}

function createLimitsHistoryStore(filePath, { now = Date.now, onError = () => {}, onChange = () => {}, legacyScopes = () => [] } = {}) {
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
  // A provider row can name one account by several keys: the key it reports
  // now and the credential-derived keys that key replaced. Each alias is the
  // id the same window was recorded under before the identity moved, so the
  // alias resolves to the canonical stream instead of forking the history.
  function identityVariants(provider) {
    const aliases = [...new Set((Array.isArray(provider.accountKeyAliases) ? provider.accountKeyAliases : [])
      .map(key => String(key || '').trim())
      .filter(key => key && key !== provider.accountKey))];
    return [provider, ...aliases.map(accountKey => ({ ...provider, accountKey, accountKeyAliases: [] }))];
  }
  function adoptions(scope, providers) {
    const mappings = [];
    for (const provider of providers) {
      if (!portableHistoryAccount(provider)) continue;
      const scopes = [...new Set([scope, ...legacyScopes()])];
      for (const identity of identityVariants(provider)) {
        for (const window of provider.windows || []) {
          const { primary, raw } = historyReadings(window);
          const readings = [primary, raw].filter(Boolean);
          // Adopt the same percentage stream that record() will interrupt.
          if (primary && ['credits', 'spend'].includes(window.metric) && primary.unit !== 'pp') readings.push({ unit: 'pp' });
          for (const reading of readings) {
            mappings.push({ id: windowId(scope, provider, window, reading), account: accountId(scope, provider),
              legacy: [
                ...scopes.map(old => windowId(old, identity, window, reading, true)),
                // An alias at the current scope is the account's own pre-alias
                // stream: the one-way hash it was recorded under until the
                // identity moved to the key the provider now reports.
                ...(identity === provider ? [] : [windowId(scope, identity, window, reading)])
              ],
              sources: scopes.map(old => ({ id: windowId(old, identity, window, reading, true),
                scope: digest(old) })) });
          }
        }
      }
    }
    return mappings;
  }
  async function record(scope, limits) {
    const actions = [];
    for (const provider of limits?.providers || []) {
      const account = accountId(scope, provider);
      const legacySource = digest([provider.sourceDeviceId || '', provider.source || '', provider.sourceDetail || '']);
      const portable = portableHistoryAccount(provider);
      const source = portable ? digest([digest(scope), legacySource]) : legacySource;
      const legacy = portable ? { account: digest([scope, historyAccountKey(provider)]), source: legacySource } : null;
      if (provider.status !== 'ok' || provider.stale) { actions.push({ account, source, legacy, failed: true }); continue; }
      const at = Date.parse(provider.updatedAt);
      if (!Number.isFinite(at)) continue;
      const interval = Math.max(60_000, Number(limits.refreshMs) || 300_000);
      const windows = [];
      for (const window of provider.windows || []) {
        const { primary, raw } = historyReadings(window);
        // A raw-only reading ends any previously observed percentage interval.
        if (primary && ['credits', 'spend'].includes(window.metric) && primary.unit !== 'pp') {
          windows.push({ id: windowId(scope, provider, window, { unit: 'pp' }), point: { at, interval, missing: true } });
        }
        for (const reading of [primary, raw].filter(Boolean)) {
          windows.push({ id: windowId(scope, provider, window, reading), point: { at, ...reading,
            reset: Number.isFinite(Date.parse(window.resetsAt)) ? Date.parse(window.resetsAt) : null,
            interval } });
        }
      }
      // A successful provider result is a full snapshot, including empty windows.
      actions.push({ account, source, legacy, snapshotAt: at, windows });
    }
    if (!actions.length || closed) return;
    try { await rpc('record', [actions, now(), adoptions(scope, limits?.providers || [])]); }
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
    try { return await rpc('query', [windows, range, now(), adoptions(scope, [provider])]); }
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
