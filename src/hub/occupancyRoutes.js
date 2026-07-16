'use strict';

const { OccupancyError } = require('../shared/occupancy');
const { readJsonBody, sendJson } = require('../shared/http');

const API_ROOT = '/api/occupancy';

function sseFormat(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function requestFenceToken(req, body = {}) {
  return String(req.headers['x-occupancy-fence-token'] || body.fenceToken || '').trim();
}

function createOccupancyRoutes({ occupancy, getSnapshot = () => occupancy.snapshot(), logger = console } = {}) {
  if (!occupancy) throw new Error('occupancy_store_required');
  const sseClients = new Set();

  function payload(reason, snapshot, at) {
    return { type: 'occupancy', reason, occupancy: snapshot, at };
  }

  function broadcast(snapshot, reason, at) {
    if (sseClients.size === 0) return;
    const message = sseFormat('occupancy', payload(reason, snapshot, at));
    for (const res of sseClients) {
      try { res.write(message); } catch (_) { sseClients.delete(res); }
    }
  }

  const unsubscribe = occupancy.onChange((_snapshot, reason, at) => broadcast(getSnapshot(), reason, at));

  function sendError(res, error) {
    if (error instanceof OccupancyError) {
      return sendJson(res, error.statusCode, {
        error: error.code,
        ...(error.message && error.message !== error.code ? { message: error.message } : {})
      });
    }
    if (error?.code === 'payload_too_large') {
      res.shouldKeepAlive = false;
      return sendJson(res, 413, { error: 'payload_too_large', message: error.message }, { connection: 'close' });
    }
    if (/^Invalid JSON body:/.test(String(error?.message))) {
      return sendJson(res, 400, { error: 'bad_request', message: error.message });
    }
    (logger.error || console.error)(error);
    return sendJson(res, 500, { error: 'internal_error' });
  }

  async function handle(req, res, url) {
    if (url.pathname !== API_ROOT && !url.pathname.startsWith(`${API_ROOT}/`)) return false;
    try {
      if (req.method === 'GET' && (
        url.pathname === API_ROOT ||
        url.pathname === `${API_ROOT}/` ||
        url.pathname === `${API_ROOT}/snapshot` ||
        url.pathname === `${API_ROOT}/status`
      )) {
        sendJson(res, 200, getSnapshot());
        return true;
      }

      if (req.method === 'GET' && url.pathname === `${API_ROOT}/accounts`) {
        sendJson(res, 200, { accounts: getSnapshot().accounts });
        return true;
      }

      if (req.method === 'POST' && url.pathname === `${API_ROOT}/accounts`) {
        const created = occupancy.createAccount(await readJsonBody(req));
        const snapshot = getSnapshot();
        const account = snapshot.accounts.find((entry) => entry.id === created.id);
        sendJson(res, 201, { ok: true, account, occupancy: snapshot });
        return true;
      }

      const accountMatch = url.pathname.match(/^\/api\/occupancy\/accounts\/([^/]+)$/);
      if (accountMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
        const updated = occupancy.updateAccount(decodeURIComponent(accountMatch[1]), await readJsonBody(req));
        const snapshot = getSnapshot();
        const account = snapshot.accounts.find((entry) => entry.id === updated.id);
        sendJson(res, 200, { ok: true, account, occupancy: snapshot });
        return true;
      }
      if (accountMatch && req.method === 'DELETE') {
        const accountId = decodeURIComponent(accountMatch[1]);
        occupancy.deleteAccount(accountId);
        sendJson(res, 200, { ok: true, accountId, occupancy: getSnapshot() });
        return true;
      }

      if (req.method === 'POST' && url.pathname === `${API_ROOT}/leases`) {
        const lease = occupancy.acquireLease(await readJsonBody(req));
        sendJson(res, 201, { ok: true, lease, occupancy: getSnapshot() });
        return true;
      }

      const heartbeatMatch = url.pathname.match(/^\/api\/occupancy\/leases\/([^/]+)\/heartbeat$/);
      if (heartbeatMatch && req.method === 'POST') {
        const body = await readJsonBody(req);
        const lease = occupancy.heartbeatLease(decodeURIComponent(heartbeatMatch[1]), {
          ...body,
          fenceToken: requestFenceToken(req, body)
        });
        sendJson(res, 200, { ok: true, lease, occupancy: getSnapshot() });
        return true;
      }

      const leaseMatch = url.pathname.match(/^\/api\/occupancy\/leases\/([^/]+)$/);
      if (leaseMatch && req.method === 'DELETE') {
        const body = await readJsonBody(req);
        const lease = occupancy.releaseLease(decodeURIComponent(leaseMatch[1]), {
          ...body,
          fenceToken: requestFenceToken(req, body)
        });
        sendJson(res, 200, { ok: true, lease, occupancy: getSnapshot() });
        return true;
      }

      if (req.method === 'GET' && (
        url.pathname === `${API_ROOT}/events` || url.pathname === `${API_ROOT}/stream`
      )) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no'
        });
        const snapshot = getSnapshot();
        res.write(sseFormat('snapshot', payload('snapshot', snapshot, snapshot.generatedAt)));
        sseClients.add(res);
        const heartbeat = setInterval(() => {
          try { res.write(': hb\n\n'); } catch (_) {}
        }, 30_000);
        heartbeat.unref?.();
        const cleanup = () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        };
        req.on('close', cleanup);
        req.on('error', cleanup);
        return true;
      }

      sendJson(res, 404, { error: 'not_found' });
      return true;
    } catch (error) {
      sendError(res, error);
      return true;
    }
  }

  function close() {
    unsubscribe();
    for (const res of sseClients) {
      try { res.end(); } catch (_) {}
    }
    sseClients.clear();
  }

  return { close, handle };
}

module.exports = { API_ROOT, createOccupancyRoutes };
