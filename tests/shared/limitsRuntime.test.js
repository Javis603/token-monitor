'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLimitsRuntime } = require('../../src/shared/limitsRuntime');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, message = 'condition') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

function providerRow(provider, accountKey, label, options = {}) {
  return {
    provider,
    accountKey,
    accountLabel: label,
    source: 'api',
    status: options.status || 'ok',
    updatedAt: options.updatedAt || '2026-07-21T00:00:00.000Z',
    windows: options.windows === undefined
      ? [{ kind: 'session', label: '5-hour', usedPercent: 20, resetsAt: options.resetsAt }]
      : options.windows
  };
}

function runtimeDeps(overrides = {}) {
  return {
    autoStart: false,
    cleanupGraceMs: 0,
    providerPhysicalBoundMs: () => 100,
    ...overrides
  };
}

function fakeClock(startMs = 0) {
  let current = startMs;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, delayMs) {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(0, Number(delayMs) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    jump(ms) {
      current += ms;
    },
    advance(ms) {
      current += ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= current)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
    delays() {
      return [...timers.values()].map((timer) => timer.at - current).sort((a, b) => a - b);
    }
  };
}

test('same-scope A to B supersession discards A and runs B as the trailing job', async () => {
  const jobs = [];
  let credential = 'A';
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, runtimeDeps({
    resolveConfigSnapshot: () => ({ credential }),
    probeProvider: (_provider, config) => {
      const job = deferred();
      jobs.push({ credential: config.credential, job });
      return job.promise;
    }
  }));

  const first = runtime.refresh({ provider: 'kimi' }, 'credential-edit');
  await waitFor(() => jobs.length === 1, 'A dispatch');
  credential = 'B';
  const second = runtime.refresh({ provider: 'kimi' }, 'credential-edit');
  assert.equal((await first).superseded, true);

  jobs[0].job.resolve([providerRow('kimi', 'account', 'A')]);
  await waitFor(() => jobs.length === 2, 'B trailing dispatch');
  assert.equal(jobs[1].credential, 'B');
  jobs[1].job.resolve([providerRow('kimi', 'account', 'B')]);
  await second;

  assert.equal(runtime.getSnapshot().providers[0].accountLabel, 'B');
  runtime.stop();
});

test('different account scopes stay independent inside one provider lane', async () => {
  const jobs = [];
  const runtime = createLimitsRuntime({ limitProviders: ['mimo'] }, runtimeDeps({
    probeProvider: (_provider, _config, context) => {
      const job = deferred();
      jobs.push({ scope: context.scope, job });
      return job.promise;
    }
  }));

  const accountA = runtime.refresh({ provider: 'mimo', accountKey: 'A' }, 'edit');
  await waitFor(() => jobs.length === 1, 'account A dispatch');
  const accountB = runtime.refresh({ provider: 'mimo', accountKey: 'B' }, 'edit');
  jobs[0].job.resolve([providerRow('mimo', 'A', 'Account A')]);
  await accountA;
  await waitFor(() => jobs.length === 2, 'account B dispatch');
  jobs[1].job.resolve([providerRow('mimo', 'B', 'Account B')]);
  await accountB;

  assert.deepEqual(
    runtime.getSnapshot().providers.map((row) => row.accountKey).sort(),
    ['A', 'B']
  );
  runtime.stop();
});

test('a later account edit trails an active provider-wide job without discarding other accounts', async () => {
  const jobs = [];
  const runtime = createLimitsRuntime({ limitProviders: ['mimo'] }, runtimeDeps({
    probeProvider: (_provider, _config, context) => {
      const job = deferred();
      jobs.push({ scope: context.scope, job });
      return job.promise;
    }
  }));

  const full = runtime.refresh({ provider: 'mimo' }, 'manual');
  await waitFor(() => jobs.length === 1, 'full dispatch');
  const accountB = runtime.refresh({ provider: 'mimo', accountKey: 'B' }, 'edit');
  jobs[0].job.resolve([
    providerRow('mimo', 'A', 'Account A'),
    providerRow('mimo', 'B', 'Old B')
  ]);
  await full;
  await waitFor(() => jobs.length === 2, 'account B trailing dispatch');
  jobs[1].job.resolve([providerRow('mimo', 'B', 'New B')]);
  await accountB;

  const byKey = Object.fromEntries(runtime.getSnapshot().providers.map((row) => [row.accountKey, row]));
  assert.equal(byKey.A.accountLabel, 'Account A');
  assert.equal(byKey.B.accountLabel, 'New B');
  runtime.stop();
});

test('provider-wide pending work supersedes older account-scoped pending work', async () => {
  const jobs = [];
  const runtime = createLimitsRuntime({ limitProviders: ['claude', 'mimo'] }, runtimeDeps({
    probeProvider: (provider, _config, context) => {
      const job = deferred();
      jobs.push({ provider, scope: context.scope, job });
      return job.promise;
    }
  }));

  const blocker = runtime.refresh({ provider: 'claude' }, 'manual');
  await waitFor(() => jobs.length === 1, 'executor blocker');
  const account = runtime.refresh({ provider: 'mimo', accountKey: 'A' }, 'edit');
  const full = runtime.refresh({ provider: 'mimo' }, 'manual');
  assert.equal((await account).superseded, true);
  jobs[0].job.resolve([providerRow('claude', 'claude', 'Claude')]);
  await blocker;
  await waitFor(() => jobs.length === 2, 'provider-wide MiMo dispatch');
  assert.deepEqual(jobs[1].scope, { provider: 'mimo' });
  jobs[1].job.resolve([providerRow('mimo', 'A', 'Account A')]);
  await full;
  assert.equal(jobs.length, 2);
  runtime.stop();
});

test('the shared limits executor never runs more than one provider job at once', async () => {
  const jobs = [];
  let active = 0;
  let maximum = 0;
  const runtime = createLimitsRuntime({ limitProviders: ['claude', 'kimi'] }, runtimeDeps({
    probeProvider: (provider) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const job = deferred();
      jobs.push({ provider, job });
      return job.promise.finally(() => { active -= 1; });
    }
  }));

  const refresh = runtime.refresh({}, 'manual');
  await waitFor(() => jobs.length === 1, 'first provider dispatch');
  jobs[0].job.resolve([providerRow(jobs[0].provider, 'one', 'One')]);
  await waitFor(() => jobs.length === 2, 'second provider dispatch');
  jobs[1].job.resolve([providerRow(jobs[1].provider, 'two', 'Two')]);
  await refresh;

  assert.equal(maximum, 1);
  runtime.stop();
});

test('a transient failure retains matching lastGood windows with the latest status', async () => {
  const results = [
    [providerRow('kimi', 'account', 'Kimi', { updatedAt: '2026-07-21T00:00:00.000Z' })],
    [{ provider: 'kimi', status: 'unavailable', updatedAt: '2026-07-21T00:05:00.000Z', windows: [] }]
  ];
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, runtimeDeps({
    probeProvider: async () => results.shift()
  }));

  await runtime.refresh({ provider: 'kimi' }, 'startup');
  await runtime.refresh({ provider: 'kimi' }, 'interval');
  const row = runtime.getSnapshot().providers[0];
  assert.equal(row.status, 'unavailable');
  assert.equal(row.updatedAt, '2026-07-21T00:00:00.000Z');
  assert.equal(row.windows.length, 1);
  runtime.stop();
});

test('a mixed full result marks an expected missing identity unavailable without losing its lastGood', async () => {
  const results = [
    [providerRow('mimo', 'A', 'Account A'), providerRow('mimo', 'B', 'Account B')],
    [providerRow('mimo', 'A', 'Account A')]
  ];
  const runtime = createLimitsRuntime({ limitProviders: ['mimo'] }, runtimeDeps({
    probeProvider: async () => results.shift()
  }));

  await runtime.refresh({ provider: 'mimo' }, 'startup');
  await runtime.refresh({ provider: 'mimo' }, 'interval');
  const byKey = Object.fromEntries(runtime.getSnapshot().providers.map((row) => [row.accountKey, row]));
  assert.equal(byKey.A.status, 'ok');
  assert.equal(byKey.B.status, 'unavailable');
  assert.equal(byKey.B.windows.length, 1);
  runtime.stop();
});

test('a new identity failure never retains the removed identity windows', async () => {
  const results = [
    [providerRow('mimo', 'A', 'Account A')],
    [{ provider: 'mimo', status: 'unavailable', windows: [] }]
  ];
  const runtime = createLimitsRuntime({ limitProviders: ['mimo'] }, runtimeDeps({
    probeProvider: async () => results.shift()
  }));

  await runtime.refresh({ provider: 'mimo', accountKey: 'A' }, 'startup');
  runtime.clear({ provider: 'mimo', accountKey: 'A' }, 'identity-switch');
  await runtime.refresh({ provider: 'mimo', accountKey: 'B' }, 'identity-switch');
  const row = runtime.getSnapshot().providers[0];
  assert.equal(row.status, 'unavailable');
  assert.equal(row.windows.length, 0);
  runtime.stop();
});

test('clearing an identity removes old windows synchronously and blocks late commit', async () => {
  const job = deferred();
  const runtime = createLimitsRuntime({ limitProviders: ['mimo'] }, runtimeDeps({
    probeProvider: () => job.promise
  }));

  const pending = runtime.refresh({ provider: 'mimo', accountKey: 'A' }, 'edit');
  await waitFor(() => true);
  runtime.clear({ provider: 'mimo', accountKey: 'A' }, 'logout');
  assert.deepEqual(runtime.getSnapshot().providers, []);
  job.resolve([providerRow('mimo', 'A', 'Old account')]);
  assert.equal((await pending).superseded, true);
  assert.deepEqual(runtime.getSnapshot().providers, []);
  runtime.stop();
});

test('a never-resolving adapter times out logically and receives an aborted signal', async () => {
  let signal;
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, runtimeDeps({
    providerPhysicalBoundMs: () => 5,
    probeProvider: (_provider, _config, context) => {
      signal = context.signal;
      return new Promise(() => {});
    }
  }));

  const result = await runtime.refresh({ provider: 'kimi' }, 'manual');
  assert.equal(result.superseded, false);
  assert.equal(signal.aborted, true);
  assert.equal(runtime.getSnapshot().providers[0].status, 'error');
  runtime.stop();
});

test('stop invalidates a cold-start dispatch before its late result can publish', async () => {
  const job = deferred();
  const updates = [];
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, runtimeDeps({
    onUpdate: (summary) => updates.push(summary),
    probeProvider: () => job.promise
  }));

  const pending = runtime.refresh({ provider: 'kimi' }, 'startup');
  await waitFor(() => updates.length >= 1, 'initial publication');
  runtime.stop();
  job.resolve([providerRow('kimi', 'account', 'Late')]);
  assert.equal((await pending).superseded, true);
  assert.equal(updates.some((summary) => summary.providers.some((row) => row.accountLabel === 'Late')), false);
});

test('reconfigure removes providers immediately, adds them with a scoped refresh, and disable clears all rows', async () => {
  const calls = [];
  const runtime = createLimitsRuntime({ limitProviders: ['claude', 'kimi'] }, runtimeDeps({
    probeProvider: async (provider) => {
      calls.push(provider);
      return [providerRow(provider, provider, provider)];
    }
  }));

  await runtime.refresh({}, 'startup');
  runtime.reconfigure({ limitProviders: ['claude'] });
  assert.deepEqual(runtime.getSnapshot().providers.map((row) => row.provider), ['claude']);
  runtime.reconfigure({ limitProviders: ['claude', 'kimi'] });
  await waitFor(() => calls.filter((provider) => provider === 'kimi').length === 2, 'new provider refresh');
  assert.deepEqual(runtime.getSnapshot().providers.map((row) => row.provider).sort(), ['claude', 'kimi']);
  runtime.reconfigure({ limitsEnabled: false });
  assert.deepEqual(runtime.getSnapshot().providers, []);
  runtime.stop();
});

test('limitsRefreshMs reconfigures only one runtime timer using elapsed cadence', async () => {
  const clock = fakeClock(1_000);
  let calls = 0;
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'], limitsRefreshMs: 120_000 }, runtimeDeps({
    autoStart: true,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    probeProvider: async () => {
      calls += 1;
      return [providerRow('kimi', 'account', 'Kimi')];
    }
  }));

  await waitFor(() => calls === 1, 'startup refresh');
  assert.deepEqual(clock.delays(), [120_000]);
  clock.jump(90_000);
  runtime.reconfigure({ limitsRefreshMs: 60_000 });
  await waitFor(() => calls === 2, 'overdue shortened cadence refresh');
  assert.deepEqual(clock.delays(), [60_000]);

  runtime.reconfigure({ limitsRefreshMs: 300_000 });
  assert.deepEqual(clock.delays(), [300_000]);
  clock.advance(299_999);
  assert.equal(calls, 2);
  clock.advance(1);
  await waitFor(() => calls === 3, 'rescheduled interval refresh');
  assert.deepEqual(clock.delays(), [300_000]);
  runtime.stop();
});

test('reset boundaries enqueue the exact provider/account scope only once', async () => {
  const calls = [];
  const resetsAt = '2026-07-21T01:00:00.000Z';
  const boundaryKey = `mimo:A::Account A:session:${resetsAt}`;
  const runtime = createLimitsRuntime({ limitProviders: ['mimo'], limitsRefreshMs: 60_000 }, runtimeDeps({
    autoStart: true,
    nextLimitsResetBoundary(summary, _now, attempted) {
      if (summary.providers.length === 0 || attempted.has(boundaryKey)) return null;
      return {
        delayMs: 1,
        keys: [boundaryKey],
        scopes: [{ provider: 'mimo', accountKey: 'A' }]
      };
    },
    probeProvider: async (_provider, _config, context) => {
      calls.push(context);
      return [providerRow('mimo', 'A', 'Account A', { resetsAt })];
    }
  }));

  try {
    await waitFor(() => calls.length >= 2, 'reset-boundary dispatch');
    assert.equal(calls[1].reason, 'reset-boundary');
    assert.deepEqual(calls[1].scope, { provider: 'mimo', accountKey: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, 2);
  } finally {
    runtime.stop();
  }
});

test('clearing OpenCode by account name removes a row keyed by account key', () => {
  const runtime = createLimitsRuntime({
    limitProviders: ['opencode'],
    previousLimits: {
      providers: [{
        provider: 'opencode',
        accountKey: 'opencode-key',
        accountName: 'Work',
        status: 'ok',
        updatedAt: '2026-07-21T00:00:00.000Z',
        windows: [{ kind: 'session', usedPercent: 10 }]
      }]
    }
  }, runtimeDeps());

  assert.equal(runtime.getSnapshot().providers.length, 1);
  runtime.clear({ provider: 'opencode', accountName: 'Work' }, 'logout');
  assert.deepEqual(runtime.getSnapshot().providers, []);
  runtime.stop();
});

test('a retained transient previous row seeds lastGood windows after restart', () => {
  const runtime = createLimitsRuntime({
    limitProviders: ['kimi'],
    previousLimits: {
      providers: [providerRow('kimi', 'account', 'Kimi', { status: 'unavailable' })]
    }
  }, runtimeDeps());

  const row = runtime.getSnapshot().providers[0];
  assert.equal(row.status, 'unavailable');
  assert.equal(row.windows.length, 1);
  assert.equal(row.windows[0].usedPercent, 20);
  runtime.stop();
});
