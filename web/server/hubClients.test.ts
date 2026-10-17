import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGateway } from './app.js';
import { closeGateway } from './shutdown.js';
import { loadConfig, type GatewayConfig } from './config.js';

const require = createRequire(import.meta.url);
const { createHub } = require('../../src/hub/server.js');
let root: string;
let gateway: Server;
let hub: ReturnType<typeof createHub>;
let base: string;
let config: GatewayConfig;
const authorization = 'Bearer client-test-secret';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm-client-proxy-'));
  await writeFile(join(root, 'index.html'), '<title>test</title>');
  hub = createHub({port: 0, host: '127.0.0.1', secret: 'client-test-secret', dataFile: join(root, 'devices.json'), logger: {log() {}}});
  await hub.start();
  config = {
    hubUrl: `http://127.0.0.1:${hub.server.address().port}`,
    host: '127.0.0.1', port: 0, secret: 'client-test-secret', sessionSecret: '',
    trustOidcProxy: true, authMode: 'trusted-proxy', proxyMode: 'external',
    trustedProxyPeers: ['127.0.0.1'], allowHubClients: true
  };
  gateway = createGateway({config, distDir: root, logger: {error() {}}});
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('no listener');
  base = `http://127.0.0.1:${address.port}`;
  config.publicOrigin = base;
});
afterEach(async () => {
  await closeGateway(gateway);
  await hub.stop();
  await rm(root, {recursive: true, force: true});
});

it('defaults client proxy off and enables it explicitly', () => {
  expect(loadConfig({TOKEN_MONITOR_SECRET: 'test'}).allowHubClients).toBe(false);
  expect(loadConfig({TOKEN_MONITOR_SECRET: 'test', WEB_ALLOW_HUB_CLIENTS: 'true'}).allowHubClients).toBe(true);
});

it('uploads actual Desktop records and reads them back through the same origin', async () => {
  // Different configured server credential proves the supplied token reaches Hub.
  config.secret = 'wrong-server-credential';
  const response = await fetch(base + '/api/ingest', {method: 'POST', headers: {authorization, 'content-type': 'application/json'}, body: JSON.stringify({deviceId: 'pumpkin-test', hostname: 'Pumpkin', limits: {providers: [{provider: 'workbuddy', status: 'ok', source: 'local', balance: {amount: 5400, currency: 'CREDITS'}}]}})});
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  const devices = await fetch(base + '/api/devices', {headers: {authorization}}).then(r => r.json());
  expect(devices.devices[0].deviceId).toBe('pumpkin-test');
  expect(devices.devices[0].limits.providers[0].balance.amount).toBe(5400);
  expect((await fetch(base + '/api/devices/pumpkin-test', {method: 'DELETE', headers: {authorization}})).status).toBe(200);
  expect(hub.getDevices()).toHaveLength(0);
});

it('never falls back from an invalid Bearer to a valid browser cookie', async () => {
  const shell = await fetch(base);
  const cookie = shell.headers.get('set-cookie')!.split(';')[0];
  expect((await fetch(base + '/api/stats', {headers: {cookie}})).status).toBe(200);
  for (const token of ['Bearer wrong', 'Bearer', 'Bearer bad token']) {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(base + (method === 'GET' ? '/api/stats' : '/api/ingest'), {method, headers: {authorization: token, cookie}, ...(method === 'POST' ? {body: '{"deviceId":"forbidden"}'} : {})});
      expect(response.status).toBe(401);
    }
  }
  expect(hub.getDevices()).toHaveLength(0);
  expect((await fetch(base + '/api/ingest', {method: 'POST', headers: {cookie}, body: '{"deviceId":"forbidden"}'})).status).toBe(404);
});

it('keeps the client write channel disabled unless explicitly configured', async () => {
  config.allowHubClients = false;
  expect((await fetch(base + '/api/ingest', {method: 'POST', headers: {authorization}, body: '{"deviceId":"disabled"}'})).status).toBe(404);
  expect(hub.getDevices()).toHaveLength(0);
});

it('works with OIDC without creating or requiring a browser session', async () => {
  await closeGateway(gateway);
  config.authMode = 'oidc';
  config.oidcIssuer = 'https://issuer.invalid';
  config.oidcClientId = 'test';
  gateway = createGateway({config, distDir: root});
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('no listener');
  base = `http://127.0.0.1:${address.port}`;
  config.publicOrigin = base;
  expect((await fetch(base + '/api/stats', {headers: {authorization}})).status).toBe(200);
  expect((await fetch(base + '/api/stats')).status).toBe(401);
  expect((await fetch(base, {redirect: 'manual'})).headers.get('location')).toBe('/auth/login');
});

it('preserves Hub subscription conflicts, payload limits and method restrictions', async () => {
  const response = await fetch(base + '/api/subscriptions', {method: 'PUT', headers: {authorization, 'content-type': 'application/json'}, body: JSON.stringify({subscriptions: [], baseUpdatedAt: ''})});
  expect(response.status).toBe(200);
  const conflict = await fetch(base + '/api/subscriptions', {method: 'PUT', headers: {authorization}, body: JSON.stringify({subscriptions: [], baseUpdatedAt: 'old'})});
  expect(conflict.status).toBe(409);
  const oversized = await fetch(base + '/api/ingest', {method: 'POST', headers: {authorization}, body: 'x'.repeat(1024 * 1024 + 1)});
  expect(oversized.status).toBe(413);
  expect((await fetch(base + '/api/stats', {method: 'POST', headers: {authorization}})).status).toBe(405);
  expect((await fetch(base + '/api/unknown', {headers: {authorization}})).status).toBe(404);
  expect((await fetch(base + '/api/stats', {headers: {authorization, origin: 'https://untrusted.example'}})).status).toBe(403);
});

it('streams SSE with client authentication and closes on client cancellation', async () => {
  const controller = new AbortController();
  const response = await fetch(base + '/api/stats/stream', {headers: {authorization}, signal: controller.signal});
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: snapshot');
  controller.abort();
});
