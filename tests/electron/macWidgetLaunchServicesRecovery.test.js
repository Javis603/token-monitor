'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MARKER_FILE_NAME,
  createMacWidgetLaunchServicesRecovery
} = require('../../src/electron/macWidgetLaunchServicesRecovery');

const CONFIG = Object.freeze({
  schemaVersion: 1,
  appGroup: 'TEAM.tokenmonitor',
  urlScheme: 'token-monitor',
  widgetKind: 'com.tokenmonitor.dashboard',
  widgetUIVersion: 6,
  widgetSchemaVersion: 6,
  gitRevision: 'abc123',
  packageVersion: '0.43.0',
  marketingVersion: '0.43.0',
  bundleVersion: '430'
});

const REVALIDATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-ls-recovery-'));
  const appPath = path.join(root, options.appName || 'Token Monitor.app');
  const contentsPath = path.join(appPath, 'Contents');
  const resourcesPath = path.join(contentsPath, 'Resources');
  const appexPath = path.join(contentsPath, 'PlugIns', 'TokenMonitorWidget.appex');
  const helperPath = path.join(resourcesPath, 'TokenMonitorWidgetReloader');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(resourcesPath, { recursive: true });
  if (options.appex !== false) fs.mkdirSync(appexPath, { recursive: true });
  if (options.helper !== false) fs.writeFileSync(helperPath, 'test');
  if (options.config !== false) {
    const config = options.config || CONFIG;
    fs.writeFileSync(
      path.join(resourcesPath, 'token-monitor-widget.json'),
      `${JSON.stringify(config)}\n`
    );
  }
  return {
    appPath,
    appexPath,
    resourcesPath,
    root,
    userDataPath,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

function successfulExec(calls = []) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, '', '');
    return { kill() {} };
  };
}

function run(recover, setup, overrides = {}) {
  return recover({
    platform: 'darwin',
    isPackaged: true,
    resourcesPath: setup.resourcesPath,
    userDataPath: setup.userDataPath,
    ...overrides
  });
}

test('skips unsupported and unpackaged processes before filesystem access', async () => {
  let fsCalls = 0;
  const fsApi = new Proxy({}, {
    get() {
      fsCalls += 1;
      throw new Error('filesystem should not be read');
    }
  });
  let launches = 0;

  const unsupported = createMacWidgetLaunchServicesRecovery({
    fs: fsApi,
    execFile: () => { launches += 1; }
  });
  assert.deepEqual(await unsupported({ platform: 'linux', isPackaged: true }), {
    status: 'skipped',
    reason: 'unsupported-platform'
  });

  const unsupportedOs = createMacWidgetLaunchServicesRecovery({
    fs: fsApi,
    execFile: () => { launches += 1; }
  });
  assert.deepEqual(await unsupportedOs({
    platform: 'darwin',
    runtimeSupported: false,
    isPackaged: true
  }), {
    status: 'skipped',
    reason: 'unsupported-os'
  });

  const unpackaged = createMacWidgetLaunchServicesRecovery({
    fs: fsApi,
    execFile: () => { launches += 1; }
  });
  assert.deepEqual(await unpackaged({ platform: 'darwin', isPackaged: false }), {
    status: 'skipped',
    reason: 'unpackaged'
  });
  assert.equal(fsCalls, 0);
  assert.equal(launches, 0);
});

test('missing packaged Widget artifacts do not launch or create marker state', async () => {
  for (const missing of ['config', 'appex', 'helper']) {
    const setup = fixture({ [missing]: false });
    try {
      let launches = 0;
      const recover = createMacWidgetLaunchServicesRecovery({
        execFile: () => { launches += 1; }
      });
      assert.deepEqual(await run(recover, setup), {
        status: 'skipped',
        reason: 'artifacts-missing'
      });
      assert.equal(launches, 0);
      assert.equal(fs.existsSync(setup.userDataPath), false);
    } finally {
      setup.cleanup();
    }
  }
});

test('symlinked packaged Widget artifacts never launch or create marker state', async () => {
  for (const artifact of ['host', 'appex', 'helper']) {
    const setup = fixture();
    try {
      const target = artifact === 'host'
        ? setup.appPath
        : artifact === 'appex'
          ? setup.appexPath
          : path.join(setup.resourcesPath, 'TokenMonitorWidgetReloader');
      const realTarget = `${target}.real`;
      fs.renameSync(target, realTarget);
      const linkType = artifact === 'helper'
        ? 'file'
        : process.platform === 'win32'
          ? 'junction'
          : 'dir';
      fs.symlinkSync(realTarget, target, linkType);
      let launches = 0;
      const recover = createMacWidgetLaunchServicesRecovery({
        execFile: () => { launches += 1; }
      });

      assert.deepEqual(await run(recover, setup), {
        status: 'skipped',
        reason: 'artifacts-missing'
      });
      assert.equal(launches, 0);
      assert.equal(fs.existsSync(setup.userDataPath), false);
    } finally {
      setup.cleanup();
    }
  }
});

test('malformed or incomplete packaged config fails open without registration', async () => {
  for (const config of [{ ...CONFIG, packageVersion: '' }, '{bad json']) {
    const setup = fixture({ config: typeof config === 'string' ? false : config });
    try {
      if (typeof config === 'string') {
        fs.writeFileSync(path.join(setup.resourcesPath, 'token-monitor-widget.json'), config);
      }
      let launches = 0;
      const recover = createMacWidgetLaunchServicesRecovery({
        execFile: () => { launches += 1; }
      });
      assert.deepEqual(await run(recover, setup), {
        status: 'failed',
        reason: 'invalid-config'
      });
      assert.equal(launches, 0);
    } finally {
      setup.cleanup();
    }
  }
});

test('launches the packaged native helper in host-registration mode with bounded options', async () => {
  const setup = fixture();
  const calls = [];
  try {
    const recover = createMacWidgetLaunchServicesRecovery({ execFile: successfulExec(calls) });
    assert.deepEqual(await run(recover, setup), { status: 'completed' });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].file,
      path.join(setup.resourcesPath, 'TokenMonitorWidgetReloader')
    );
    assert.deepEqual(calls[0].args, ['--mode', 'register-host']);
    assert.equal(calls[0].args.includes(setup.appPath), false);
    assert.equal(calls[0].args.includes(setup.appexPath), false);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.timeout, 5_000);
    assert.equal(calls[0].options.killSignal, 'SIGKILL');
    assert.equal(calls[0].options.maxBuffer, 64 * 1024);
  } finally {
    setup.cleanup();
  }
});

test('writes a private marker after success and a fresh process skips a recent matching identity', async () => {
  const setup = fixture();
  const calls = [];
  const now = Date.parse('2026-08-10T00:00:00Z');
  try {
    const first = createMacWidgetLaunchServicesRecovery({
      execFile: successfulExec(calls),
      now: () => now
    });
    assert.deepEqual(await run(first, setup), { status: 'completed' });

    const markerPath = path.join(setup.userDataPath, MARKER_FILE_NAME);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.deepEqual(Object.keys(marker).sort(), [
      'completedAt',
      'registrationIdentity',
      'schemaVersion'
    ]);
    assert.equal(marker.schemaVersion, 2);
    assert.equal(marker.completedAt, '2026-08-10T00:00:00.000Z');
    assert.match(marker.registrationIdentity, /^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600);
    }
    assert.equal(JSON.stringify(marker).includes(setup.root), false);

    const second = createMacWidgetLaunchServicesRecovery({
      execFile: successfulExec(calls),
      now: () => now + REVALIDATE_AFTER_MS - 1
    });
    assert.deepEqual(await run(second, setup), {
      status: 'skipped',
      reason: 'already-completed'
    });
    assert.equal(calls.length, 1);
  } finally {
    setup.cleanup();
  }
});

test('an identical build reinstalled at the same path invalidates the retained marker', async () => {
  const setup = fixture();
  const calls = [];
  const now = Date.parse('2026-08-10T00:00:00Z');
  try {
    const first = createMacWidgetLaunchServicesRecovery({
      execFile: successfulExec(calls),
      now: () => now
    });
    assert.deepEqual(await run(first, setup), { status: 'completed' });

    const previousAppPath = `${setup.appPath}.previous`;
    fs.renameSync(setup.appPath, previousAppPath);
    fs.mkdirSync(setup.resourcesPath, { recursive: true });
    fs.mkdirSync(setup.appexPath, { recursive: true });
    fs.writeFileSync(
      path.join(setup.resourcesPath, 'TokenMonitorWidgetReloader'),
      'test'
    );
    fs.writeFileSync(
      path.join(setup.resourcesPath, 'token-monitor-widget.json'),
      `${JSON.stringify(CONFIG)}\n`
    );

    const reinstalled = createMacWidgetLaunchServicesRecovery({
      execFile: successfulExec(calls),
      now: () => now + 1
    });
    assert.deepEqual(await run(reinstalled, setup), { status: 'completed' });
    assert.equal(calls.length, 2);
  } finally {
    setup.cleanup();
  }
});

test('changed installation metadata invalidates the marker using bigint stats', async () => {
  const setup = fixture();
  const calls = [];
  const now = Date.parse('2026-08-10T00:00:00Z');
  let generation = 0n;
  const privateInoOffset = 9_007_199_254_740_993n;
  const lstatOptions = [];
  const fsApi = {
    ...fs,
    // Force the non-O_NOFOLLOW branch of readRegularFileNoFollow (what Windows
    // hits, since it lacks O_NOFOLLOW) so this test is platform-independent and
    // cannot silently pass only on macOS/Linux.
    constants: { ...fs.constants, O_NOFOLLOW: 0 },
    lstatSync(filePath, options) {
      lstatOptions.push(options);
      if (options?.bigint !== true) {
        // readRegularFileNoFollow stats the path without bigint and compares
        // dev/ino strictly against the descriptor stat, so keep real (non-bigint)
        // metadata here; only the installation fingerprint requests bigint.
        return fs.lstatSync(filePath, { bigint: false });
      }
      const stat = fs.lstatSync(filePath, { bigint: true });
      return {
        isDirectory: () => stat.isDirectory(),
        isFile: () => stat.isFile(),
        isSymbolicLink: () => stat.isSymbolicLink(),
        dev: stat.dev,
        ino: stat.ino + privateInoOffset,
        birthtimeNs: stat.birthtimeNs + generation,
        ctimeNs: stat.ctimeNs + generation
      };
    }
  };
  try {
    const first = createMacWidgetLaunchServicesRecovery({
      fs: fsApi,
      execFile: successfulExec(calls),
      now: () => now
    });
    assert.deepEqual(await run(first, setup), { status: 'completed' });
    const firstMarker = fs.readFileSync(
      path.join(setup.userDataPath, MARKER_FILE_NAME),
      'utf8'
    );

    generation = 1n;
    const changed = createMacWidgetLaunchServicesRecovery({
      fs: fsApi,
      execFile: successfulExec(calls),
      now: () => now + 1
    });
    assert.deepEqual(await run(changed, setup), { status: 'completed' });
    assert.equal(calls.length, 2);
    const bigintStats = lstatOptions.filter((options) => options?.bigint === true);
    assert.equal(bigintStats.length, 6, 'host, appex, and helper should be fingerprinted with bigint stats on both runs');
    const marker = fs.readFileSync(
      path.join(setup.userDataPath, MARKER_FILE_NAME),
      'utf8'
    );
    assert.equal(firstMarker.includes(setup.root), false);
    assert.equal(marker.includes(setup.root), false);
    assert.equal(marker.includes(String(privateInoOffset)), false);
  } finally {
    setup.cleanup();
  }
});

test('revalidates a matching registration identity after the bounded interval', async () => {
  const setup = fixture();
  const calls = [];
  const now = Date.parse('2026-08-10T00:00:00Z');
  try {
    const first = createMacWidgetLaunchServicesRecovery({
      execFile: successfulExec(calls),
      now: () => now
    });
    assert.deepEqual(await run(first, setup), { status: 'completed' });

    const later = createMacWidgetLaunchServicesRecovery({
      execFile: successfulExec(calls),
      now: () => now + REVALIDATE_AFTER_MS
    });
    assert.deepEqual(await run(later, setup), { status: 'completed' });
    assert.equal(calls.length, 2);
  } finally {
    setup.cleanup();
  }
});

test('changed build provenance, URL scheme, or host location gets a new registration identity', async () => {
  const setup = fixture();
  const calls = [];
  try {
    const first = createMacWidgetLaunchServicesRecovery({ execFile: successfulExec(calls) });
    await run(first, setup);
    fs.writeFileSync(
      path.join(setup.resourcesPath, 'token-monitor-widget.json'),
      `${JSON.stringify({ ...CONFIG, packageVersion: '0.43.1' })}\n`
    );
    const changedBuild = createMacWidgetLaunchServicesRecovery({ execFile: successfulExec(calls) });
    assert.deepEqual(await run(changedBuild, setup), { status: 'completed' });

    fs.writeFileSync(
      path.join(setup.resourcesPath, 'token-monitor-widget.json'),
      `${JSON.stringify({ ...CONFIG, packageVersion: '0.43.1', urlScheme: 'token-monitor-preview' })}\n`
    );
    const changedURLScheme = createMacWidgetLaunchServicesRecovery({ execFile: successfulExec(calls) });
    assert.deepEqual(await run(changedURLScheme, setup), { status: 'completed' });

    const moved = fixture({ appName: 'Token Monitor Moved.app' });
    try {
      fs.mkdirSync(moved.userDataPath, { recursive: true });
      fs.copyFileSync(
        path.join(setup.userDataPath, MARKER_FILE_NAME),
        path.join(moved.userDataPath, MARKER_FILE_NAME)
      );
      const changedHost = createMacWidgetLaunchServicesRecovery({ execFile: successfulExec(calls) });
      assert.deepEqual(await run(changedHost, moved), { status: 'completed' });
    } finally {
      moved.cleanup();
    }
    assert.equal(calls.length, 4);
  } finally {
    setup.cleanup();
  }
});

test('a corrupt marker is retried without leaking its path', async () => {
  const setup = fixture();
  const calls = [];
  const messages = [];
  try {
    fs.mkdirSync(setup.userDataPath, { recursive: true });
    fs.writeFileSync(path.join(setup.userDataPath, MARKER_FILE_NAME), '{bad json');
    const recover = createMacWidgetLaunchServicesRecovery({ execFile: successfulExec(calls) });
    assert.deepEqual(await run(recover, setup, {
      logger: (message) => messages.push(message)
    }), { status: 'completed' });
    assert.equal(calls.length, 1);
    assert.equal(messages.some((message) => message.includes(setup.root)), false);
  } finally {
    setup.cleanup();
  }
});

test('bounds packaged config and marker reads before parsing', async () => {
  const setup = fixture();
  const calls = [];
  const limits = [];
  try {
    const recover = createMacWidgetLaunchServicesRecovery({
      execFile: successfulExec(calls),
      readRegularFileNoFollow: (filePath, options) => {
        limits.push({ filePath, maxBytes: options.maxBytes });
        if (filePath.endsWith(MARKER_FILE_NAME)) {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        return `${JSON.stringify(CONFIG)}\n`;
      }
    });

    assert.deepEqual(await run(recover, setup), { status: 'completed' });
    assert.equal(calls.length, 1);
    assert.equal(limits.length, 2);
    assert.ok(limits.every(({ maxBytes }) => Number.isInteger(maxBytes) && maxBytes > 0));
    assert.ok(limits.every(({ maxBytes }) => maxBytes <= 64 * 1024));
  } finally {
    setup.cleanup();
  }
});

test('child launch failures and timeouts are contained and remain retryable', async () => {
  for (const childError of [
    Object.assign(new Error('sensitive launch error'), { code: 'ENOENT' }),
    Object.assign(new Error('sensitive timeout error'), { killed: true, signal: 'SIGKILL' })
  ]) {
    const setup = fixture();
    const calls = [];
    const messages = [];
    try {
      const recover = createMacWidgetLaunchServicesRecovery({
        execFile: (file, args, options, callback) => {
          calls.push({ file, args, options });
          callback(childError, '', 'private child output');
          return { kill() {} };
        }
      });
      const result = await run(recover, setup, { logger: (message) => messages.push(message) });
      assert.deepEqual(result, {
        status: 'failed',
        reason: childError.killed ? 'timed-out' : 'launch-failed'
      });
      assert.equal(fs.existsSync(path.join(setup.userDataPath, MARKER_FILE_NAME)), false);
      assert.equal(messages.join('\n').includes('sensitive'), false);
      assert.equal(messages.join('\n').includes(setup.root), false);

      const retry = createMacWidgetLaunchServicesRecovery({ execFile: successfulExec(calls) });
      assert.deepEqual(await run(retry, setup), { status: 'completed' });
      assert.equal(calls.length, 2);
    } finally {
      setup.cleanup();
    }
  }
});

test('aborted recovery never launches or persists completion', async () => {
  const setup = fixture();
  try {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let launches = 0;
    const recover = createMacWidgetLaunchServicesRecovery({
      execFile: () => { launches += 1; }
    });
    assert.deepEqual(await run(recover, setup, { signal: alreadyAborted.signal }), {
      status: 'skipped',
      reason: 'cancelled'
    });
    assert.equal(launches, 0);

    const duringFlight = new AbortController();
    let complete;
    const pending = createMacWidgetLaunchServicesRecovery({
      execFile: (_file, _args, _options, callback) => {
        complete = callback;
        return { kill() {} };
      }
    });
    const resultPromise = run(pending, setup, { signal: duringFlight.signal });
    duringFlight.abort();
    complete(null, '', '');
    assert.deepEqual(await resultPromise, { status: 'failed', reason: 'cancelled' });
    assert.equal(fs.existsSync(path.join(setup.userDataPath, MARKER_FILE_NAME)), false);
  } finally {
    setup.cleanup();
  }
});

test('concurrent startup calls share one registration attempt', async () => {
  const setup = fixture();
  let complete;
  let launches = 0;
  try {
    const recover = createMacWidgetLaunchServicesRecovery({
      execFile: (_file, _args, _options, callback) => {
        launches += 1;
        complete = callback;
        return { kill() {} };
      }
    });
    const first = run(recover, setup);
    const second = run(recover, setup);
    assert.equal(launches, 1);
    complete(null, '', '');
    assert.deepEqual(await first, { status: 'completed' });
    assert.deepEqual(await second, { status: 'completed' });
    assert.equal(launches, 1);
  } finally {
    setup.cleanup();
  }
});

test('marker write failure is contained and remains retryable', async () => {
  const setup = fixture();
  const calls = [];
  try {
    const recover = createMacWidgetLaunchServicesRecovery({
      execFile: successfulExec(calls),
      writePrivateJsonAtomic: () => { throw new Error('private marker path'); }
    });
    assert.deepEqual(await run(recover, setup), {
      status: 'failed',
      reason: 'marker-write-failed'
    });
    const retry = createMacWidgetLaunchServicesRecovery({ execFile: successfulExec(calls) });
    assert.deepEqual(await run(retry, setup), { status: 'completed' });
    assert.equal(calls.length, 2);
  } finally {
    setup.cleanup();
  }
});
