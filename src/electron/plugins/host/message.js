'use strict';

// One bounded JSON wire contract at both sides of IPC. Structured clone also
// carries binary, Maps, cycles and other values whose JSON size is misleading.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorPluginMessage = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, () => {
  const MAX_BYTES = 64 * 1024;
  const encoder = new TextEncoder();
  function validJson(value) {
    let bytes = 0;
    let nodes = 0;
    const ancestors = new Set();
    function count(text) {
      if (text.length > MAX_BYTES) return false;
      bytes += encoder.encode(JSON.stringify(text)).length;
      return bytes <= MAX_BYTES;
    }
    function visit(item, depth) {
      if (++nodes > 8192 || depth > 16 || bytes > MAX_BYTES) return false;
      if (item === null || typeof item === 'boolean') { bytes += 5; return bytes <= MAX_BYTES; }
      if (typeof item === 'number') { bytes += 24; return Number.isFinite(item) && bytes <= MAX_BYTES; }
      if (typeof item === 'string') return count(item);
      if (!item || typeof item !== 'object' || ancestors.has(item)) return false;
      const array = Array.isArray(item);
      if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
      const keys = Reflect.ownKeys(item);
      if (keys.length > 8192 || (array && item.length > 8192)) return false;
      ancestors.add(item);
      bytes += 2 + keys.length;
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string' || !count(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value, depth + 1)) return false;
      }
      ancestors.delete(item);
      return bytes <= MAX_BYTES;
    }
    try { return visit(value, 0); } catch { return false; }
  }
  function validMessage(message, { trusted = false } = {}) {
    if (!message || Array.isArray(message) || !validJson(message)) return false;
    const string = key => typeof message[key] === 'string';
    switch (message.type) {
      case 'ready': return true;
      case 'interaction-done': return Number.isSafeInteger(message.seq);
      case 'tick-done': return message.seq === undefined || Number.isSafeInteger(message.seq);
      case 'publish': return string('metric') && Object.hasOwn(message, 'value');
      case 'subscribe': return string('source');
      case 'call': return Number.isSafeInteger(message.id) && string('op') && message.args !== null && typeof message.args === 'object' && !Array.isArray(message.args);
      case 'log': return string('text');
      case 'error': return string('message');
      case 'heartbeat': return trusted;
      case 'dropped': return trusted && string('reason');
      default: return false;
    }
  }
  return { MAX_BYTES, validJson, validMessage };
});
