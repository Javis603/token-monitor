'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const { DEFAULT_STALE_AFTER_MS } = require('../shared/syncUploadInterval');
const { currentHubBuild } = require('../shared/hubBuildIdentity');
const { sendJson, sendText } = require('../shared/http');
const { loadDotEnv, parseArgs, projectRoot } = require('../shared/config');
const { createMdnsResponder, DEFAULT_SERVICE_TYPE } = require('../shared/mdns');
const { publicStats } = require('../shared/publicStats');
const { createHub } = require('../hub/server');

const DEFAULT_DATA_PORT = 17321;
const DEFAULT_VIEW_PORT = 17322;

// The view plane is deliberately recognizable: every route it serves lives
// under /api/view/, so "is this on the unauthenticated surface?" is a prefix
// check a reader can do in their head.
const VIEW_PREFIX = '/api/view/';

const VIEW_ROUTES = new Set(['/api/health', '/api/view/stats', '/api/view/stats/stream']);

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function createGateway({
  dataPort = DEFAULT_DATA_PORT,
  viewPort = DEFAULT_VIEW_PORT,
  host = '0.0.0.0',
  secret = '',
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  dataFile = path.join(projectRoot(), 'data', 'devices.json'),
  mdnsEnabled = true,
  mdnsServiceType = DEFAULT_SERVICE_TYPE,
  deviceId = '',
  viewEnabled = true,
  logger = console
} = {}) {
  // Trimmed because a secret of only whitespace is no secret: the CLI trims its
  // own input, and callers in-process must get the same refusal.
  const normalizedSecret = String(secret || '').trim();

  // A gateway exists to be reached from other machines, so unlike the plain hub
  // it must not silently fall back to loopback when no secret is configured:
  // that would look like a running gateway and be a hub nobody can reach.
  if (!normalizedSecret) {
    const error = new Error('secret_required');
    error.code = 'secret_required';
    throw error;
  }

  const hub = createHub({ port: dataPort, host, secret: normalizedSecret, staleAfterMs, dataFile, logger });
  // The read-only surface is optional: a host that only wants to relay usage to
  // other authenticated devices has no reason to expose plain HTTP to the LAN.
  // When it is off, mDNS still advertises the data plane but never claims a
  // view port, so a discovery client can distinguish "no view served" from a
  // typo — the field is simply absent.
  const view = viewEnabled
    ? http.createServer((req, res) => {
        handleViewRequest(req, res).catch((error) => {
          (logger.error || console.error)(error);
          sendJson(res, 500, { error: 'internal_error', message: error.message });
        });
      })
    : null;

  const viewClients = new Set();

  function sseFormat(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function viewStats() {
    return publicStats(hub.getStats(), { source: 'gateway' });
  }

  function broadcastViewStats(reason = 'update') {
    if (viewClients.size === 0) return;
    const payload = sseFormat('stats', {
      type: 'stats', reason, stats: viewStats(), at: new Date().toISOString()
    });
    for (const res of viewClients) {
      try { res.write(payload); } catch (_) { viewClients.delete(res); }
    }
  }

  function closeViewClients() {
    for (const res of viewClients) { try { res.end(); } catch (_) {} }
    viewClients.clear();
  }

  async function handleViewRequest(req, res) {
    if (req.method === 'OPTIONS') return sendText(res, 204, '');
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        role: 'gateway',
        runtime: 'node-gateway',
        hubBuild: currentHubBuild('node-hub'),
        deviceCount: hub.getDevices().length,
        dataPort,
        viewPort,
        readOnly: true,
        now: new Date().toISOString()
      });
    }

    // Write routes answer 404 rather than 405: a 405 is a statement that a
    // write route exists at this path, which is exactly what an unauthenticated
    // surface should not be advertising.
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 404, { error: 'not_found' });
    if (!VIEW_ROUTES.has(url.pathname)) return sendJson(res, 404, { error: 'not_found' });

    if (url.pathname === '/api/view/stats') return sendJson(res, 200, viewStats());

    if (url.pathname === '/api/view/stats/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(sseFormat('snapshot', {
        type: 'stats', reason: 'snapshot', stats: viewStats(), at: new Date().toISOString()
      }));
      viewClients.add(res);
      const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 30000);
      const cleanup = () => { clearInterval(heartbeat); viewClients.delete(res); };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return undefined;
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  const mdnsTxt = {
    ver: '1',
    id: deviceId || os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'gateway',
    path: '/api/ingest',
    auth: '1'
  };
  // Never the secret: this goes out over multicast to the whole subnet.
  // It reaches a phone only by manual entry or QR code. The view port is only
  // advertised when the read-only server actually runs — absence means "no
  // read-only view on this gateway", which the app can surface honestly.
  if (viewEnabled) mdnsTxt.view = String(viewPort);

  const mdns = mdnsEnabled
    ? createMdnsResponder({
        serviceType: mdnsServiceType,
        port: dataPort,
        txt: mdnsTxt,
        logger
      })
    : null;

  let started = false;
  let mdnsVerified = false;

  async function start() {
    if (started) return;
    await hub.start();
    if (view) {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        view.once('error', onError);
        view.listen(viewPort, host, () => {
          view.off('error', onError);
          resolve();
        });
      });
    }
    // Ingest pushes to the hub's own listeners; mirror them onto the view plane
    // so a phone watching the stream learns about an update as it lands.
    if (view) hub.onStats(() => broadcastViewStats('ingest'));
    started = true;
    mdnsVerified = await startDiscovery();
  }

  /**
   * Discovery is an optimization, never a precondition: port 5353 is shared
   * with every other mDNS responder on the host, so failures here are logged
   * and the gateway keeps serving.
   *
   * It is also verified rather than assumed. A bind to 5353 succeeds even when
   * Bonjour and others hold it, and the kernel then delivers to one socket
   * only — so `start()` resolving proves the port was taken, not that anyone
   * will hear us. Reporting success in that state would put "advertising" in
   * the log while no device ever finds the gateway.
   */
  async function startDiscovery() {
    if (!mdns) return false;
    try {
      await mdns.start();
    } catch (error) {
      (logger.warn || console.warn)(`[gateway] mDNS responder disabled: ${error.message}`);
      return false;
    }
    const verified = await mdns.verifyDelivery();
    if (!verified) {
      (logger.warn || console.warn)(
        `[gateway] mDNS responder is bound but not receiving on ${host === '0.0.0.0' ? 'any interface' : host}; another responder may own port 5353, or the network is blocking multicast. Connect by address instead.`
      );
    }
    return verified;
  }

  async function stop() {
    if (!started) return;
    started = false;
    if (view) closeViewClients();
    if (mdns) {
      try { await mdns.stop(); } catch (_) { /* best effort */ }
    }
    if (view) {
      await new Promise((resolve) => {
        view.closeAllConnections?.();
        view.close(() => resolve());
      });
    }
    await hub.stop();
  }

  return {
    start, stop, hub, view, mdns,
    dataPort, viewPort, host,
    get viewEnabled() { return viewEnabled; },
    get viewStats() { return viewStats(); },
    get mdnsListening() { return Boolean(mdns?.listening); },
    // `listening` alone is not evidence that discovery works; see startDiscovery.
    get mdnsVerified() { return mdnsVerified; },
    // The same list the mDNS responder advertises, so the log and the network
    // never disagree about which addresses are reachable.
    get lanAddresses() { return mdns ? mdns.service.addresses : []; }
  };
}

if (require.main === module) {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const dataPort = normalizePort(args.dataPort || process.env.TOKEN_MONITOR_PORT, DEFAULT_DATA_PORT);
  const viewPort = normalizePort(args.viewPort || process.env.TOKEN_MONITOR_VIEW_PORT, DEFAULT_VIEW_PORT);
  const host = String(args.host || process.env.TOKEN_MONITOR_HOST || '0.0.0.0');
  const secret = String(args.secret || process.env.TOKEN_MONITOR_SECRET || '').trim();
  const staleAfterMs = Number(args.staleAfterMs || process.env.TOKEN_MONITOR_STALE_AFTER_MS || DEFAULT_STALE_AFTER_MS);
  const dataFile = String(args.dataFile || process.env.TOKEN_MONITOR_DATA_FILE || path.join(projectRoot(), 'data', 'devices.json'));
  const mdnsEnabled = String(args.mdns ?? process.env.TOKEN_MONITOR_MDNS ?? '1') !== '0';
  const viewEnabled = String(args.view ?? process.env.TOKEN_MONITOR_VIEW ?? '1') !== '0';
  const deviceId = String(args.deviceId || process.env.TOKEN_MONITOR_DEVICE_ID || '').trim();

  let gateway;
  try {
    gateway = createGateway({
      dataPort, viewPort, host, secret, staleAfterMs, dataFile, mdnsEnabled, viewEnabled, deviceId
    });
  } catch (error) {
    if (error.code === 'secret_required') {
      console.error('Gateway refused to start: TOKEN_MONITOR_SECRET must be set.');
      console.error('The gateway binds every interface for LAN devices, so an unauthenticated ingest port would accept forged usage from anything on the network.');
      console.error('Generate one with `npm run gateway -- --secret <random>` or set TOKEN_MONITOR_SECRET.');
      process.exit(1);
    }
    throw error;
  }

  gateway.start().then(() => {
    console.log(`Token Monitor gateway data plane on http://${gateway.host}:${dataPort} (secret required)`);
    if (viewEnabled) console.log(`Token Monitor gateway view plane on http://${gateway.host}:${viewPort} (no auth, read-only)`);
    // The bind address is 0.0.0.0, which is not something anyone can type into
    // a phone. Print the addresses a peer can actually reach — and only the
    // ones the mDNS responder would advertise, so the two never disagree.
    for (const address of gateway.lanAddresses) {
      console.log(`  data  http://${address}:${dataPort}   <- PC clients, agents (needs the secret)`);
      if (viewEnabled) console.log(`  view  http://${address}:${viewPort}   <- Android app, any browser (no auth)`);
    }
    if (gateway.lanAddresses.length === 0) {
      console.log('  No LAN address found; the gateway will only be reachable from this machine.');
    }
    console.log(`Data file: ${dataFile}`);
    if (mdnsEnabled) {
      if (!gateway.mdnsListening) {
        console.log(`mDNS responder unavailable; connect by address instead`);
      } else if (gateway.mdnsVerified) {
        console.log(`mDNS responder advertising ${DEFAULT_SERVICE_TYPE}`);
      } else {
        console.warn(`mDNS responder is bound but not receiving; another responder may own port 5353. Connect by address instead.`);
      }
    }
    if (viewEnabled) console.warn('Warning: the view plane is unauthenticated plain HTTP. Every device on this network can read the usage it serves. Use it only on a network you trust.');
  }).catch((error) => {
    console.error(`Gateway failed to start: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { createGateway, DEFAULT_DATA_PORT, DEFAULT_VIEW_PORT, VIEW_PREFIX };
