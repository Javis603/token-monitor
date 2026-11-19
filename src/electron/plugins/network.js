'use strict';
/* eslint preserve-caught-error: off -- Transport exceptions can contain credentials. */
// A convenience transport for trusted Node backends, not a network sandbox.
function createPluginNetwork({ fetchImpl, active }) {
  const requests = new Map();
  let disposed = false;
  async function request(id, args) {
    const { moduleId, requestId, url, headers = {}, method = 'GET', body, timeoutMs = 15000 } = args || {};
    let target;
    try { target = new URL(url); } catch { throw Error('network-invalid-url'); }
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw Error('network-invalid-url');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(requestId)
      || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)
      || !headers || typeof headers !== 'object' || Array.isArray(headers)
      || Object.entries(headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || key.toLowerCase() === 'host' || typeof value !== 'string' || /[\r\n]/.test(value))
      || Buffer.byteLength(JSON.stringify(headers)) > 32768
      || body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body) > 262144 || ['GET', 'HEAD'].includes(method))
      || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('network-invalid-request');
    if (disposed || !active(id)) throw Error('network-inactive');
    const ref = `${id}/${moduleId}/${requestId}`;
    if (requests.has(ref)) throw Error('network-request-conflict');
    const controller = new AbortController();
    requests.set(ref, { id, moduleId, controller });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target.href, { method, headers, body, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
      const chunks = []; let size = 0;
      for await (const chunk of response.body || []) {
        size += chunk.length;
        if (size > 1048576) { controller.abort(); throw Error('size'); }
        chunks.push(Buffer.from(chunk));
      }
      if (controller.signal.aborted || disposed || !active(id)) throw Error('cancelled');
      return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.concat(chunks).toString('utf8') };
    } catch { throw Error(controller.signal.aborted ? 'network-request-cancelled' : 'network-request-failed'); }
    finally { clearTimeout(timer); if (requests.get(ref)?.controller === controller) requests.delete(ref); }
  }
  function cancelPlugin(id, moduleId) {
    for (const [ref, entry] of requests) if (entry.id === id && (moduleId === undefined || entry.moduleId === moduleId)) { requests.delete(ref); entry.controller.abort(); }
  }
  return { request, cancelPlugin,
    cancel(id, moduleId, requestId) { const entry = requests.get(`${id}/${moduleId}/${requestId}`); if (entry) { requests.delete(`${id}/${moduleId}/${requestId}`); entry.controller.abort(); } },
    cancelInactive() { for (const entry of requests.values()) if (!active(entry.id)) cancelPlugin(entry.id); },
    dispose() { disposed = true; for (const entry of requests.values()) entry.controller.abort(); }
  };
}
module.exports = { createPluginNetwork };
