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
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
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
