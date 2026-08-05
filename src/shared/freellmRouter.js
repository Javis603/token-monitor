'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');

const DEFAULT_PORT = 19512;
const DEFAULT_THRESHOLD_PERCENT = 97;
const UPSTREAM_BASE_URL = 'https://ollama.com/v1';
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function clampThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_THRESHOLD_PERCENT;
  return Math.max(50, Math.min(99, Math.round(number * 10) / 10));
}

function normalizePort(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) return DEFAULT_PORT;
  return number;
}

function normalizeKeys(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((entry) => {
    const id = String(entry?.id || '').trim();
    const apiKey = String(entry?.apiKey || '').trim();
    const ollamaAccountId = String(entry?.ollamaAccountId || '').trim();
    if (!id || !apiKey || !ollamaAccountId || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      apiKey,
      label: String(entry?.label || '').trim(),
      ollamaAccountId,
      accountKey: String(entry?.accountKey || '').trim(),
      enabled: entry?.enabled !== false
    }];
  });
}

function worstQuotaWindow(provider) {
  const windows = Array.isArray(provider?.windows) ? provider.windows : [];
  return windows.reduce((worst, window) => {
    const usedPercent = Number(window?.usedPercent);
    if (!Number.isFinite(usedPercent)) return worst;
    if (!worst || usedPercent > worst.usedPercent) {
      return { usedPercent, resetsAt: window?.resetsAt || null };
    }
    return worst;
  }, null);
}

function selectKey(keys, quotas, thresholdPercent, blocked = new Map(), nowMs = Date.now()) {
  const byAccountId = new Map((quotas || []).map((quota) => [String(quota?.accountId || ''), quota]));
  for (const key of normalizeKeys(keys)) {
    if (!key.enabled) continue;
    const block = blocked.get(key.id);
    if (block?.until > nowMs) continue;
    if (block) blocked.delete(key.id);
    const quota = byAccountId.get(key.ollamaAccountId);
    // Routing is deliberately coupled to Token Monitor's authenticated quota data.
    // A missing or stale source should never make a key look unlimited.
    if (!quota || quota.status !== 'ok') continue;
    const worst = worstQuotaWindow(quota);
    if (!worst || worst.usedPercent >= thresholdPercent) continue;
    return { key, quota, window: worst };
  }
  return null;
}

function blockSelection(blocked, selection, nowMs = Date.now()) {
  const fallbackUntil = nowMs + 60 * 60 * 1000;
  const reset = Date.parse(selection.window?.resetsAt || '');
  const until = Number.isFinite(reset) && reset > nowMs ? reset : fallbackUntil;
  blocked.set(selection.key.id, { until });
}

async function proxyChatCompletion({ keys, quotas, config = {}, blocked = new Map(), fetchFn, body }) {
  const normalizedKeys = normalizeKeys(keys);
  const upstreamBaseUrl = String(config.upstreamBaseUrl || UPSTREAM_BASE_URL).replace(/\/$/, '');
  for (let attempt = 0; attempt < normalizedKeys.length; attempt += 1) {
    const selection = selectKey(normalizedKeys, quotas, clampThreshold(config.thresholdPercent), blocked);
    if (!selection) return { error: 'No Ollama routing key has usable monitored quota.', statusCode: 503 };
    try {
      const response = await fetchFn(`${upstreamBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${selection.key.apiKey}`, 'content-type': 'application/json' },
        body
      });
      if (response.status === 429) {
        blockSelection(blocked, selection);
        continue;
      }
      return { selection, response };
    } catch (error) {
      return { error: `Ollama upstream request failed: ${error.message}`, statusCode: 502 };
    }
  }
  return { error: 'All Ollama routing keys are rate limited.', statusCode: 503 };
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function proxyHeaders(upstream) {
  const headers = { 'x-freellm-account': upstream.label || upstream.id };
  const contentType = upstream.response.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  return headers;
}

function createFreeLlmRouter(options = {}) {
  const fetchFn = options.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('A fetch implementation is required');
  const getKeys = options.getKeys || (() => []);
  const getQuotas = options.getQuotas || (() => []);
  const getConfig = options.getConfig || (() => ({}));
  const blocked = new Map();
  let server = null;
  let status = { running: false, port: null, error: '', activeKeyId: '' };

  async function forward(request, response) {
    let body;
    try {
      body = await requestBody(request);
      JSON.parse(body.toString('utf8'));
    } catch (error) {
      return json(response, error?.statusCode || 400, { error: { message: error?.message || 'Invalid JSON body', type: 'invalid_request_error' } });
    }
    const result = await proxyChatCompletion({
      keys: getKeys(), quotas: getQuotas(), config: getConfig() || {}, blocked, fetchFn, body
    });
    if (result.error) {
      return json(response, result.statusCode, { error: { message: result.error, type: result.statusCode === 503 ? 'freellm_exhausted' : 'upstream_error' } });
    }
    status.activeKeyId = result.selection.key.id;
    response.writeHead(result.response.status, proxyHeaders({ ...result.selection.key, response: result.response }));
    if (!result.response.body) return response.end();
    Readable.fromWeb(result.response.body).pipe(response);
    return undefined;
  }

  async function handler(request, response) {
    if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok', service: 'freellm-router' });
    if (request.method === 'GET' && request.url === '/v1/models') {
      return json(response, 200, { object: 'list', data: [] });
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') return forward(request, response);
    return json(response, 404, { error: { message: 'Not found', type: 'not_found' } });
  }

  return {
    getStatus: () => ({ ...status, blockedKeyIds: [...blocked.keys()] }),
    async start() {
      if (server) return this.getStatus();
      const port = normalizePort(getConfig()?.port);
      server = http.createServer((request, response) => { void handler(request, response); });
      await new Promise((resolve, reject) => {
        const onError = (error) => { server?.off('listening', onListening); reject(error); };
        const onListening = () => { server?.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      }).catch((error) => {
        server = null;
        status = { running: false, port: null, error: error.message, activeKeyId: '' };
        throw error;
      });
      status = { running: true, port, error: '', activeKeyId: '' };
      return this.getStatus();
    },
    async stop() {
      if (!server) return this.getStatus();
      const active = server;
      server = null;
      await new Promise((resolve) => active.close(resolve));
      status = { running: false, port: null, error: '', activeKeyId: '' };
      return this.getStatus();
    }
  };
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_THRESHOLD_PERCENT,
  UPSTREAM_BASE_URL,
  clampThreshold,
  normalizeKeys,
  normalizePort,
  selectKey,
  blockSelection,
  proxyChatCompletion,
  worstQuotaWindow,
  createFreeLlmRouter
};
