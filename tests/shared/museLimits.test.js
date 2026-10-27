'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const test = require('node:test');
const { existingMuseCli, runMuseUsageCli, parseMuseUsage, fetchMuseLimits } = require('../../src/shared/providers/muse/limits');
const { LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
const { limitProviderForClient, limitProvidersForDetectedClients } = require('../../src/shared/limits/providers');

// Schema-v1 examples. The live-shaped case below mirrors a populated
// Muse Code 1.4.13 response verified locally (allowance with asOfMs/source,
// no windowDurationMins); edge cases remain constructed from that schema.
const reset = Date.UTC(2026, 9, 26);
const payload = (allowance) => JSON.stringify({ schemaVersion: 1, allowance });
const usage = payload({
  tier: 'Power Usage',
  window: { usedPercent: 25, windowDurationMins: 300, resetsAtMs: reset },
  weekly: { usedPercent: 80, resetsAtMs: reset + 6 * 86400000 }
});

function cli(output = usage, error = null, stderr = '') {
  return (_command, _args, _options, callback) => {
    process.nextTick(() => callback(error, output, stderr));
    return { stdin: { end() {} } };
  };
}

const deps = { env: { PATH: '/bin' }, platform: 'linux', existsSync: (file) => file === '/bin/muse', execFile: cli() };

test('Muse is registered as the limits side of its existing tracked client', async () => {
  assert.equal(limitProviderForClient('muse'), 'muse');
  assert.deepEqual(limitProvidersForDetectedClients({ clients: { muse: { source: { state: 'detected' } } } }), ['muse']);
  assert.equal((await LIMIT_PROVIDER_FETCHERS.muse({}, deps)).status, 'ok');
});

test('Muse discovers PATH before the launcher fallback without resolving shell commands', () => {
  assert.equal(existingMuseCli({ PATH: '/first:/second', HOME: '/home/user' }, 'linux', { existsSync: () => true }), '/first/muse');
  assert.equal(existingMuseCli({ HOME: '/home/user' }, 'darwin', { existsSync: (p) => p === '/home/user/.local/bin/muse' }), '/home/user/.local/bin/muse');
  assert.equal(existingMuseCli({ Path: 'C:\\Tools', USERPROFILE: 'C:\\Users\\me' }, 'win32', { existsSync: () => true }), 'C:\\Tools\\muse.exe');
  assert.equal(existingMuseCli({ PATH: 'relative' }, 'win32', { existsSync: () => true }), null);
});

test('Muse resolves CLI paths deterministically for the requested platform regardless of host', () => {
  // POSIX requested platform: '/' joins and ':' PATH splitting on any host.
  assert.equal(existingMuseCli({ PATH: '/first:/second', HOME: '/home/user' }, 'linux', { existsSync: (p) => p === '/second/muse' }), '/second/muse');
  assert.equal(existingMuseCli({ HOME: '/home/user' }, 'linux', { existsSync: (p) => p === '/home/user/.local/bin/muse' }), '/home/user/.local/bin/muse');
  // win32 requested platform: '\\' joins, ';' PATH splitting (drive ':' kept), .exe name on any host.
  assert.equal(existingMuseCli({ Path: 'C:\\first;C:\\second' }, 'win32', { existsSync: (p) => p === 'C:\\second\\muse.exe' }), 'C:\\second\\muse.exe');
  assert.equal(existingMuseCli({ USERPROFILE: 'C:\\Users\\me' }, 'win32', { existsSync: (p) => p === 'C:\\Users\\me\\.local\\bin\\muse.exe' }), 'C:\\Users\\me\\.local\\bin\\muse.exe');
});

test('Muse maps session and weekly percentages and millisecond reset times', async () => {
  const row = await fetchMuseLimits({}, deps);
  assert.equal(row.provider, 'muse');
  assert.equal(row.source, 'cli');
  assert.equal(row.planLabel, 'Power Usage');
  assert.equal(row.accountKey, '');
  assert.equal(row.windows[0].usedPercent, 25);
  assert.equal(row.windows[0].remainingPercent, 75);
  assert.equal(row.windows[0].windowMinutes, 300);
  assert.equal(row.windows[0].resetsAt, new Date(reset).toISOString());
  assert.equal(row.windows[1].kind, 'weekly');
  assert.equal(row.windows[1].remainingPercent, 20);
});

test('Muse parses the live 1.4.13 shape without windowDurationMins and uses its observation time', async () => {
  const live = JSON.stringify({
    schemaVersion: 1,
    allowance: {
      tier: 'Muse Code High Usage',
      window: { usedPercent: 2, resetsAtMs: reset },
      weekly: { usedPercent: 4, resetsAtMs: reset + 6 * 86400000 },
      asOfMs: reset - 60000,
      source: 'mint'
    },
    reason: null,
    hint: null
  });
  const row = await fetchMuseLimits({}, { ...deps, execFile: cli(live), now: () => reset });
  assert.equal(row.status, 'ok');
  assert.equal(row.planLabel, 'Muse Code High Usage');
  assert.equal(row.windows[0].usedPercent, 2);
  assert.equal(row.windows[0].windowMinutes, null);
  assert.equal(row.windows[1].usedPercent, 4);
  assert.equal(row.updatedAt, new Date(reset - 60000).toISOString());
  // A future server clock must not hide staleness behind a future stamp.
  const skewed = await fetchMuseLimits({}, {
    ...deps,
    execFile: cli(JSON.stringify({ schemaVersion: 1, allowance: { window: { usedPercent: 2 }, asOfMs: reset + 86400000 } })),
    now: () => reset
  });
  assert.equal(skewed.updatedAt, new Date(reset).toISOString());
});

test('Muse preserves actual zero and exhausted readings, and accepts a missing weekly pool', () => {
  for (const usedPercent of [0, 100]) {
    assert.equal(parseMuseUsage(payload({ window: { usedPercent }, weekly: null })).windows[0].usedPercent, usedPercent);
  }
});

test('Muse never turns absent allowance, API-key billing or malformed data into full quota', async () => {
  for (const reason of ['server_sent_no_usage', 'api_key', 'no_allowance']) {
    const output = JSON.stringify({ schemaVersion: 1, allowance: null, reason });
    const row = await fetchMuseLimits({}, { ...deps, execFile: cli(output) });
    assert.equal(row.status, 'unavailable');
    assert.deepEqual(row.windows, []);
  }
  for (const output of ['{}', 'not JSON', '{"schemaVersion":2,"allowance":null}', payload([]), payload({}),
    payload({ window: { usedPercent: null } }), payload({ window: { usedPercent: '0' } }),
    payload({ window: { usedPercent: -1 } }), payload({ window: { usedPercent: 101 } }),
    payload({ window: { usedPercent: 10, resetsAtMs: 'tomorrow' } }),
    payload({ window: { usedPercent: 10 }, asOfMs: 'now' }),
    payload({ window: { usedPercent: 10, windowDurationMins: 0 } })]) {
    const row = await fetchMuseLimits({}, { ...deps, execFile: cli(output) });
    assert.equal(row.status, 'unavailable', output);
    assert.deepEqual(row.windows, []);
  }
});

test('Muse distinguishes absent CLI, sign-in failure and process failure', async () => {
  assert.equal((await fetchMuseLimits({}, { ...deps, existsSync: () => false })).status, 'notConfigured');
  const failure = new Error('failed');
  assert.equal((await fetchMuseLimits({}, { ...deps, execFile: cli('', failure, 'not logged in: run `muse login` first') })).status, 'unauthorized');
  assert.equal((await fetchMuseLimits({}, { ...deps, execFile: cli(usage, failure, 'unknown subcommand usage') })).status, 'unavailable');
  assert.equal((await fetchMuseLimits({}, { ...deps, execFile: cli('', Object.assign(new Error(), { code: 'ENOENT' })) })).status, 'notConfigured');
});

test('Muse polls only usage JSON with closed stdin, bounded output and auto-update disabled', async () => {
  let ended = false;
  await runMuseUsageCli('/bin/muse', {
    env: { PATH: '/bin', MUSE_NO_AUTO_UPDATE: '0' },
    execFile(command, args, options, callback) {
      assert.equal(command, '/bin/muse');
      assert.deepEqual(args, ['usage', '--json']);
      assert.equal(options.env.MUSE_NO_AUTO_UPDATE, '1');
      assert.equal(options.timeout, 15000);
      assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.maxBuffer, 256 * 1024);
      assert.notEqual(options.shell, true);
      process.nextTick(() => callback(null, usage, ''));
      return { stdin: { end() { ended = true; } } };
    }
  });
  assert.equal(ended, true);
});

function realChild(script) {
  return (_command, _args, options, callback) => execFile(process.execPath, ['-e', script], options, callback);
}

test('Muse kills a hung probe on timeout and bounds noisy output', async () => {
  await assert.rejects(runMuseUsageCli('fixture', { museCliTimeoutMs: 50, execFile: realChild('setInterval(() => {}, 1000)') }), { killed: true });
  await assert.rejects(runMuseUsageCli('fixture', { execFile: realChild('process.stdout.write("x".repeat(300000))') }), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
});

test('Muse propagates collector cancellation instead of returning a stale provider row', async () => {
  const controller = new AbortController();
  const pending = fetchMuseLimits({}, { ...deps, signal: controller.signal, execFile: realChild('setInterval(() => {}, 1000)') });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('Muse does not launch an already-cancelled probe and preserves its reason', async () => {
  const controller = new AbortController();
  const reason = new Error('collector replaced');
  controller.abort(reason);
  let launched = false;
  await assert.rejects(runMuseUsageCli('fixture', {
    signal: controller.signal,
    execFile() { launched = true; }
  }), (error) => error === reason);
  assert.equal(launched, false);
});

test('Muse terminates a SIGTERM-ignoring probe on timeout, overflow and cancellation', async (t) => {
  for (const reason of ['timeout', 'overflow', 'cancellation']) {
    await t.test(reason, { timeout: 10000 }, async (t) => {
      const controller = new AbortController();
      let child;
      let ready;
      let closed;
      const pending = runMuseUsageCli('fixture', {
        // Readiness below proves the handler was installed before cancellation
        // or output overflow. The timeout case must also reach that handshake.
        museCliTimeoutMs: 2000,
        signal: controller.signal,
        execFile(_command, _args, options, callback) {
          child = execFile(process.execPath, ['-e', `
            process.on('SIGTERM', () => {});
            process.stdout.write('ready\\n');
            ${reason === 'overflow' ? "setImmediate(() => process.stdout.write('x'.repeat(300000)));" : ''}
            setInterval(() => {}, 1000);
          `], options, callback);
          ready = new Promise((resolve) => child.stdout.once('data', resolve));
          closed = new Promise((resolve) => child.once('close', resolve));
          return child;
        }
      });
      // Attach the rejection handler before awaiting readiness: output overflow
      // can close the child before this continuation runs on a busy runner.
      const rejected = assert.rejects(pending, reason === 'cancellation'
        ? { name: 'AbortError' }
        : reason === 'overflow' ? { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } : { killed: true });
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      });
      assert.match(String(await ready), /^ready\n/);
      if (reason === 'cancellation') controller.abort();
      await rejected;
      await closed;
      if (process.platform !== 'win32') assert.equal(child.signalCode, 'SIGKILL');
    });
  }
});
