'use strict';

// Live watch scheduling: debounce-only when scans are cheap, a derived 50%
// duty-cycle floor when the last tick outlasted debounce. There is still no
// settings cooldown — these cases lock that split so a later "just add a
// cooldown knob" or "always wait lastDuration" cannot land quietly.

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { clampTimerDelayMs, MAX_TIMER_DELAY_MS } = require('../../src/shared/selfSyncThrottle');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');
const { installInProcessWatchHost } = require('../helpers/watchHost');

const collectorPath = require.resolve('../../src/shared/collector');

installSourceEnvGuard(test);
installInProcessWatchHost(test);

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

function waitForCondition(predicate, timeoutMs = 2000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (performance.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Timed out waiting for condition'));
      }
    }, 5);
  });
}

function withTmpHome(prepare) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'token-monitor-home-'));
  for (const dir of prepare) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  return tmp;
}

async function withLiveCollector(options, fn) {
  const tmp = withTmpHome(options.dirs || [path.join('.claude', 'projects')]);
  const originalHomedir = os.homedir;
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  os.homedir = () => tmp;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmp;

  const chokidar = require('chokidar');
  const originalWatch = chokidar.watch;
  let watchHandler = null;
  chokidar.watch = () => ({
    on: (event, handler) => { if (event === 'all') watchHandler = handler; },
    close: () => {}
  });

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  let spawnDelayMs = options.spawnDelayMs ?? 5;
  let failNext = false;
  childProcess.spawn = (_bin, args) => {
    const fail = failNext;
    failNext = false;
    calls.push({ args, at: performance.now(), fail });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setTimeout(() => {
      if (!fail) child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', fail ? 1 : 0);
    }, spawnDelayMs);
    return child;
  };

  let handle = null;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    const errors = [];
    handle = startCollector({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 5000,
      deviceId: 'test-device',
      agentVersion: 'test',
      intervalMs: 60 * 60 * 1000,
      watchEnabled: true,
      watchDebounceMs: options.watchDebounceMs ?? 10,
      limitsEnabled: false,
      historyEnabled: false,
      onUpdate: (_summary, reason) => updates.push(reason),
      onError: (error) => errors.push(error),
      ...(options.collector || {})
    });
    await waitForCondition(() => updates.length === 1);
    assert.ok(watchHandler, 'watcher handler captured');
    return await fn({
      handle,
      watchHandler,
      calls,
      updates,
      errors,
      tmp,
      setSpawnDelayMs: (ms) => { spawnDelayMs = ms; },
      failNextSpawn: () => { failNext = true; }
    });
  } finally {
    if (handle) handle.stop();
    childProcess.spawn = originalSpawn;
    chokidar.watch = originalWatch;
    os.homedir = originalHomedir;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function fireWatch(watchHandler, tmp, name = 'session.jsonl') {
  watchHandler('change', path.join(tmp, '.claude', 'projects', name));
}

// Windows timer resolution is often ~15ms, and a "fast" tick is still three
// serial setTimeout(0) scans. Absolute 40ms walls flake there; keep the
// debounce-only claim relative to the debounce this case chose.
function assertDebounceOnlyArm(idleGapMs, debounceMs, durationMs) {
  assert.ok(
    durationMs < debounceMs,
    `fast tick should stay cheaper than debounce (${debounceMs}ms), got ${durationMs}ms`
  );
  assert.ok(
    idleGapMs >= debounceMs * 0.4,
    `fast ticks must still honour debounce (${debounceMs}ms), idle gap was ${idleGapMs}ms`
  );
  assert.ok(
    idleGapMs < debounceMs + 80,
    `fast ticks must not grow a hidden cooldown, idle gap was ${idleGapMs}ms after a ${durationMs}ms tick`
  );
}

test('liveTickMinIdleMs treats non-positive and non-finite durations as debounce-only', () => {
  const { liveTickMinIdleMs } = freshCollector();
  for (const last of [undefined, null, 0, -1, -0.5, Number.NaN, Infinity, -Infinity, '', 'nope', {}]) {
    assert.equal(liveTickMinIdleMs(last, 1500), 1500, `lastDuration=${String(last)}`);
    assert.equal(liveTickMinIdleMs(last, 10), 10, `lastDuration=${String(last)} debounce=10`);
  }
});

test('liveTickMinIdleMs follows debounce until lastDuration meets or exceeds it', () => {
  const { liveTickMinIdleMs } = freshCollector();
  const debounce = 1500;
  assert.equal(liveTickMinIdleMs(1, debounce), debounce);
  assert.equal(liveTickMinIdleMs(debounce - 1, debounce), debounce);
  assert.equal(liveTickMinIdleMs(debounce, debounce), debounce);
  assert.equal(liveTickMinIdleMs(debounce + 1, debounce), debounce + 1);
  assert.equal(liveTickMinIdleMs(5000, debounce), 5000);
  assert.equal(liveTickMinIdleMs('5000', debounce), 5000);
});

test('liveTickMinIdleMs 50% duty idle equals lastDuration once it outlasts debounce', () => {
  const { liveTickMinIdleMs, LIVE_TICK_MAX_DUTY_CYCLE } = freshCollector();
  assert.equal(LIVE_TICK_MAX_DUTY_CYCLE, 0.5);
  for (const duration of [1, 10, 1499, 1500, 1501, 5000, 12345]) {
    const idle = liveTickMinIdleMs(duration, 1500);
    const expected = Math.max(1500, duration);
    assert.equal(idle, expected, `duration=${duration}`);
    assert.ok(
      duration / (duration + idle) <= LIVE_TICK_MAX_DUTY_CYCLE + 1e-12,
      `duty ${duration}/${duration + idle} exceeds ${LIVE_TICK_MAX_DUTY_CYCLE}`
    );
  }
  // Fractional overflow still ceils so occupancy cannot creep over 50%.
  assert.equal(liveTickMinIdleMs(1500.2, 1500), 1501);
  assert.equal(liveTickMinIdleMs(10.1, 10), 11);
});

test('liveTickMinIdleMs clamps unusable debounce the same way startCollector does', () => {
  const { liveTickMinIdleMs } = freshCollector();
  assert.equal(liveTickMinIdleMs(400, undefined), clampTimerDelayMs(undefined, 1500));
  assert.equal(liveTickMinIdleMs(400, 0), 1500);
  assert.equal(liveTickMinIdleMs(400, -5), 1500);
  assert.equal(liveTickMinIdleMs(400, Number.NaN), 1500);
  assert.equal(liveTickMinIdleMs(400, Infinity), 1500);
  assert.equal(liveTickMinIdleMs(5000, 0), 5000);
  assert.equal(liveTickMinIdleMs(5000, Infinity), 5000);
  assert.equal(liveTickMinIdleMs(400, 2 ** 32), MAX_TIMER_DELAY_MS);
  assert.equal(liveTickMinIdleMs(MAX_TIMER_DELAY_MS + 1000, 1500), MAX_TIMER_DELAY_MS);
});

test('liveWatchDelayMs always applies debounce; leftover only lengthens it', () => {
  const { liveWatchDelayMs } = freshCollector();
  const debounce = 1500;
  assert.equal(liveWatchDelayMs(400, debounce, 0), debounce);
  assert.equal(liveWatchDelayMs(debounce, debounce, 0), debounce);
  assert.equal(liveWatchDelayMs(5000, debounce, 0), 5000);
  assert.equal(liveWatchDelayMs(5000, debounce, 100), 4900);
  assert.equal(liveWatchDelayMs(5000, debounce, 3500), debounce);
  assert.equal(liveWatchDelayMs(5000, debounce, 3499), 1501);
  assert.equal(liveWatchDelayMs(5000, debounce, 4999), debounce);
  assert.equal(liveWatchDelayMs(5000, debounce, 5000), debounce);
  assert.equal(liveWatchDelayMs(5000, debounce, 5001), debounce);
  assert.equal(liveWatchDelayMs(5000, debounce, 6000), debounce);
});

test('liveWatchDelayMs ignores non-finite or negative sinceFinish instead of inventing leftover', () => {
  const { liveWatchDelayMs } = freshCollector();
  for (const elapsed of [undefined, Number.NaN, Infinity, -Infinity, -1, -100, 'nope']) {
    assert.equal(liveWatchDelayMs(5000, 1500, elapsed), 1500, `sinceFinish=${String(elapsed)}`);
  }
  // Number(null) and Number('') are 0: same as "just finished", so leftover is full.
  assert.equal(liveWatchDelayMs(5000, 1500, null), 5000);
  assert.equal(liveWatchDelayMs(5000, 1500, ''), 5000);
});

test('liveWatchDelayMs leftover shorter than debounce still waits the full debounce', () => {
  const { liveWatchDelayMs } = freshCollector();
  // Event path: debounce already elapsed in the callback leftover branch, but
  // a fresh watch event must still debounce. leftover=1 must not shrink to 1ms.
  assert.equal(liveWatchDelayMs(5000, 1500, 4999), 1500);
  assert.equal(liveWatchDelayMs(80, 10, 79), 10);
  assert.equal(liveWatchDelayMs(80, 10, 0), 80);
});

test('collector module and handle expose no watch-cooldown setting', async () => {
  const collector = freshCollector();
  assert.equal(collector.watchDelayMs, undefined);
  assert.equal(collector.watchCooldownMs, undefined);
  assert.equal(collector.watchMinIntervalMs, undefined);
  await withLiveCollector({ watchDebounceMs: 10, spawnDelayMs: 0 }, async ({ handle }) => {
    for (const key of ['watchDelayMs', 'watchCooldownMs', 'watchMinIdleMs', 'cooldownMs']) {
      assert.equal(handle[key], undefined, key);
    }
    const diagnostics = handle.getDiagnostics();
    assert.equal(diagnostics.watchDebounceMs, 10);
    assert.equal(diagnostics.watchCooldownMs, undefined);
    assert.equal(diagnostics.collectionMode, 'live');
  });
});

test('AGENTS.md and collector comments keep the no-settings-cooldown contract', () => {
  const agents = fs.readFileSync(path.join(__dirname, '../../AGENTS.md'), 'utf8');
  assert.match(agents, /no settings cooldown/);
  assert.match(agents, /remainingDutyIdleMs\(\)/);
  assert.match(agents, /armWatchTick\(\)/);
  assert.match(agents, /50% duty cycle/);
  assert.doesNotMatch(agents, /liveWatchDelayMs\(\)/);
  assert.doesNotMatch(agents, /There is deliberately \*\*no cooldown\*\*/);

  const source = fs.readFileSync(collectorPath, 'utf8');
  assert.match(source, /there is still no settings cooldown/);
  assert.match(source, /LIVE_TICK_MAX_DUTY_CYCLE/);
  assert.match(source, /hidden settings cooldown/);
});

test('a fast watch tick still starts after debounce only', async () => {
  const debounceMs = 200;
  await withLiveCollector({ watchDebounceMs: debounceMs, spawnDelayMs: 0 }, async (ctx) => {
    const { calls, updates, handle, watchHandler, tmp } = ctx;
    assert.ok(
      handle.getDiagnostics().lastTickDurationMs < debounceMs,
      `startup tick should stay cheaper than debounce (${debounceMs}ms), got ${handle.getDiagnostics().lastTickDurationMs}ms`
    );

    fireWatch(watchHandler, tmp, 'a.jsonl');
    await waitForCondition(() => updates.length === 2);
    const fastDurationMs = handle.getDiagnostics().lastTickDurationMs;

    const callsBefore = calls.length;
    const armedAt = performance.now();
    fireWatch(watchHandler, tmp, 'b.jsonl');
    await waitForCondition(() => calls.length > callsBefore);
    assertDebounceOnlyArm(calls[callsBefore].at - armedAt, debounceMs, fastDurationMs);
    assert.ok(calls[callsBefore].args.includes('--today'));
    assert.ok(!updates.includes('coalesced'));
  });
});

test('a slow watch tick forces leftover idle on the next event', async () => {
  await withLiveCollector({ watchDebounceMs: 10, spawnDelayMs: 5 }, async (ctx) => {
    const { calls, updates, handle, watchHandler, tmp, setSpawnDelayMs } = ctx;
    setSpawnDelayMs(80);
    fireWatch(watchHandler, tmp);
    await waitForCondition(() => updates.length === 2);
    const slowDurationMs = handle.getDiagnostics().lastTickDurationMs;
    assert.ok(slowDurationMs >= 70, `slow tick should outlast debounce, got ${slowDurationMs}ms`);

    const callsBefore = calls.length;
    const afterSlow = performance.now();
    fireWatch(watchHandler, tmp, 'next.jsonl');
    await waitForCondition(() => calls.length > callsBefore);
    const idleGapMs = calls[callsBefore].at - afterSlow;
    assert.ok(
      idleGapMs >= slowDurationMs * 0.7,
      `expected duty-cycle idle after a ${slowDurationMs}ms tick, idle gap was ${idleGapMs}ms`
    );
    assert.ok(
      idleGapMs < slowDurationMs + 80,
      `duty-cycle wait should not overshoot the last tick, idle gap was ${idleGapMs}ms`
    );
  });
});

test('after leftover idle elapses the next watch event is debounce-only again', async () => {
  await withLiveCollector({ watchDebounceMs: 25, spawnDelayMs: 5 }, async (ctx) => {
    const { calls, updates, handle, watchHandler, tmp, setSpawnDelayMs } = ctx;
    setSpawnDelayMs(70);
    fireWatch(watchHandler, tmp);
    await waitForCondition(() => updates.length === 2);
    const slowDurationMs = handle.getDiagnostics().lastTickDurationMs;
    assert.ok(slowDurationMs >= 60);

    setSpawnDelayMs(0);
    await new Promise((resolve) => setTimeout(resolve, slowDurationMs + 20));
    const callsBefore = calls.length;
    const armedAt = performance.now();
    fireWatch(watchHandler, tmp, 'after-idle.jsonl');
    await waitForCondition(() => calls.length > callsBefore);
    const idleGapMs = calls[callsBefore].at - armedAt;
    const debounceMs = 25;
    assert.ok(
      idleGapMs >= debounceMs * 0.4,
      `debounce must still apply after leftover expires, idle gap was ${idleGapMs}ms`
    );
    assert.ok(
      idleGapMs < debounceMs + 80,
      `expired leftover must not keep forcing lastDuration, idle gap was ${idleGapMs}ms after a ${slowDurationMs}ms tick`
    );
  });
});

test('a watch event during a slow in-flight tick re-arms without coalescing', async () => {
  await withLiveCollector({ watchDebounceMs: 10, spawnDelayMs: 5 }, async (ctx) => {
    const { calls, updates, handle, watchHandler, tmp, setSpawnDelayMs } = ctx;
    setSpawnDelayMs(120);
    fireWatch(watchHandler, tmp, 'first.jsonl');
    await waitForCondition(() => calls.length === 4);
    fireWatch(watchHandler, tmp, 'second.jsonl');

    await waitForCondition(() => updates.length === 2);
    const firstWatchDurationMs = handle.getDiagnostics().lastTickDurationMs;
    await waitForCondition(() => updates.length === 3);
    assert.equal(calls.length, 5);
    assert.ok(!updates.includes('coalesced'), `unexpected coalesced tick in: ${updates.join(', ')}`);
    assert.ok(calls[4].args.includes('--today'));
    assert.equal(calls[4].args[calls[4].args.indexOf('--client') + 1], 'claude');

    const spawnGapMs = calls[4].at - calls[3].at;
    assert.ok(
      spawnGapMs >= firstWatchDurationMs * 1.5,
      `re-arm after a slow in-flight tick must still pay leftover idle, spawn gap was ${spawnGapMs}ms after a ${firstWatchDurationMs}ms tick`
    );
  });
});

test('events during leftover idle collapse into one later scan', async () => {
  await withLiveCollector({ watchDebounceMs: 10, spawnDelayMs: 5 }, async (ctx) => {
    const { calls, updates, handle, watchHandler, tmp, setSpawnDelayMs } = ctx;
    setSpawnDelayMs(80);
    fireWatch(watchHandler, tmp);
    await waitForCondition(() => updates.length === 2);
    const afterSlow = performance.now();
    const callsBefore = calls.length;

    fireWatch(watchHandler, tmp, 'one.jsonl');
    await new Promise((resolve) => setTimeout(resolve, 15));
    fireWatch(watchHandler, tmp, 'two.jsonl');
    await waitForCondition(() => updates.length === 3);

    assert.equal(calls.length, callsBefore + 1, 'leftover re-arms must not start a scan per event');
    const idleGapMs = calls[callsBefore].at - afterSlow;
    const slowDurationMs = handle.getDiagnostics().lastTickDurationMs;
    assert.ok(idleGapMs >= 50, `collapsed events still wait leftover idle, gap was ${idleGapMs}ms`);
    assert.ok(!updates.includes('coalesced'));
    assert.ok(slowDurationMs >= 70);
  });
});

test('a failed slow watch tick still applies leftover idle', async () => {
  await withLiveCollector({ watchDebounceMs: 10, spawnDelayMs: 5 }, async (ctx) => {
    const { calls, errors, handle, watchHandler, tmp, setSpawnDelayMs, failNextSpawn } = ctx;
    setSpawnDelayMs(80);
    failNextSpawn();
    fireWatch(watchHandler, tmp);
    await waitForCondition(() => errors.length === 1);
    const diagnostics = handle.getDiagnostics();
    assert.equal(diagnostics.lastFailureCode, 'tick-failed');
    assert.ok(diagnostics.lastTickDurationMs >= 70, `failed tick duration was ${diagnostics.lastTickDurationMs}ms`);

    setSpawnDelayMs(0);
    const callsBefore = calls.length;
    const afterFail = performance.now();
    fireWatch(watchHandler, tmp, 'recover.jsonl');
    await waitForCondition(() => calls.length > callsBefore);
    const idleGapMs = calls[callsBefore].at - afterFail;
    assert.ok(
      idleGapMs >= diagnostics.lastTickDurationMs * 0.7,
      `failed slow ticks still force leftover idle, gap was ${idleGapMs}ms`
    );
  });
});

test('a manual tick is not held behind leftover watch idle', async () => {
  await withLiveCollector({ watchDebounceMs: 10, spawnDelayMs: 5 }, async (ctx) => {
    const { calls, updates, handle, watchHandler, tmp, setSpawnDelayMs } = ctx;
    setSpawnDelayMs(80);
    fireWatch(watchHandler, tmp);
    await waitForCondition(() => updates.length === 2);

    setSpawnDelayMs(0);
    const callsBefore = calls.length;
    const started = performance.now();
    const manual = handle.tick('manual');
    await waitForCondition(() => calls.length > callsBefore);
    const startGapMs = calls[callsBefore].at - started;
    await manual;
    assert.ok(
      startGapMs < 40,
      `manual refresh must not inherit watch leftover idle, start gap was ${startGapMs}ms`
    );
    assert.ok(updates.includes('manual'));
  });
});

test('stop during leftover idle prevents the armed watch tick', async () => {
  await withLiveCollector({ watchDebounceMs: 10, spawnDelayMs: 5 }, async (ctx) => {
    const { calls, updates, handle, watchHandler, tmp, setSpawnDelayMs } = ctx;
    setSpawnDelayMs(70);
    fireWatch(watchHandler, tmp);
    await waitForCondition(() => updates.length === 2);

    const callsBefore = calls.length;
    fireWatch(watchHandler, tmp, 'late.jsonl');
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(calls.length, callsBefore, 'a stopped collector cannot flush leftover idle into a scan');
  });
});
