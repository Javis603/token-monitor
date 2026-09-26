'use strict';

const http = require('node:http');
const https = require('node:https');

const { abortReason } = require('../../abortSignal');
const { mimoRequestHeaders } = require('./browserHeaders');

// The one request shape the exchange needs: a single hop that hands back its
// status, its Location and its own Set-Cookie lines, without following anything.
//
// It exists because neither Chromium transport can do that. `net.fetch` treats
// `redirect: 'manual'` as "cancel the request" and throws, and `net.request`'s
// `redirect` event reports the Location but strips `set-cookie` — and the cookies
// are the entire point of the walk. undici does both, which is why the headless
// agent needs none of this; the widget does.
//
// Carrying its own transport means it inherits neither the injected `deps.fetch`
// nor the OS proxy, the trade-off AGENTS.md already records for a probe that
// brings its own (`node:https`, `claudeWebFetch`, a spawned CLI). A machine
// behind a proxy that has no `HTTP(S)_PROXY` set therefore degrades to no
// discovered session, which is the state every machine without MiMo Desktop is
// already in.
function createMimoHttpRequest() {
  return function mimoHttpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const signal = options.signal;
      const transport = target.protocol === 'http:' ? http : https;
      let settled = false;
      let request = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        callback(value);
      };
      const onAbort = () => {
        request?.destroy(abortReason(signal));
        finish(reject, abortReason(signal));
      };
      if (signal?.aborted) {
        finish(reject, abortReason(signal));
        return;
      }

      // Every hop goes out as a MiMo client, for the reason `mimoRequestHeaders`
      // records: a request that does not look like one costs the user their
      // signed-in session, and Node's own request sends nothing at all.
      request = transport.request(target, {
        method: String(options.method || 'GET').toUpperCase(),
        headers: { ...mimoRequestHeaders(options.headers?.Cookie || ''), ...(options.headers || {}) }
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('error', (error) => finish(reject, error));
        response.on('end', () => {
          const setCookie = response.headers['set-cookie'];
          finish(resolve, {
            status: Number(response.statusCode),
            headers: {
              get: (name) => String(response.headers[String(name || '').toLowerCase()] || '') || null,
              getSetCookie: () => (Array.isArray(setCookie) ? setCookie.map(String) : setCookie ? [String(setCookie)] : [])
            },
            text: async () => Buffer.concat(chunks).toString('utf8')
          });
        });
      });
      request.on('error', (error) => finish(reject, error));
      signal?.addEventListener?.('abort', onAbort, { once: true });
      request.end();
    });
  };
}

module.exports = { createMimoHttpRequest };
