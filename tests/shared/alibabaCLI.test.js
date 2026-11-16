'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchAlibabaLimits, alibabaVariantConfig } = require('../../src/shared/providers/alibaba/limits');
const { existingBailianCli, cliEnvironment } = require('../../src/shared/providers/alibaba/cli');

const now = Date.parse('2026-11-16T00:00:00Z');
const end = now + 86400000;
function seat(id, extra = {}) {
  return { SeatId: id, Status: 'NORMAL', StartTime: now - 86400000, EndTime: end,
    EquityList: [{ EquityType: 'CREDITS', CycleStartTime: now - 3600000,
      CycleEndTime: end, CycleTotalValue: 100, CycleSurplusValue: 30 }], ...extra };
}
function page(items, total = items.length, pageNo = 1) {
  return { Success: true, Data: { Items: items, Total: total, PageNo: pageNo, PageSize: 10 } };
}
function cliDeps(respond) {
  const calls = [];
  return { env: { PATH: '/cli', HOME: '/home/test' }, now: () => now, platform: 'linux',
    existsSync: file => file === '/cli/bl', calls,
    execFile(command, args, options, callback) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = () => {};
      queueMicrotask(() => {
        try { callback(null, JSON.stringify(respond(args))); }
        catch (error) { callback(error, ''); }
      });
      return child;
    },
    fetch() { throw new Error('Unexpected cookie request'); }
  };
}

test('Alibaba Personal CLI works without a cookie and reads monthly usage in the selected region', async () => {
  for (const variant of ['cn-personal', 'intl-personal']) {
    const deps = cliDeps(() => ({ Success: true, Data: {
      per5HourPercentage: null, per1WeekPercentage: null,
      per1MonthPercentage: 0.25, per1MonthResetTime: end
    } }));
    const [row] = await fetchAlibabaLimits({ alibabaVariant: variant }, deps);
    assert.equal(row.status, 'ok');
    assert.equal(row.source, 'cli');
    assert.equal(row.region, variant);
    assert.equal(row.workspaceKind, 'personal');
    assert.equal(row.windows.length, 1);
    assert.equal(row.windows[0].kind, 'billing');
    assert.equal(row.windows[0].usedPercent, 25);
    assert.equal(row.windows[0].resetsAt, new Date(end).toISOString());
    assert.equal(row.accountKey, ''); // no synthetic identity from plan or CLI path
    assert.deepEqual(deps.calls[0].args, ['console', 'call', '--api',
      'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage', '--data', '{}', '--console-region',
      alibabaVariantConfig(variant).regionId, '--console-site',
      variant === 'cn-personal' ? 'domestic' : 'international', '--output', 'json']);
  }
});

test('Alibaba Team CLI paginates seats, excludes inactive seats and uses the selected gateway', async () => {
  for (const variant of ['cn', 'intl']) {
    const deps = cliDeps(args => args[3] === '1'
      ? page(Array.from({ length: 10 }, (_, i) => seat(String(i))), 11)
      : page([seat('inactive', { Status: 'DISABLED' })], 11, 2));
    const [row] = await fetchAlibabaLimits({ alibabaVariant: variant }, deps);
    assert.equal(row.status, 'ok');
    assert.equal(row.source, 'cli');
    assert.equal(row.windows[0].limit, 1000);
    assert.equal(row.windows[0].used, 700);
    assert.equal(row.windows[0].remaining, 300);
    assert.equal(row.windows[0].resetsAt, new Date(end).toISOString());
    assert.equal(deps.calls.length, 2);
    assert.deepEqual(deps.calls[1].args, ['token-plan', 'list-seats', '--page-no', '2', '--page-size', '10', '--output', 'json']);
    const host = variant === 'intl' ? 'https://dashscope-intl.aliyuncs.com' : 'https://dashscope.aliyuncs.com';
    assert.equal(deps.calls[0].options.env.DASHSCOPE_BASE_URL, host);
    assert.equal(deps.calls[0].options.env.BAILIAN_BASE_URL, host);
  }
});

test('Alibaba Team mixed credit cycles do not invent one reset; resource packs are excluded', async () => {
  const other = seat('b');
  other.EquityList[0].CycleEndTime = end + 1000;
  other.EquityList.push({ EquityType: 'RESOURCE_PACK', CycleTotalValue: 9999 });
  const [row] = await fetchAlibabaLimits({}, cliDeps(() => page([seat('a'), other])));
  assert.equal(row.status, 'ok');
  assert.equal(row.windows[0].limit, 200);
  assert.equal(row.windows[0].resetsAt, null);
});

test('Alibaba Team CLI accepts no active seats without falling back to Cookie', async () => {
  for (const items of [[], [seat('expired', { EndTime: now - 1 })],
    [seat('stopped', { Status: 'STOP' })], [seat('released', { Status: 'RELEASE' })],
    [seat('future', { StartTime: now + 1000 })]]) {
    for (const alibabaCookie of ['', 'a=b']) {
      const deps = cliDeps(() => page(items));
      const [row] = await fetchAlibabaLimits({ alibabaCookie }, deps);
      assert.equal(row.status, 'ok');
      assert.equal(row.source, 'cli');
      assert.deepEqual(row.windows, []);
      assert.equal(deps.calls.length, 1);
    }
  }
});

test('Alibaba Team CLI still rejects active seats with unusable credit quotas', async () => {
  for (const EquityList of [[], [{ EquityType: 'RESOURCE_PACK' }],
    [{ EquityType: 'CREDITS', CycleStartTime: now - 1000, CycleEndTime: end,
      CycleTotalValue: 0, CycleSurplusValue: 0 }]]) {
    const deps = cliDeps(() => page([seat('a', { EquityList })]));
    const webCalls = webFallback(deps);
    const [row] = await fetchAlibabaLimits({ alibabaCookie: 'a=b' }, deps);
    assert.equal(row.source, 'web');
    assert.equal(row.status, 'ok');
    assert.ok(webCalls() > 0);
  }
});

test('Alibaba Team empty CLI result clears previous quota and can recover in the real runtime', async () => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  for (const emptyItems of [[], [seat('expired', { EndTime: now - 1 })],
    [seat('stopped', { Status: 'STOP' })]]) {
    let items = [seat('a')];
    const deps = cliDeps(() => page(items));
    const runtime = createLimitsRuntime({ limitProviders: ['alibaba'] }, {
      autoStart: false, autoRetry: false, now: () => now,
      probeProvider: (_provider, options, context) => fetchAlibabaLimits(options, { ...deps, signal: context.signal })
    });
    try {
      await runtime.refresh({ provider: 'alibaba' }, 'credential-edit');
      assert.equal(runtime.getSnapshot().providers[0].windows[0].usedPercent, 70);
      items = emptyItems;
      await runtime.refresh({ provider: 'alibaba' }, 'credential-edit');
      const rows = runtime.getSnapshot().providers;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'ok');
      assert.equal(rows[0].source, 'cli');
      assert.deepEqual(rows[0].windows, []);
      items = [seat('a')];
      await runtime.refresh({ provider: 'alibaba' }, 'credential-edit');
      assert.equal(runtime.getSnapshot().providers[0].status, 'ok');
      assert.equal(runtime.getSnapshot().providers[0].windows[0].usedPercent, 70);
    } finally { runtime.stop(); }
  }
});

function webFallback(deps) {
  let calls = 0;
  deps.fetch = async url => {
    calls++;
    return { ok: true, status: 200, text: async () => String(url).includes('GetSubscriptionSummary')
      ? JSON.stringify({ Success: true, Data: { Uid: 123, TotalValue: 200, TotalSurplusValue: 50, TotalCount: 1 } }) : '{}' };
  };
  return () => calls;
}

test('Alibaba missing, failed and malformed CLI fall back to the existing cookie path', async () => {
  const badSeat = seat('bad');
  badSeat.EquityList[0].CycleSurplusValue = 101;
  const cases = [
    deps => { deps.existsSync = () => false; },
    deps => { deps.execFile = (_cmd, _args, _options, cb) => { queueMicrotask(() => cb(new Error('login expired'))); return {}; }; },
    () => {}
  ];
  for (const change of cases) {
    const deps = cliDeps(() => page([badSeat]));
    change(deps);
    const webCalls = webFallback(deps);
    const [row] = await fetchAlibabaLimits({ alibabaCookie: 'a=b' }, deps);
    assert.equal(row.status, 'ok');
    assert.equal(row.source, 'web');
    assert.equal(row.windows[0].used, 150);
    assert.ok(webCalls() > 0);
  }
});

test('Alibaba cookie save probes cannot be satisfied by a valid CLI login', async () => {
  const deps = cliDeps(() => page([seat('a')]));
  deps.probe = true;
  deps.fetch = async () => ({ ok: false, status: 401, text: async () => '{}' });
  const [row] = await fetchAlibabaLimits({ alibabaCookie: 'a=b' }, deps);
  assert.equal(row.status, 'unauthorized');
  assert.equal(deps.calls.length, 0);
});

test('Alibaba rejects malformed CLI percentages, error envelopes and empty usage', async () => {
  for (const payload of [
    { per1MonthPercentage: true }, { per1MonthPercentage: '0.2' },
    { per1MonthPercentage: -0.1 }, { per1MonthPercentage: 1.1 },
    { per1MonthPercentage: 0.2, per1MonthResetTime: 'tomorrow' },
    { Success: false, Data: { per1MonthPercentage: 0.2 } }, {}
  ]) {
    const [row] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, cliDeps(() => payload));
    assert.equal(row.status, 'unavailable', JSON.stringify(payload));
    assert.equal(row.windows.length, 0);
  }
});

test('Alibaba rejects incomplete pages and duplicate seats instead of publishing partial usage', async () => {
  for (const payload of [page([seat('a')], 2), page([seat('a'), seat('a')]),
    { ...page([seat('a')]), Success: false }]) {
    const [row] = await fetchAlibabaLimits({}, cliDeps(() => payload));
    assert.equal(row.status, 'unavailable');
    assert.equal(row.windows.length, 0);
  }
});

test('Bailian environment omits unrelated credentials and ignores ambient gateway overrides', () => {
  const env = { PATH: '/bin', HOME: '/home/test', HTTP_PROXY: 'http://proxy',
    ALIBABA_TOKEN_PLAN_COOKIE: 'secret=1', DASHSCOPE_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
    SSH_AUTH_SOCK: '/socket', DASHSCOPE_BASE_URL: 'https://wrong', BAILIAN_BASE_URL: 'https://wrong' };
  assert.deepEqual(cliEnvironment(env, alibabaVariantConfig('intl')), {
    PATH: '/bin', HOME: '/home/test', HTTP_PROXY: 'http://proxy',
    NO_UPDATE_NOTIFIER: '1', DO_NOT_TRACK: '1',
    DASHSCOPE_BASE_URL: 'https://dashscope-intl.aliyuncs.com', BAILIAN_BASE_URL: 'https://dashscope-intl.aliyuncs.com'
  });
  assert.equal(cliEnvironment(env, alibabaVariantConfig('cn-personal')).DASHSCOPE_BASE_URL, undefined);
});

test('Bailian quota environment disables updates and telemetry regardless of parent settings', () => {
  for (const variant of ['cn', 'intl', 'cn-personal', 'intl-personal']) {
    for (const inherited of [{}, { NO_UPDATE_NOTIFIER: '0', DO_NOT_TRACK: '0' },
      { NO_UPDATE_NOTIFIER: '1', DO_NOT_TRACK: '1' }]) {
      const before = { ...inherited };
      const env = cliEnvironment(inherited, alibabaVariantConfig(variant));
      assert.equal(env.NO_UPDATE_NOTIFIER, '1');
      assert.equal(env.DO_NOT_TRACK, '1');
      assert.deepEqual(inherited, before);
    }
  }
});

test('Bailian discovery supports native Windows executables and rejects relative PATH entries', () => {
  assert.equal(existingBailianCli({ Path: 'C:\\tools;relative' }, 'win32', { existsSync: p => p === 'C:\\tools\\bl.exe' }), 'C:\\tools\\bl.exe');
  assert.equal(existingBailianCli({ PATH: 'relative' }, 'linux', { existsSync: p => p === 'relative/bl' }), null);
});

test('Bailian child PATH keeps only absolute directories and cannot become an empty cwd lookup', async () => {
  for (const platform of ['linux', 'win32']) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const bin = platform === 'win32' ? 'C:\\cli' : '/cli';
    for (const inherited of [`.${paths.delimiter}${paths.delimiter}relative${paths.delimiter}${bin}${paths.delimiter}`, '.']) {
      const deps = cliDeps(() => ({ per1MonthPercentage: 0.2 }));
      deps.platform = platform;
      deps.env = { PATH: inherited, HOME: platform === 'win32' ? 'C:\\home' : '/home' };
      const fallback = paths.join(deps.env.HOME, '.local', 'bin');
      deps.existsSync = file => [bin, fallback].some(dir => file === paths.join(dir, platform === 'win32' ? 'bl.exe' : 'bl'));
      const [row] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, deps);
      assert.equal(row.status, 'ok');
      assert.equal(deps.calls[0].options.env.PATH, inherited === '.' ? fallback : bin);
    }
  }
});

test('Bailian env-node launch never executes a Node planted in the child working directory', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bailian-untrusted-path-'));
  try {
    const bin = path.join(dir, 'trusted-bin');
    const cwd = path.join(dir, 'child-cwd');
    const marker = path.join(dir, 'untrusted-node-ran');
    mkdirSync(bin);
    mkdirSync(cwd);
    symlinkSync(process.execPath, path.join(bin, 'node'));
    writeFileSync(path.join(bin, 'bl'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({per1MonthPercentage:0.2}));\n');
    chmodSync(path.join(bin, 'bl'), 0o755);
    writeFileSync(path.join(cwd, 'node'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nconsole.log(JSON.stringify({per1MonthPercentage:0.99}));\n`);
    chmodSync(path.join(cwd, 'node'), 0o755);
    const host = `
      const { fetchAlibabaLimits } = require(${JSON.stringify(require.resolve('../../src/shared/providers/alibaba/limits'))});
      fetchAlibabaLimits({ alibabaVariant: 'cn-personal' })
        .then(([row]) => console.log(JSON.stringify(row)))
        .catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const stdout = await new Promise((resolve, reject) => {
      require('node:child_process').execFile(process.execPath, ['-e', host], { env: {
        PATH: `.:relative-bin::${bin}:`, TMPDIR: cwd, TMP: cwd, TEMP: cwd
      } }, (error, output) => error ? reject(error) : resolve(output));
    });
    assert.equal(require('node:fs').existsSync(marker), false);
    const row = JSON.parse(stdout);
    assert.equal(row.status, 'ok');
    assert.equal(row.windows[0].usedPercent, 20);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Bailian fallback discovery makes its adjacent Node available without replacing the inherited PATH', async () => {
  const deps = cliDeps(() => ({ per1MonthPercentage: 0.2 }));
  deps.env = { PATH: '/usr/bin:/bin' };
  deps.existsSync = file => ['/opt/homebrew/bin/bl', '/opt/homebrew/bin/node'].includes(file);
  const [row] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, deps);
  assert.equal(row.status, 'ok');
  assert.equal(deps.calls[0].command, '/opt/homebrew/bin/bl');
  assert.equal(deps.calls[0].options.env.PATH, '/usr/bin:/bin:/opt/homebrew/bin');
});

test('Bailian fallback env-node entry executes with Node outside the inherited PATH', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bailian-fallback-node-'));
  try {
    const bin = path.join(dir, '.local', 'bin');
    const inherited = path.join(dir, 'limited-path');
    mkdirSync(bin, { recursive: true });
    mkdirSync(inherited);
    symlinkSync(process.execPath, path.join(bin, 'node'));
    writeFileSync(path.join(bin, 'bl'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({per1MonthPercentage:0.2}));\n');
    chmodSync(path.join(bin, 'bl'), 0o755);
    const [row] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, {
      env: { HOME: dir, PATH: inherited }
    });
    assert.equal(row.status, 'ok');
    assert.equal(row.source, 'cli');
    assert.equal(row.windows[0].usedPercent, 20);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Bailian subprocess executes JSON quota commands and stops on cancellation', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bailian-cli-'));
  const executable = path.join(dir, 'bl');
  try {
    writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({per1MonthPercentage: 0.4}));\n`);
    chmodSync(executable, 0o755);
    const deps = { env: { PATH: dir }, now: () => now };
    const [row] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, deps);
    assert.equal(row.source, 'cli');
    assert.equal(row.windows[0].usedPercent, 40);
    writeFileSync(executable, `#!${process.execPath}\nprocess.exit(3);\n`);
    const [signedOut] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, deps);
    assert.equal(signedOut.status, 'notConfigured');
    writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
    const controller = new AbortController();
    const promise = fetchAlibabaLimits({ alibabaVariant: 'cn-personal', alibabaCookie: 'a=b' },
      { ...deps, signal: controller.signal, fetch() { assert.fail('abort must not fall back'); } });
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(promise, { name: 'AbortError' }); }
    finally { clearTimeout(timer); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Bailian oversized output fails without publishing a plausible quota', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bailian-limit-'));
  try {
    const executable = path.join(dir, 'bl');
    writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({per1MonthPercentage: 0.4, padding: 'x'.repeat(70000)}));\n`);
    chmodSync(executable, 0o755);
    const [row] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, { env: { PATH: dir } });
    assert.equal(row.status, 'unavailable');
    assert.equal(row.windows.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Bailian timeout hard-stops the subprocess before cookie fallback starts', { skip: process.platform === 'win32' }, async () => {
  const { execFile } = require('node:child_process');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bailian-timeout-'));
  let childPid;
  try {
    const executable = path.join(dir, 'bl');
    writeFileSync(executable, `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`);
    chmodSync(executable, 0o755);
    const deps = { env: { PATH: dir }, execFile(command, args, options, callback) {
      assert.ok(options.timeout > 0 && options.timeout <= 15000);
      assert.equal(options.killSignal, 'SIGKILL');
      const child = execFile(command, args, { ...options, timeout: 250 }, callback);
      childPid = child.pid;
      return child;
    } };
    const webCalls = webFallback(deps);
    const fetch = deps.fetch;
    deps.fetch = (...args) => {
      assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
      return fetch(...args);
    };
    const [row] = await fetchAlibabaLimits({ alibabaCookie: 'a=b' }, deps);
    assert.equal(row.source, 'web');
    assert.equal(row.status, 'ok');
    assert.ok(webCalls() > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Alibaba source switches retire previous Cookie and CLI identities in the real limits runtime', async () => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const deps = cliDeps(() => page([seat('a')]));
  const runtime = createLimitsRuntime({ alibabaCookie: 'a=b', limitProviders: ['alibaba'], previousLimits: { providers: [{
    provider: 'alibaba', source: 'web', accountKey: 'old-cookie-account', status: 'ok',
    region: 'cn', updatedAt: new Date(now - 1000).toISOString(), windows: [{ kind: 'billing', usedPercent: 90 }]
  }] } }, { autoStart: false, autoRetry: false, now: () => now,
    probeProvider: (_provider, options, context) => fetchAlibabaLimits(options, { ...deps, signal: context.signal }) });
  try {
    const { limitAccountRefreshScope } = require('../../src/shared/limits/accounts');
    const scope = limitAccountRefreshScope('alibaba', { accountKey: 'old-cookie-account' });
    assert.deepEqual(scope, { provider: 'alibaba' });
    await runtime.refresh(scope, 'manual');
    const rows = runtime.getSnapshot().providers;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'cli');
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].windows[0].usedPercent, 70);
    deps.existsSync = () => false;
    webFallback(deps);
    await runtime.refresh({ provider: 'alibaba' }, 'credential-edit');
    const fallbackRows = runtime.getSnapshot().providers;
    assert.equal(fallbackRows.length, 1);
    assert.equal(fallbackRows[0].source, 'web');
    assert.equal(fallbackRows[0].status, 'ok');
    assert.equal(fallbackRows[0].windows[0].usedPercent, 75);
  } finally { runtime.stop(); }
});

test('Alibaba CLI recovery replaces anonymous failures and empty Cookie subscriptions', async () => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  for (const previous of [
    { source: 'cli', status: 'unavailable' },
    { source: 'web', status: 'ok' }
  ]) {
    const deps = cliDeps(() => page([seat('a')]));
    const runtime = createLimitsRuntime({ limitProviders: ['alibaba'], previousLimits: { providers: [{
      provider: 'alibaba', ...previous, region: 'cn', updatedAt: new Date(now - 1000).toISOString(), windows: []
    }] } }, { autoStart: false, autoRetry: false, now: () => now,
      probeProvider: (_provider, options, context) => fetchAlibabaLimits(options, { ...deps, signal: context.signal }) });
    try {
      await runtime.refresh({ provider: 'alibaba' }, 'manual');
      const rows = runtime.getSnapshot().providers;
      assert.equal(rows.length, 1, JSON.stringify(previous));
      assert.equal(rows[0].source, 'cli');
      assert.equal(rows[0].status, 'ok');
      assert.equal(rows[0].windows[0].usedPercent, 70);
    } finally { runtime.stop(); }
  }
});


test('Alibaba CLI authentication errors stay distinct from unavailable quota', async () => {
  for (const code of [3, 6]) {
    const deps = cliDeps(() => { throw Object.assign(new Error('CLI failed'), { code }); });
    const [row] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, deps);
    assert.equal(row.status, code === 3 ? 'notConfigured' : 'unavailable');
  }
  const [row] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' },
    cliDeps(() => ({ Success: false, Code: 'Login.NotLogined', Message: 'login required' })));
  assert.equal(row.status, 'unauthorized');
});

test('Bailian Windows npm discovery runs the fixed package entry with Node, without a shell', async () => {
  const deps = cliDeps(() => ({ per1MonthPercentage: 0.2 }));
  deps.platform = 'win32';
  deps.env = { PATH: 'C:\\npm;C:\\node', BAILIAN_CONFIG_DIR: 'C:\\profiles\\bailian' };
  const entry = 'C:\\npm\\node_modules\\bailian-cli\\dist\\bailian.mjs';
  deps.existsSync = file => ['C:\\npm\\bl.cmd', entry, 'C:\\node\\node.exe'].includes(file);
  const [row] = await fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, deps);
  assert.equal(row.status, 'ok');
  assert.equal(row.source, 'cli');
  assert.equal(deps.calls[0].command, 'C:\\node\\node.exe');
  assert.equal(deps.calls[0].args[0], entry);
  assert.equal(deps.calls[0].options.shell, undefined);
  assert.equal(deps.calls[0].options.env.BAILIAN_CONFIG_DIR, 'C:\\profiles\\bailian');
});

test('Bailian config directory survives credential isolation', () => {
  const env = cliEnvironment({ BAILIAN_CONFIG_DIR: '/custom/config', DASHSCOPE_API_KEY: 'secret',
    BAILIAN_ACCESS_KEY_SECRET: 'secret' }, alibabaVariantConfig('cn-personal'));
  assert.equal(env.BAILIAN_CONFIG_DIR, '/custom/config');
  assert.equal(env.DASHSCOPE_API_KEY, undefined);
  assert.equal(env.BAILIAN_ACCESS_KEY_SECRET, undefined);
});

test('Bailian relative config directory keeps the saved login when the child changes directory', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bailian-relative-config-'));
  try {
    const config = path.join(dir, 'saved profile');
    mkdirSync(config);
    writeFileSync(path.join(config, 'config.json'), JSON.stringify({ profile: 'fixture' }));
    writeFileSync(path.join(config, 'credentials.json'), JSON.stringify({ login: 'synthetic' }));
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      assert.equal(process.env.NO_UPDATE_NOTIFIER, '1');
      assert.equal(process.env.DO_NOT_TRACK, '1');
      assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(require('node:os').tmpdir()));
      assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.BAILIAN_CONFIG_DIR, 'config.json'))).profile, 'fixture');
      assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.BAILIAN_CONFIG_DIR, 'credentials.json'))).login, 'synthetic');
      console.log(JSON.stringify({ per1MonthPercentage: 0.35 }));
    `;
    if (process.platform === 'win32') {
      const dist = path.join(dir, 'node_modules', 'bailian-cli', 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dir, 'bl.cmd'), '@echo off\r\nexit /b 99\r\n');
      writeFileSync(path.join(dist, 'bailian.mjs'), `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n${script}`);
    } else {
      const executable = path.join(dir, 'bl');
      writeFileSync(executable, `#!${process.execPath}\n${script}`);
      chmodSync(executable, 0o755);
    }
    // Run the host in an isolated working directory so the configured path is
    // genuinely relative, without changing this test process's global cwd.
    const host = `
      const { fetchAlibabaLimits } = require(${JSON.stringify(require.resolve('../../src/shared/providers/alibaba/limits'))});
      fetchAlibabaLimits({ alibabaVariant: 'cn-personal' }, { noteLimitFailure(error) { throw error; } })
        .then(([row]) => console.log(JSON.stringify(row)))
        .catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const stdout = await new Promise((resolve, reject) => {
      require('node:child_process').execFile(process.execPath, ['-e', host], { cwd: dir, env: {
        PATH: [dir, path.dirname(process.execPath)].join(path.delimiter),
        BAILIAN_CONFIG_DIR: 'saved profile', SystemRoot: process.env.SystemRoot,
        NO_UPDATE_NOTIFIER: '0', DO_NOT_TRACK: '0'
      } }, (error, output) => error ? reject(error) : resolve(output));
    });
    const row = JSON.parse(stdout);
    assert.equal(row.source, 'cli');
    assert.equal(row.status, 'ok');
    assert.equal(row.windows[0].usedPercent, 35);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Alibaba source replacement keeps old named quota if the new account was cleared during refresh', async () => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let complete;
  const result = new Promise(resolve => { complete = resolve; });
  const deps = cliDeps(() => ({ Uid: 123, per1MonthPercentage: 0.2 }));
  const { hashKey } = require('../../src/shared/hashKey');
  const runtime = createLimitsRuntime({ alibabaVariant: 'cn-personal', limitProviders: ['alibaba'],
    previousLimits: { providers: [{ provider: 'alibaba', source: 'web', accountKey: 'old', status: 'ok',
      updatedAt: new Date(now).toISOString(), windows: [{ kind: 'billing', usedPercent: 65 }] }] }
  }, { autoStart: false, autoRetry: false, now: () => now,
    probeProvider: async (_provider, options, context) => {
      ready(); await result;
      return fetchAlibabaLimits(options, { ...deps, signal: context.signal });
    } });
  try {
    const pending = runtime.refresh({ provider: 'alibaba' }, 'manual');
    await started;
    runtime.clear({ provider: 'alibaba', accountKey: hashKey('alibaba', '123') });
    complete(); await pending;
    const rows = runtime.getSnapshot().providers;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].accountKey, 'old');
    assert.equal(rows[0].status, 'unavailable');
    assert.equal(rows[0].windows[0].usedPercent, 65);
  } finally { runtime.stop(); }
});


test('Windows npm Bailian entry executes natively with a custom config directory', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bailian npm & quota-'));
  try {
    const dist = path.join(dir, 'node_modules', 'bailian-cli', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dir, 'bl.cmd'), '@echo off\r\nexit /b 99\r\n');
    writeFileSync(path.join(dist, 'bailian.mjs'), `
      import assert from 'node:assert/strict';
      assert.equal(process.env.BAILIAN_CONFIG_DIR, ${JSON.stringify(path.join(dir, 'custom config'))});
      assert.equal(process.env.DASHSCOPE_API_KEY, undefined);
      assert.ok(process.argv.includes('international'));
      console.log(JSON.stringify({per1MonthPercentage:0.35}));
    `);
    const [row] = await fetchAlibabaLimits({ alibabaVariant: 'intl-personal' }, { env: {
      PATH: [dir, path.dirname(process.execPath)].join(path.delimiter),
      BAILIAN_CONFIG_DIR: path.join(dir, 'custom config'), DASHSCOPE_API_KEY: 'must-not-pass',
      SystemRoot: process.env.SystemRoot
    } });
    assert.equal(row.status, 'ok');
    assert.equal(row.source, 'cli');
    assert.equal(row.windows[0].usedPercent, 35);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
