'use strict';

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function createClaudeWebFetch(net) {
  return function claudeWebFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      let settled = false;
      let request = null;
      const abort = () => {
        request?.abort();
        finish(reject, abortError());
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', abort);
        callback(value);
      };
      if (signal?.aborted) {
        finish(reject, abortError());
        return;
      }
      request = net.request({
        method: String(options.method || 'GET').toUpperCase(),
        url: String(url)
      });
      for (const [name, value] of Object.entries(options.headers || {})) {
        if (value !== undefined && value !== null) request.setHeader(name, String(value));
      }
      signal?.addEventListener?.('abort', abort, { once: true });
      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('error', (error) => finish(reject, error));
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          const headerValue = (name) => {
            const value = response.headers[String(name || '').toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : String(value || '');
          };
          const setCookie = response.headers['set-cookie'];
          const setCookieValues = Array.isArray(setCookie)
            ? setCookie.map(String)
            : setCookie
              ? [String(setCookie)]
              : [];
          finish(resolve, {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            headers: {
              get: headerValue,
              getSetCookie: () => setCookieValues
            },
            json: async () => JSON.parse(body.toString('utf8')),
            arrayBuffer: async () => body.buffer.slice(
              body.byteOffset,
              body.byteOffset + body.byteLength
            )
          });
        });
      });
      request.on('error', (error) => finish(reject, error));
      request.end();
    });
  };
}

module.exports = { createClaudeWebFetch };
