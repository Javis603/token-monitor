'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { OccupancyError, createOccupancyStore } = require('../../src/shared/occupancy');

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-occupancy-'));
  let clock = Date.parse('2026-07-16T08:00:00.000Z');
  const store = createOccupancyStore({
    dataFile: path.join(dir, 'occupancy.json'),
    now: () => clock,
    cleanupIntervalMs: 0,
    ...options
  });
  return {
    dir,
    store,
    advance(ms) { clock += ms; },
    close() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createAccount(store, overrides = {}) {
  return store.createAccount({
    id: 'claude-work',
    provider: 'Claude',
    alias: 'Work',
    capacity: 2,
    maskedIdentity: 'w***@example.com',
    ...overrides
  });
}

test('account CRUD persists canonical aliases and reports traffic lights', () => {
  const context = fixture();
  try {
    const created = createAccount(context.store);
    assert.equal(created.provider, 'claude');
    assert.equal(created.alias, 'Work');
    assert.equal(created.capacity, 2);
    assert.equal(created.maxConcurrency, 2);
    assert.equal(created.advisoryThreshold, 2);
    assert.equal(created.advisoryOnly, true);

    let account = context.store.snapshot().accounts[0];
    assert.equal(account.light, 'green');
    assert.equal(account.activeCount, 0);
    assert.equal(account.remaining, 2);
    assert.deepEqual(account.tasks, []);
    assert.equal(account.reliability, 'estimated');

    const updated = context.store.updateAccount(created.id, { alias: 'Team', maxConcurrency: 3 });
    assert.equal(updated.alias, 'Team');
    assert.equal(updated.capacity, 3);
    assert.equal(context.store.listAccounts()[0].maskedIdentity, 'w***@example.com');

    context.store.deleteAccount(created.id);
    assert.equal(context.store.snapshot().accounts.length, 0);
  } finally {
    context.close();
  }
});

test('leases require a fence token for heartbeat and release', () => {
  const context = fixture();
  try {
    createAccount(context.store);
    const lease = context.store.acquireLease({
      accountId: 'claude-work',
      deviceId: 'laptop',
      deviceName: 'Laptop',
      taskId: 'task-1',
      taskLabel: 'Refactor',
      projectLabel: 'Monitor',
      source: 'wrapper',
      idempotencyKey: 'launch-1',
      ttlMs: 10_000
    });
    assert.ok(lease.fenceToken.length >= 16);
    assert.equal(lease.reliability, 'estimated');
    assert.equal(context.store.snapshot().accounts[0].light, 'yellow');

    assert.throws(
      () => context.store.heartbeatLease(lease.id, { fenceToken: 'not-the-right-token' }),
      (error) => error instanceof OccupancyError && error.code === 'fence_token_invalid'
    );

    context.advance(2_000);
    const heartbeat = context.store.heartbeatLease(lease.id, { fenceToken: lease.fenceToken, ttlMs: 20_000 });
    assert.equal(heartbeat.expiresAt, '2026-07-16T08:00:22.000Z');
    context.store.releaseLease(lease.id, { fenceToken: lease.fenceToken });
    assert.equal(context.store.snapshot().leases.length, 0);
  } finally {
    context.close();
  }
});

test('stored leases hash fence tokens and advisory thresholds never block work', () => {
  const context = fixture();
  try {
    createAccount(context.store, { capacity: 1 });
    const request = {
      accountId: 'claude-work',
      deviceId: 'desktop',
      idempotencyKey: 'same-launch',
      fenceToken: 'client-generated-fence-token',
      ttlMs: 10_000
    };
    const first = context.store.acquireLease(request);
    const second = context.store.acquireLease(request);
    assert.equal(second.id, first.id);
    assert.equal(second.idempotent, true);
    assert.equal(context.store.snapshot().accounts[0].activeCount, 1);

    const persisted = fs.readFileSync(path.join(context.dir, 'occupancy.json'), 'utf8');
    assert.doesNotMatch(persisted, /client-generated-fence-token/);
    assert.match(persisted, /fenceTokenHash/);

    const aboveThreshold = context.store.acquireLease({ accountId: 'claude-work', deviceId: 'other' });
    assert.equal(aboveThreshold.deviceId, 'other');
    const snapshot = context.store.snapshot();
    assert.equal(snapshot.accounts[0].activeCount, 2);
    assert.equal(snapshot.accounts[0].light, 'red');
    assert.equal(snapshot.accounts[0].advisoryThresholdReached, true);
  } finally {
    context.close();
  }
});

test('expired leases are pruned, persisted, and free capacity', () => {
  const context = fixture();
  try {
    createAccount(context.store, { capacity: 1 });
    context.store.acquireLease({ accountId: 'claude-work', deviceId: 'old', ttlMs: 5_000 });
    context.advance(5_001);
    const snapshot = context.store.snapshot();
    assert.equal(snapshot.leases.length, 0);
    assert.equal(snapshot.accounts[0].light, 'green');

    const replacement = context.store.acquireLease({ accountId: 'claude-work', deviceId: 'new' });
    assert.equal(replacement.deviceId, 'new');
  } finally {
    context.close();
  }
});

test('recent task timeline distinguishes completion, failure, stop, and heartbeat expiry', () => {
  const context = fixture();
  try {
    createAccount(context.store);
    const completed = context.store.acquireLease({ accountId: 'claude-work', deviceId: 'mac-mini' });
    context.store.releaseLease(completed.id, { fenceToken: completed.fenceToken, reason: 'exit_0' });
    const failed = context.store.acquireLease({ accountId: 'claude-work', deviceId: 'windows' });
    context.store.releaseLease(failed.id, { fenceToken: failed.fenceToken, reason: 'exit_7' });
    const stopped = context.store.acquireLease({ accountId: 'claude-work', deviceId: 'macbook' });
    context.store.releaseLease(stopped.id, { fenceToken: stopped.fenceToken, reason: 'manual_stop' });
    context.store.acquireLease({ accountId: 'claude-work', deviceId: 'offline', ttlMs: 5_000 });
    context.advance(5_001);

    const snapshot = context.store.snapshot();
    assert.deepEqual(snapshot.accounts[0].recentTasks.map((task) => task.status), [
      'expired', 'stopped', 'failed', 'completed'
    ]);
    assert.equal(snapshot.accounts[0].activeCount, 0);
    assert.equal(snapshot.recentTasks[0].deviceId, 'offline');
    const persisted = fs.readFileSync(path.join(context.dir, 'occupancy.json'), 'utf8');
    assert.match(persisted, /"recentTasks"/);
  } finally {
    context.close();
  }
});

test('recent task retention is pruned from the persisted store', () => {
  const context = fixture();
  try {
    createAccount(context.store);
    const lease = context.store.acquireLease({ accountId: 'claude-work', deviceId: 'mac-mini' });
    context.store.releaseLease(lease.id, { fenceToken: lease.fenceToken, reason: 'exit_0' });
    context.advance(7 * 24 * 60 * 60 * 1000 + 1);
    assert.deepEqual(context.store.snapshot().recentTasks, []);
    const persisted = JSON.parse(fs.readFileSync(path.join(context.dir, 'occupancy.json'), 'utf8'));
    assert.deepEqual(persisted.recentTasks, []);
  } finally {
    context.close();
  }
});

test('detector leases expose estimated reliability and changes emit reasons', () => {
  const context = fixture();
  try {
    const reasons = [];
    context.store.onChange((_snapshot, reason) => reasons.push(reason));
    createAccount(context.store);
    context.store.acquireLease({
      accountId: 'claude-work',
      deviceId: 'scanner',
      source: 'detector',
      confidence: 0.7
    });
    const snapshot = context.store.snapshot();
    assert.equal(snapshot.accounts[0].reliability, 'estimated');
    assert.equal(snapshot.accounts[0].tasks[0].fresh, true);
    assert.deepEqual(reasons, ['account_create', 'lease_acquire']);
    assert.equal(snapshot.generatedAt, snapshot.updatedAt);
  } finally {
    context.close();
  }
});

test('quota links persist hashed identities, support replacement, and never store raw email', () => {
  const context = fixture();
  try {
    const created = context.store.createAccount({
      id: 'gpt-pro',
      provider: 'chatgpt',
      alias: 'GPT Pro',
      capacity: 2,
      quotaLink: { provider: 'codex', accountEmail: 'Primary.User@example.com', accountLabel: 'Plus' }
    });
    assert.equal(created.quotaLink.provider, 'codex');
    assert.match(created.quotaLink.accountEmailHash, /^sha256:[0-9a-f]{64}$/);
    const persisted = fs.readFileSync(path.join(context.dir, 'occupancy.json'), 'utf8');
    assert.doesNotMatch(persisted, /Primary\.User@example\.com/i);

    const updated = context.store.updateAccount('gpt-pro', {
      quotaLink: { provider: 'codex', accountKey: 'sha256:stable-account', accountLabel: 'Pro' }
    });
    assert.equal(updated.quotaLink.accountKey, 'sha256:stable-account');
    assert.equal(updated.quotaLink.accountEmailHash, '');
    assert.equal(context.store.updateAccount('gpt-pro', { quotaLink: null }).quotaLink, null);
  } finally {
    context.close();
  }
});
