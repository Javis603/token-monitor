'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
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

// Bounded by elapsed time, not by a poll count. Several of these conditions are
// reached by a timer the runtime sets, and a fixed number of setImmediate turns
// buys an amount of wall-clock that depends entirely on how fast the machine is:
// 100 of them cover barely over a millisecond here, so a runner even slightly
// quicker exhausted them before a `setTimeout(..., 1)` could fire. Polling on a
// timer also guarantees the timers phase runs between checks. The 2 s / 5 ms
// shape and the monotonic clock match the other polling helpers in tests/shared.
async function waitFor(predicate, message = 'condition', timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (performance.now() >= deadline) assert.fail(`Timed out waiting for ${message} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
    maxConcurrency: 1,
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

test('provider probes share runtime-local state across refreshes', async () => {
  const runtimeStates = [];
  const runtime = createLimitsRuntime({ limitProviders: ['claude'] }, runtimeDeps({
    probeProvider: async (_provider, _config, _context, deps) => {
      runtimeStates.push(deps.providerRuntimeState);
      return [providerRow('claude', 'account', 'Claude')];
    }
  }));

  await runtime.refresh({}, 'first');
  await runtime.refresh({}, 'second');

  assert.equal(runtimeStates.length, 2);
  assert.equal(runtimeStates[0] instanceof Map, true);
  assert.equal(runtimeStates[1], runtimeStates[0]);
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

test('diagnostic events expose queue state without leaking scoped credentials', async () => {
  const events = [];
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, runtimeDeps({
    onEvent: (event) => events.push(event),
    probeProvider: async () => [providerRow('kimi', 'account', 'Kimi')]
  }));

  await runtime.refresh({ provider: 'kimi', credential: 'secret-cookie' }, 'credential-edit');

  assert.deepEqual(events.map((event) => event.type), ['probe-start', 'probe-finish']);
  assert.ok(events.every((event) => event.provider === 'kimi'));
  assert.ok(events.every((event) => Number.isInteger(event.active) && Number.isInteger(event.queued)));
  assert.ok(!JSON.stringify(events).includes('secret-cookie'));
  await waitFor(() => runtime.getDiagnostics().active === 0, 'executor to become idle');
  const diagnostics = runtime.getDiagnostics();
  assert.equal(diagnostics.enabled, true);
  assert.equal(diagnostics.active, 0);
  assert.equal(diagnostics.maxConcurrency, 1);
  assert.equal(diagnostics.queued, 0);
  assert.deepEqual(diagnostics.providers[0], {
    provider: 'kimi',
    configured: true,
    active: false,
    pending: 0,
    accountCount: 1,
    retryAttempt: 0,
    retryAt: null,
    lastAttemptAt: diagnostics.providers[0].lastAttemptAt,
    lastSuccessAt: '2026-07-21T00:00:00.000Z',
    lastFailureCode: null
  });
  assert.match(diagnostics.providers[0].lastAttemptAt, /^\d{4}-\d{2}-\d{2}T/);
  runtime.stop();
});

test('a throwing diagnostic observer cannot break collection', async () => {
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, runtimeDeps({
    onEvent: () => { throw new Error('observer failed'); },
    probeProvider: async () => [providerRow('kimi', 'account', 'Kimi')]
  }));

  const result = await runtime.refresh({ provider: 'kimi' }, 'manual');
  assert.equal(result.superseded, false);
  assert.equal(runtime.getSnapshot().providers[0].status, 'ok');
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

test('the shared limits executor runs up to its configured bound', async () => {
  const jobs = [];
  let active = 0;
  let maximum = 0;
  const runtime = createLimitsRuntime({ limitProviders: ['claude', 'kimi', 'mimo'] }, runtimeDeps({
    maxConcurrency: 2,
    probeProvider: (provider) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const job = deferred();
      jobs.push({ provider, job });
      return job.promise.finally(() => { active -= 1; });
    }
  }));

  const refresh = runtime.refresh({}, 'manual');
  await waitFor(() => jobs.length === 2, 'first bounded provider batch');
  assert.equal(active, 2);
  jobs[0].job.resolve([providerRow(jobs[0].provider, 'one', 'One')]);
  await waitFor(() => jobs.length === 3, 'next provider dispatch');
  jobs[1].job.resolve([providerRow(jobs[1].provider, 'two', 'Two')]);
  jobs[2].job.resolve([providerRow(jobs[2].provider, 'three', 'Three')]);
  await refresh;

  assert.equal(maximum, 2);
  runtime.stop();
});

test('a provider lane stays serial while other providers use executor capacity', async () => {
  const jobs = [];
  const activeByProvider = new Map();
  let sameProviderOverlap = false;
  const runtime = createLimitsRuntime({ limitProviders: ['claude', 'kimi'] }, runtimeDeps({
    maxConcurrency: 2,
    probeProvider: (provider, _config, context) => {
      const active = (activeByProvider.get(provider) || 0) + 1;
      activeByProvider.set(provider, active);
      if (active > 1) sameProviderOverlap = true;
      const job = deferred();
      jobs.push({ provider, reason: context.reason, job });
      return job.promise.finally(() => activeByProvider.set(provider, active - 1));
    }
  }));

  const firstClaude = runtime.refresh({ provider: 'claude' }, 'manual');
  const kimi = runtime.refresh({ provider: 'kimi' }, 'manual');
  await waitFor(() => jobs.length === 2, 'cross-provider concurrency');
  const secondClaude = runtime.refresh({ provider: 'claude' }, 'credential-save');
  assert.equal((await firstClaude).superseded, true);
  assert.equal(jobs.filter((job) => job.provider === 'claude').length, 1);

  jobs.find((job) => job.provider === 'claude').job.resolve([providerRow('claude', 'old', 'Old')]);
  await waitFor(() => jobs.filter((job) => job.provider === 'claude').length === 2, 'trailing Claude dispatch');
  jobs.find((job) => job.provider === 'kimi').job.resolve([providerRow('kimi', 'kimi', 'Kimi')]);
  jobs.filter((job) => job.provider === 'claude')[1].job.resolve([providerRow('claude', 'new', 'New')]);
  await Promise.all([kimi, secondClaude]);

  assert.equal(sameProviderOverlap, false);
  runtime.stop();
});

test('a fast provider publishes before a slower provider finishes', async () => {
  const jobs = new Map();
  const updates = [];
  const runtime = createLimitsRuntime({ limitProviders: ['claude', 'kimi'] }, runtimeDeps({
    maxConcurrency: 2,
    onUpdate: (summary) => updates.push(summary.providers.map((row) => row.provider)),
    probeProvider: (provider) => {
      const job = deferred();
      jobs.set(provider, job);
      return job.promise;
    }
  }));

  const refresh = runtime.refresh({}, 'manual');
  await waitFor(() => jobs.size === 2, 'parallel provider dispatches');
  jobs.get('kimi').resolve([providerRow('kimi', 'kimi', 'Kimi')]);
  await waitFor(() => updates.some((providers) => providers.includes('kimi')), 'incremental Kimi publication');
  assert.equal(updates.at(-1).includes('claude'), false);
  jobs.get('claude').resolve([providerRow('claude', 'claude', 'Claude')]);
  await refresh;
  assert.deepEqual(runtime.getSnapshot().providers.map((row) => row.provider).sort(), ['claude', 'kimi']);
  runtime.stop();
});

test('Retry-After defers the provider retry and manual refresh does not bypass it', async () => {
  const clock = fakeClock(10_000);
  const calls = [];
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, runtimeDeps({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0,
    probeProvider: async (_provider, _config, context) => {
      calls.push(context.reason);
      if (calls.length === 1) {
        context.onRetryAfter(30_000);
        return [{ provider: 'kimi', status: 'sourceRateLimited', windows: [] }];
      }
      return [providerRow('kimi', 'account', 'Kimi')];
    }
  }));

  await runtime.refresh({ provider: 'kimi' }, 'interval');
  assert.deepEqual(clock.delays(), [30_000]);
  const manual = await runtime.refresh({ provider: 'kimi' }, 'manual');
  assert.equal(manual.deferred, true);
  assert.equal(calls.length, 1);
  clock.advance(29_999);
  assert.equal(calls.length, 1);
  clock.advance(1);
  await waitFor(() => calls.length === 2, 'Retry-After dispatch');
  assert.deepEqual(calls, ['interval', 'retry']);
  assert.deepEqual(clock.delays(), []);
  runtime.stop();
});

test('transient failures use exponential jittered backoff and reset after success', async () => {
  const clock = fakeClock(0);
  let calls = 0;
  const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, runtimeDeps({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    retryBaseMs: 1_000,
    retryMaxMs: 10_000,
    random: () => 0,
    probeProvider: async () => {
      calls += 1;
      if (calls < 3) return [{ provider: 'kimi', status: 'unavailable', windows: [] }];
      return [providerRow('kimi', 'account', 'Kimi')];
    }
  }));

  await runtime.refresh({ provider: 'kimi' }, 'interval');
  assert.deepEqual(clock.delays(), [500]);
  clock.advance(500);
  await waitFor(() => calls === 2, 'first retry');
  assert.deepEqual(clock.delays(), [1_000]);
  clock.advance(1_000);
  await waitFor(() => calls === 3, 'second retry');
  assert.deepEqual(clock.delays(), []);
  runtime.stop();
});

test('credential and account lifecycle changes clear an old provider cooldown', async () => {
  for (const reason of [
    'credential-save',
    'account-added',
    'account-state',
    'system-account-switch',
    'settings-change'
  ]) {
    const clock = fakeClock(0);
    const calls = [];
    const runtime = createLimitsRuntime({ limitProviders: ['kimi'] }, runtimeDeps({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0,
      probeProvider: async (_provider, _config, context) => {
        calls.push(context.reason);
        if (calls.length === 1) {
          context.onRetryAfter(60_000);
          return [{ provider: 'kimi', status: 'sourceRateLimited', windows: [] }];
        }
        return [providerRow('kimi', 'new', 'New credential')];
      }
    }));

    await runtime.refresh({ provider: 'kimi' }, 'interval');
    assert.deepEqual(clock.delays(), [60_000], reason);
    await runtime.refresh({ provider: 'kimi', accountKey: 'new' }, reason);
    assert.deepEqual(calls, ['interval', reason], reason);
    assert.deepEqual(clock.delays(), [], reason);
    runtime.stop();
  }
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

function burnRateRuntime(clock, usedPercent, overrides = {}, config = {}) {
  const calls = [];
  const runtime = createLimitsRuntime(
    { limitProviders: ['claude', 'kimi'], limitsRefreshMode: 'adaptive', ...config },
    runtimeDeps({
      autoStart: true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      probeProvider: async (provider, _config, context) => {
        calls.push({ provider, reason: context.reason, scope: context.scope });
        return [providerRow(provider, 'acct', 'Account', {
          updatedAt: new Date(clock.now()).toISOString(),
          windows: [{ kind: 'session', label: '5-hour', usedPercent: usedPercent(provider) }]
        })];
      },
      ...overrides
    })
  );
  return { calls, runtime };
}

// A quota burning 20 points per 5-minute interval has 12 left, so it runs out in
// three minutes. Waiting a full base interval would show that 12% right up to
// the moment it became 0; the early probe bounds the error to the floor instead.
test('a burning quota gets an early provider-scoped refresh before the base interval', async () => {
  const clock = fakeClock(1_000);
  const used = { claude: 68, kimi: 10 };
  const { calls, runtime } = burnRateRuntime(clock, (provider) => used[provider]);

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    assert.deepEqual(clock.delays(), [300_000]);

    used.claude = 88;
    used.kimi = 20;
    clock.advance(300_000);
    await waitFor(() => calls.length === 4, 'interval refresh');
    // Only the claude lane is close enough to exhaustion to earn one: kimi burned
    // the same 10 points but has 80% left, so the base cadence still covers it.
    assert.deepEqual(clock.delays(), [60_000, 300_000]);

    clock.advance(60_000);
    await waitFor(() => calls.length === 5, 'burn-rate refresh');
    assert.equal(calls[4].provider, 'claude');
    assert.equal(calls[4].reason, 'burn-rate');
    assert.equal(calls[4].scope.provider, 'claude');
    assert.equal(calls[4].scope.accountKey, 'acct');
  } finally {
    runtime.stop();
  }
  assert.deepEqual(clock.delays(), []);
});

// A provider lane is latest-wins, so scheduling a scope whose probe is still
// running aborts that probe. A provider slower than the 60s floor would publish
// nothing at all and only emit cancelled requests, which is worse than the base
// cadence it replaced.
test('a probe slower than the floor is never superseded by the next urgency tick', async () => {
  const clock = fakeClock(1_000);
  const used = { claude: 68, kimi: 10 };
  const aborted = [];
  let release = null;
  const { calls, runtime } = burnRateRuntime(clock, (provider) => used[provider], {
    probeProvider: async (provider, _config, context) => {
      calls.push({ provider, reason: context.reason });
      const rows = [providerRow(provider, 'acct', 'Account', {
        updatedAt: new Date(clock.now()).toISOString(),
        windows: [{ kind: 'session', label: '5-hour', usedPercent: used[provider] }]
      })];
      if (context.reason !== 'burn-rate') return rows;
      return new Promise((resolve, reject) => {
        context.signal?.addEventListener('abort', () => {
          aborted.push(provider);
          reject(new Error('aborted'));
        });
        release = () => resolve(rows);
      });
    }
  });

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    used.claude = 88;
    used.kimi = 20;
    clock.advance(300_000);
    await waitFor(() => calls.length === 4, 'interval refresh');

    clock.advance(60_000);
    await waitFor(() => calls.length === 5, 'burn-rate probe');
    assert.equal(calls[4].reason, 'burn-rate');
    // The probe is still running. No second urgency probe may be armed for it.
    assert.equal(clock.delays().includes(60_000), false);

    clock.advance(120_000);
    assert.equal(calls.length, 5);
    assert.deepEqual(aborted, []);

    release();
    await waitFor(
      () => clock.delays().some((delay) => delay < 300_000),
      'urgency re-armed after settle'
    );
  } finally {
    release?.();
    runtime.stop();
  }
});

// Lanes are per provider and the executor is concurrent, so one provider holding
// a probe open must not push another past its own deadline.
test('a second provider still fires while the first urgency probe is in flight', async () => {
  const clock = fakeClock(1_000);
  const used = { claude: 60, kimi: 60 };
  let release = null;
  const { calls, runtime } = burnRateRuntime(clock, (provider) => used[provider], {
    probeProvider: async (provider, _config, context) => {
      calls.push({ provider, reason: context.reason });
      const rows = [providerRow(provider, 'acct', 'Account', {
        updatedAt: new Date(clock.now()).toISOString(),
        windows: [{ kind: 'session', label: '5-hour', usedPercent: used[provider] }]
      })];
      if (context.reason !== 'burn-rate' || provider !== 'claude') return rows;
      return new Promise((resolve) => { release = () => resolve(rows); });
    }
  });

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    // claude runs out in 128s (floored to a 60s deadline), kimi in 300s (75s).
    used.claude = 88;
    used.kimi = 80;
    clock.advance(300_000);
    await waitFor(() => calls.length === 4, 'interval refresh');
    assert.deepEqual(clock.delays(), [60_000, 300_000]);

    clock.advance(60_000);
    await waitFor(() => calls.length === 5, 'claude burn-rate probe');
    assert.equal(calls[4].provider, 'claude');
    // claude is still running, so the next timer belongs to kimi, 15s away.
    assert.equal(clock.delays().includes(15_000), true);

    clock.advance(15_000);
    await waitFor(() => calls.length === 6, 'kimi burn-rate probe');
    assert.equal(calls[5].provider, 'kimi');
    assert.equal(calls[5].reason, 'burn-rate');
  } finally {
    release?.();
    runtime.stop();
  }
});

// previousLimits seeds lastGood rows that can be hours old, and a failed probe
// republishes them under the failure status. Sampling one would date an offline
// session's consumption to startup and invent an enormous burn rate.
test('a retained row from a failed probe never becomes the burn-rate baseline', async () => {
  const clock = fakeClock(1_000);
  const previousLimits = {
    providers: [providerRow('claude', 'acct', 'Account', {
      updatedAt: '2026-08-13T00:00:00.000Z',
      windows: [{ kind: 'session', label: '5-hour', usedPercent: 30 }]
    })]
  };
  let attempt = 0;
  const calls = [];
  const runtime = createLimitsRuntime(
    { limitProviders: ['claude'], limitsRefreshMode: 'adaptive', previousLimits },
    runtimeDeps({
      autoStart: true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      autoRetry: false,
      probeProvider: async (provider, _config, context) => {
        calls.push(context.reason);
        attempt += 1;
        if (attempt === 1) throw new Error('offline');
        return [providerRow(provider, 'acct', 'Account', {
          updatedAt: new Date(clock.now()).toISOString(),
          windows: [{ kind: 'session', label: '5-hour', usedPercent: 70 }]
        })];
      }
    })
  );

  try {
    await waitFor(() => calls.length === 1, 'failed startup probe');
    clock.advance(60_000);
    await runtime.refresh({ provider: 'claude' }, 'manual');
    // 30% -> 70% spans the offline gap, not the minute between these two probes,
    // so the successful row is the first baseline and no rate exists yet. Only
    // the base interval stays armed.
    assert.deepEqual(clock.delays(), [240_000]);
  } finally {
    runtime.stop();
  }
});

// Any provider committing rebuilds the whole snapshot, which still holds the
// persisted rows of providers that have not answered yet. Sampling one of those
// would date a previous session's usage to now and invent a huge burn rate.
test('a seeded row is never sampled because another provider committed first', async () => {
  const clock = fakeClock(1_000);
  const previousLimits = {
    providers: [
      providerRow('claude', 'acct', 'Account', { windows: [{ kind: 'session', label: '5-hour', usedPercent: 30 }] }),
      providerRow('kimi', 'acct', 'Account', { windows: [{ kind: 'session', label: '5-hour', usedPercent: 20 }] })
    ]
  };
  const used = { claude: 32, kimi: 60 };
  const calls = [];
  const runtime = createLimitsRuntime(
    { limitProviders: ['claude', 'kimi'], limitsRefreshMode: 'adaptive', previousLimits },
    runtimeDeps({
      autoStart: true,
      maxConcurrency: 1,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      probeProvider: async (provider) => {
        calls.push(provider);
        // Claude answers first and rebuilds the snapshot while kimi still shows
        // its seed; kimi then answers a minute later, 20% -> 60%.
        if (provider === 'kimi') clock.jump(60_000);
        return [providerRow(provider, 'acct', 'Account', {
          updatedAt: new Date(clock.now()).toISOString(),
          windows: [{ kind: 'session', label: '5-hour', usedPercent: used[provider] }]
        })];
      }
    })
  );

  try {
    await waitFor(() => calls.length === 2, 'both startup probes');
    assert.deepEqual(calls, ['claude', 'kimi']);
    assert.deepEqual(clock.delays(), [240_000]);
  } finally {
    runtime.stop();
  }
});

// An intent superseded by another refresh resolves its promise at once while the
// physical probe keeps running, so inFlight alone would clear early and let the
// next urgency tick abort a probe that another reason had legitimately started.
test('an urgency tick never aborts a probe another reason is still running', async () => {
  const clock = fakeClock(1_000);
  const used = { claude: 68, kimi: 10 };
  const aborted = [];
  const started = [];
  let releaseAccount = null;
  const { calls, runtime } = burnRateRuntime(clock, (provider) => used[provider], {
    probeProvider: async (provider, _config, context) => {
      calls.push({ provider, reason: context.reason });
      started.push(context.reason);
      const rows = [providerRow(provider, 'acct', 'Account', {
        updatedAt: new Date(clock.now()).toISOString(),
        windows: [{ kind: 'session', label: '5-hour', usedPercent: used[provider] }]
      })];
      if (context.reason !== 'burn-rate' && context.reason !== 'account-state') return rows;
      return new Promise((resolve) => {
        context.signal?.addEventListener('abort', () => aborted.push(context.reason));
        if (context.reason === 'account-state') releaseAccount = () => resolve(rows);
      });
    }
  });

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    used.claude = 88;
    used.kimi = 20;
    clock.advance(300_000);
    await waitFor(() => calls.length === 4, 'interval refresh');

    clock.advance(60_000);
    await waitFor(() => started.includes('burn-rate'), 'burn-rate probe');
    // Supersedes the burn-rate intent, so its promise settles while this probe runs.
    void runtime.refresh({ provider: 'claude', accountKey: 'acct' }, 'account-state');
    await waitFor(() => started.includes('account-state'), 'account refresh probe');

    clock.advance(120_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(aborted.includes('account-state'), false);
    assert.equal(started.filter((reason) => reason === 'burn-rate').length, 1);
  } finally {
    releaseAccount?.();
    runtime.stop();
  }
});

// A tick can land while the executor is saturated, so the lane is not active yet
// but already holds queued work for this scope. Superseding it would replace a
// real account refresh with a scheduler optimisation.
test('an urgency tick never supersedes a refresh already queued for its scope', async () => {
  const clock = fakeClock(1_000);
  const used = { claude: 60, kimi: 10 };
  const started = [];
  let releaseKimi = null;
  const { calls, runtime } = burnRateRuntime(clock, (provider) => used[provider], {
    probeProvider: async (provider, _config, context) => {
      calls.push({ provider, reason: context.reason });
      started.push(`${provider}:${context.reason}`);
      const rows = [providerRow(provider, 'acct', 'Account', {
        updatedAt: new Date(clock.now()).toISOString(),
        windows: [{ kind: 'session', label: '5-hour', usedPercent: used[provider] }]
      })];
      if (provider !== 'kimi' || context.reason !== 'manual') return rows;
      return new Promise((resolve) => { releaseKimi = () => resolve(rows); });
    }
  });

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    used.claude = 88;
    used.kimi = 20;
    clock.advance(300_000);
    await waitFor(() => calls.length === 4, 'interval refresh');

    // Occupies the single executor slot, so claude's own refresh can only queue.
    void runtime.refresh({ provider: 'kimi' }, 'manual');
    await waitFor(() => started.includes('kimi:manual'), 'kimi probe holding the slot');
    void runtime.refresh({ provider: 'claude', accountKey: 'acct' }, 'account-state');

    clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseKimi();

    await waitFor(() => started.some((entry) => entry.startsWith('claude:')
      && !entry.endsWith(':startup') && !entry.endsWith(':interval')), 'queued claude probe');
    assert.equal(started.includes('claude:account-state'), true);
    assert.equal(started.includes('claude:burn-rate'), false);
  } finally {
    releaseKimi?.();
    runtime.stop();
  }
});

// An account is addressable by several aliases, and callers enqueue whichever
// one they hold: a profile refresh uses accountName while the row itself also
// carries an accountKey. Comparing identity keys reads those as two accounts.
test('queued work is matched by account alias, not by identity key', async () => {
  const clock = fakeClock(1_000);
  const used = { claude: 60, kimi: 10 };
  const started = [];
  let releaseKimi = null;
  const row = (provider) => ({
    provider,
    accountKey: 'acct-key',
    accountName: 'profile-one',
    accountLabel: 'Account',
    source: 'api',
    status: 'ok',
    updatedAt: new Date(clock.now()).toISOString(),
    windows: [{ kind: 'session', label: '5-hour', usedPercent: used[provider] }]
  });
  const { calls, runtime } = burnRateRuntime(clock, (provider) => used[provider], {
    probeProvider: async (provider, _config, context) => {
      calls.push({ provider, reason: context.reason });
      started.push(`${provider}:${context.reason}`);
      if (provider !== 'kimi' || context.reason !== 'manual') return [row(provider)];
      return new Promise((resolve) => { releaseKimi = () => resolve([row(provider)]); });
    }
  });

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    used.claude = 88;
    used.kimi = 20;
    clock.advance(300_000);
    await waitFor(() => calls.length === 4, 'interval refresh');

    void runtime.refresh({ provider: 'kimi' }, 'manual');
    await waitFor(() => started.includes('kimi:manual'), 'kimi probe holding the slot');
    // Enqueued by name; the urgency scope for the same account resolves by key.
    void runtime.refresh({ provider: 'claude', accountName: 'profile-one' }, 'profile-state');

    clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseKimi();

    await waitFor(() => started.includes('claude:profile-state'), 'queued profile refresh');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(started.includes('claude:burn-rate'), false);
  } finally {
    releaseKimi?.();
    runtime.stop();
  }
});

// Accounts on one lane queue behind each other without cancelling, so a probe
// for a different account is not a reason to make an urgent one forfeit its turn
// and wait another floor.
test('an urgent account queues behind a different account on the same lane', async () => {
  const clock = fakeClock(1_000);
  const used = { a: 60, b: 10 };
  const started = [];
  const aborted = [];
  let releaseB = null;
  const rowFor = (key) => ({
    provider: 'claude',
    accountKey: key,
    accountLabel: `Account ${key}`,
    source: 'api',
    status: 'ok',
    updatedAt: new Date(clock.now()).toISOString(),
    windows: [{ kind: 'session', label: '5-hour', usedPercent: used[key] }]
  });
  const runtime = createLimitsRuntime(
    { limitProviders: ['claude'], limitsRefreshMode: 'adaptive' },
    runtimeDeps({
      autoStart: true,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      probeProvider: async (_provider, _config, context) => {
        const scoped = context.scope?.accountKey;
        started.push(`${scoped || '*'}:${context.reason}`);
        if (scoped !== 'b') return scoped ? [rowFor(scoped)] : [rowFor('a'), rowFor('b')];
        return new Promise((resolve) => {
          context.signal?.addEventListener('abort', () => aborted.push('b'));
          releaseB = () => resolve([rowFor('b')]);
        });
      }
    })
  );

  try {
    await waitFor(() => started.length === 1, 'startup refresh');
    used.a = 88;
    used.b = 20;
    clock.advance(300_000);
    await waitFor(() => started.length === 2, 'interval refresh');

    // Only account a is close to exhaustion; b holds the lane with a slow probe.
    void runtime.refresh({ provider: 'claude', accountKey: 'b' }, 'manual');
    await waitFor(() => started.includes('b:manual'), 'account b probe');

    clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(aborted, []);

    releaseB();
    await waitFor(() => started.includes('a:burn-rate'), 'account a urgency probe');
  } finally {
    releaseB?.();
    runtime.stop();
  }
});

test('fixed mode never schedules an early refresh', async () => {
  const clock = fakeClock(1_000);
  const used = { claude: 68, kimi: 10 };
  const { calls, runtime } = burnRateRuntime(
    clock,
    (provider) => used[provider],
    {},
    { limitsRefreshMode: 'fixed', limitsRefreshMs: 300_000 }
  );

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    used.claude = 88;
    clock.advance(300_000);
    await waitFor(() => calls.length === 4, 'interval refresh');
    assert.deepEqual(clock.delays(), [300_000]);
    clock.advance(300_000);
    await waitFor(() => calls.length === 6, 'second interval refresh');
    assert.deepEqual(clock.delays(), [300_000]);
  } finally {
    runtime.stop();
  }
});

// Adaptive replaces the stored interval with its own baseline rather than
// modifying it, so a device saved at 30 minutes polls at 5 while adaptive.
test('adaptive uses its own baseline and ignores the stored interval', async () => {
  const clock = fakeClock(1_000);
  const { calls, runtime } = burnRateRuntime(
    clock,
    () => 10,
    {},
    { limitsRefreshMode: 'adaptive', limitsRefreshMs: 1_800_000 }
  );

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    assert.deepEqual(clock.delays(), [300_000]);
    assert.equal(runtime.getSnapshot().refreshMs, 300_000);
  } finally {
    runtime.stop();
  }
});

// The stored interval surviving a trip through adaptive is the whole reason the
// mode is a separate setting, so it is pinned rather than left to the reader of
// the two assignments in the runtime.
test('switching to adaptive and back restores the stored interval', async () => {
  const clock = fakeClock(1_000);
  const { calls, runtime } = burnRateRuntime(
    clock,
    () => 10,
    {},
    { limitsRefreshMode: 'fixed', limitsRefreshMs: 1_800_000 }
  );

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    assert.deepEqual(clock.delays(), [1_800_000]);

    runtime.reconfigure({ limitsRefreshMode: 'adaptive' });
    assert.equal(runtime.getSnapshot().refreshMs, 300_000);
    assert.deepEqual(clock.delays(), [300_000]);

    // Only the mode is sent back, exactly as the settings dropdown does.
    runtime.reconfigure({ limitsRefreshMode: 'fixed' });
    assert.equal(runtime.getSnapshot().refreshMs, 1_800_000);
    assert.deepEqual(clock.delays(), [1_800_000]);
  } finally {
    runtime.stop();
  }
});

// The case a "remaining < N%" threshold gets wrong: low, but nothing is
// consuming it, so nothing is gained by probing more often than configured.
test('a low but idle quota keeps the base cadence', async () => {
  const clock = fakeClock(1_000);
  const { calls, runtime } = burnRateRuntime(clock, () => 88);

  try {
    await waitFor(() => calls.length === 2, 'startup refresh');
    clock.advance(300_000);
    await waitFor(() => calls.length === 4, 'interval refresh');
    assert.deepEqual(clock.delays(), [300_000]);
    clock.advance(300_000);
    await waitFor(() => calls.length === 6, 'second interval refresh');
    assert.deepEqual(clock.delays(), [300_000]);
  } finally {
    runtime.stop();
  }
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
