'use strict';

function corsHeaders(extraHeaders = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-token-monitor-secret',
    ...extraHeaders
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, corsHeaders({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
  }));
  res.end(body);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, corsHeaders({
    'content-type': contentType,
    'cache-control': 'no-store'
  }));
  res.end(body);
}

function readJsonBody(req, maxBytes = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) {
        tooLarge = true;
        body = '';
        const error = new Error('Request body too large');
        error.code = 'payload_too_large';
        reject(error);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (error) { reject(new Error(`Invalid JSON body: ${error.message}`)); }
    });
    req.on('error', reject);
  });
}

function requestSecret(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-token-monitor-secret'] || '').trim();
}

function isAuthorized(req, expectedSecret) {
  if (!expectedSecret) return true;
  return requestSecret(req) === expectedSecret;
}

module.exports = { isAuthorized, readJsonBody, sendJson, sendText };
