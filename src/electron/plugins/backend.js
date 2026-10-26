'use strict';
const path = require('node:path');

// One process per demanded plugin, shared by all its renderer occurrences.
function createPluginBackends({ fork, hostCall, onData = () => {}, onError = () => {}, log = () => {}, startupTimeoutMs = 15000, callTimeoutMs = 60000 }) {
  const records = new Map();
  let sequence = 0;
  function fail(record, error) {
    clearTimeout(record.startTimer);
    record.rejectReady(error);
    for (const pending of record.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    record.pending.clear();
  }
  function start(id, entry, dataDirectory) {
    if (records.has(id)) return records.get(id).ready;
    const child = fork(path.join(__dirname, 'backendHost.cjs'), [entry, dataDirectory], { serviceName: `Token Monitor plugin: ${id}`, stdio: 'pipe' });
    const record = { child, pending: new Map(), stopped: false };
    record.ready = new Promise((resolve, reject) => { record.resolveReady = resolve; record.rejectReady = reject; });
    // Activation errors are also reported through onError when nobody awaits start.
    record.ready.catch(() => {});
    records.set(id, record);
    record.startTimer = setTimeout(() => {
      fail(record, new Error('Plugin backend activation timed out'));
      child.kill();
    }, startupTimeoutMs);
    child.stdout?.on('data', bytes => log(id, String(bytes)));
    child.stderr?.on('data', bytes => log(id, String(bytes)));
    child.on('message', async message => {
      if (records.get(id) !== record || record.stopped || !message) return;
      if (message.type === 'ready') { clearTimeout(record.startTimer); record.resolveReady(); }
      else if (message.type === 'data') onData(id, message.value);
      else if (message.type === 'log') log(id, message.value);
      else if (message.type === 'error') onError(id, String(message.error));
      else if (message.type === 'reply') {
        const request = record.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); record.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
      } else if (message.type === 'host-call') {
        let value, error;
        try { value = await hostCall(id, message.method, message.args); } catch (cause) { error = String(cause?.message || cause); }
        if (records.get(id) === record && !record.stopped) child.postMessage({ type: 'host-reply', id: message.id, value, error });
      }
    });
    child.once('exit', code => {
      clearTimeout(record.stopTimer);
      if (records.get(id) === record) records.delete(id);
      fail(record, new Error(`Plugin backend exited (${code})`));
      if (!record.stopped) onError(id, `Plugin backend exited (${code})`);
    });
    return record.ready;
  }
  function stop(id) {
    const record = records.get(id);
    if (!record) return;
    records.delete(id); record.stopped = true;
    fail(record, new Error('Plugin backend stopped'));
    record.child.postMessage({ type: 'stop' });
    record.stopTimer = setTimeout(() => record.child.kill(), 500);
    record.stopTimer.unref?.();
  }
  async function call(id, method, args) {
    const record = records.get(id);
    if (!record) throw new Error('Plugin backend is not running');
    await record.ready;
    if (records.get(id) !== record) throw new Error('Plugin backend stopped');
    return new Promise((resolve, reject) => {
      const request = ++sequence;
      const timer = setTimeout(() => { record.pending.delete(request); reject(new Error('Plugin backend request timed out')); }, callTimeoutMs);
      record.pending.set(request, { resolve, reject, timer });
      record.child.postMessage({ type: 'call', id: request, method, args });
    });
  }
  return { start, stop, call, has: id => records.has(id), size: () => records.size,
    update(id, value) { const record = records.get(id); if (record) record.ready.then(() => {
      if (records.get(id) === record) record.child.postMessage({ type: 'context', value });
    }).catch(() => {}); },
    dispose() { for (const id of [...records.keys()]) stop(id); } };
}
module.exports = { createPluginBackends };
