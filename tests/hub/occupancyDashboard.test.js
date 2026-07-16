'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dashboard = require('../../src/hub/public/occupancy');

test('dashboard normalizes the canonical occupancy snapshot', () => {
  const snapshot = dashboard.normalizeSnapshot({
    generatedAt: '2026-07-16T12:00:00.000Z',
    accounts: [{
      id: 'claude-main',
      provider: 'claude',
      alias: '主力账号',
      maskedIdentity: 'a***@example.com',
      capacity: 2,
      activeCount: 1,
      remaining: 1,
      light: 'yellow',
      reliability: 'fresh',
      tasks: [{ id: 'task-a', deviceId: 'dev-a', deviceName: '台式机', taskLabel: '重构 API' }]
    }]
  });

  assert.equal(snapshot.generatedAt, '2026-07-16T12:00:00.000Z');
  assert.deepEqual(snapshot.accounts[0], {
    id: 'claude-main',
    provider: 'claude',
    alias: '主力账号',
    maskedIdentity: 'a***@example.com',
    quotaLink: null,
    quota: null,
    enabled: true,
    capacity: 2,
    activeCount: 1,
    remaining: 1,
    light: 'yellow',
    reliability: 'fresh',
    tasks: [{
      id: 'task-a', deviceId: 'dev-a', deviceName: '台式机', taskLabel: '重构 API', projectLabel: '',
      source: 'manual', confidence: '', startedAt: '', lastHeartbeatAt: '', expiresAt: ''
    }],
    recentTasks: []
  });
});

test('dashboard accepts hub envelopes and lease-shaped account fields', () => {
  const snapshot = dashboard.normalizeSnapshot({
    type: 'occupancy',
    at: '2026-07-16T12:01:00.000Z',
    occupancy: {
      version: 1,
      updatedAt: '2026-07-16T12:00:59.000Z',
      accounts: [{
        id: 'codex-1', provider: 'openai', label: 'Codex 工作号', maxConcurrent: 3,
        activeCount: 3, availableSlots: 0,
        leases: [{ id: 'lease-1', taskId: 'task-1', deviceId: 'laptop', label: '修复登录', heartbeatAt: 'now' }]
      }]
    }
  });

  assert.equal(snapshot.generatedAt, '2026-07-16T12:00:59.000Z');
  assert.equal(snapshot.accounts[0].alias, 'Codex 工作号');
  assert.equal(snapshot.accounts[0].capacity, 3);
  assert.equal(snapshot.accounts[0].remaining, 0);
  assert.equal(snapshot.accounts[0].light, 'red');
  assert.equal(snapshot.accounts[0].tasks[0].taskLabel, '修复登录');
  assert.equal(snapshot.accounts[0].tasks[0].deviceName, 'laptop');
});

test('dashboard keeps disabled account state and validates session lease credentials', () => {
  const account = dashboard.normalizeAccount({
    id: 'disabled', provider: 'claude', alias: '暂停账号', enabled: false, capacity: 2, light: 'gray'
  }, 0);
  assert.equal(account.enabled, false);
  assert.equal(account.light, 'gray');

  const storage = {
    getItem() {
      return JSON.stringify({
        good: { fenceToken: 'secret-fence-token', accountId: 'disabled' },
        bad: { accountId: 'disabled' },
        empty: null
      });
    }
  };
  assert.deepEqual(dashboard.loadLeaseCredentials(storage), {
    good: { fenceToken: 'secret-fence-token', accountId: 'disabled' }
  });
  assert.equal(dashboard.apiErrorMessage({ code: 'capacity_exceeded' }), '旧版 Hub 阻止了这次登记；请升级到纯建议版本。');
});

test('dashboard reuses client-generated fence and idempotency tokens for lease retries', () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
  let sequence = 0;
  const cryptoApi = { randomUUID() { sequence += 1; return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`; } };
  const first = dashboard.pendingLeaseAttempt(storage, cryptoApi, 'claude-main', 'office-pc');
  const retry = dashboard.pendingLeaseAttempt(storage, cryptoApi, 'claude-main', 'office-pc');
  assert.deepEqual(retry, first);
  assert.match(first.attempt.fenceToken, /^fence-/);
  assert.match(first.attempt.idempotencyKey, /^web-/);
  assert.equal(sequence, 2, 'retry must not generate a second credential pair');
  dashboard.clearPendingLeaseAttempt(storage, first.key);
  assert.equal(storage.getItem('occupancyPendingLeases'), null);
});

test('dashboard derives summary counts and unknown lights defensively', () => {
  const snapshot = dashboard.normalizeSnapshot({ items: [
    { provider: 'claude', name: 'A', capacity: 2, current: 0 },
    { provider: 'codex', name: 'B', capacity: 1, activeCount: 1 },
    { provider: 'gemini', name: 'C', capacity: 4, activeCount: 2, reliability: 'unknown' }
  ] });

  assert.deepEqual(snapshot.accounts.map((account) => account.light), ['green', 'red', 'gray']);
  assert.deepEqual(dashboard.snapshotSummary(snapshot), { accounts: 3, active: 3, available: 2, full: 1 });
});

test('dashboard parses named SSE events and multiline JSON data', () => {
  assert.deepEqual(dashboard.parseSseBlock('event: occupancy\ndata: {"occupancy":\ndata: {"accounts":[]}}'), {
    event: 'occupancy', data: { occupancy: { accounts: [] } }
  });
  assert.equal(dashboard.parseSseBlock(': heartbeat'), null);
});

test('dashboard renders user-controlled content without innerHTML', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/hub/public/occupancy.js'), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.match(source, /textContent = taskLabel\(task\)/);
  assert.match(source, /replaceChildren/);
});

test('dashboard ships a responsive grid and the canonical SSE endpoint', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/hub/public/occupancy.css'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../../src/hub/public/occupancy.js'), 'utf8');
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /grid-template-columns: 1fr/);
  assert.match(source, /openStream\('\/api\/occupancy\/events'/);
  assert.match(source, /openStream\('\/api\/occupancy\/stream'/);
});

test('dashboard exposes account CRUD and manual lease controls with session-only credentials', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/hub/public/occupancy.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../../src/hub/public/occupancy.js'), 'utf8');
  for (const id of ['addAccountButton', 'accountForm', 'providerInput', 'aliasInput', 'maskedIdentityInput',
    'quotaCandidateInput', 'capacityInput', 'enabledInput', 'deleteAccountButton', 'leaseForm', 'deviceIdInput', 'deviceNameInput',
    'taskLabelInput', 'projectLabelInput']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should be present`);
  }
  assert.match(source, /'\/api\/occupancy\/accounts'/);
  assert.match(source, /method: editing \? 'PATCH' : 'POST'/);
  assert.match(source, /method: 'DELETE', body: \{ fenceToken: credential\.fenceToken \}/);
  assert.match(source, /x-occupancy-fence-token/);
  assert.match(source, /sessionStorage\.setItem\('occupancyLeaseCredentials'/);
  assert.match(source, /body\.fenceToken = attempt\.fenceToken/);
  assert.match(source, /body\.idempotencyKey = attempt\.idempotencyKey/);
  assert.match(source, /occupancyPendingLeases/);
  assert.match(source, /closest\('\.occupy-button'\) && account\.enabled\) openLeaseDialog\(account\)/);
  assert.doesNotMatch(source, /occupy-button[^\n]+remaining\s*>\s*0/);
  assert.doesNotMatch(source, /localStorage/);
  assert.match(source, /setInterval\(heartbeatOwnedLeases, 30_000\)/);
});

test('dashboard static handler serves the app with hardened browser headers', () => {
  const { occupancyAsset, serveOccupancyDashboard } = require('../../src/hub/occupancyDashboard');
  const html = occupancyAsset('/occupancy');
  assert.equal(html.type, 'text/html; charset=utf-8');
  assert.match(html.body.toString('utf8'), /id="accountGrid"/);
  assert.equal(occupancyAsset('/'), null);

  let status;
  let headers;
  let body;
  const handled = serveOccupancyDashboard({ method: 'GET' }, {
    writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders; },
    end(nextBody) { body = nextBody; }
  }, '/occupancy.js');
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.match(headers['content-security-policy'], /connect-src 'self'/);
  assert.match(body.toString('utf8'), /api\/occupancy\/events/);
  assert.equal(serveOccupancyDashboard({ method: 'POST' }, {}, '/occupancy'), false);
});
