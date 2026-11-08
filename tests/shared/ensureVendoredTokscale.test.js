'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureVendoredTokscale } = require('../../scripts/ensure-vendored-tokscale');
const { manifestMode } = require('../../scripts/vendoredTokscale');

test('manifestMode defaults to override and only "upstream" flips it', () => {
  assert.equal(manifestMode({}), 'override');
  assert.equal(manifestMode({ mode: null }), 'override');
  assert.equal(manifestMode({ mode: 'override' }), 'override');
  assert.equal(manifestMode({ mode: 'upstream' }), 'upstream');
});

test('manifestMode fails closed on an unrecognized mode instead of silently defaulting', () => {
  assert.throws(() => manifestMode({ mode: 'upsteam' }), /Invalid "mode"/);
  assert.throws(() => manifestMode({ mode: 'Override' }), /Invalid "mode"/);
});

function manifestFor(payload, overrides = {}) {
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  return {
    releaseRepo: 'Javis603/tokscale',
    releaseTag: 'token-monitor-test',
    commit: '59712ada85640b7aaa00d7da92ed1a15367e961b',
    baseVersion: '4.13.0',
    platforms: {
      'darwin-arm64': {
        package: '@tokscale/cli-darwin-arm64',
        asset: 'tokscale-darwin-arm64',
        sha256,
        ...overrides
      }
    }
  };
}

function dependencies(target, version = '4.13.0') {
  return {
    resolveTarget: () => target,
    resolveVersion: () => version,
    log: () => {}
  };
}

test('ensure skips download when the installed binary already matches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ensure-'));
  const target = path.join(dir, 'tokscale');
  const payload = Buffer.from('vendored binary');
  fs.writeFileSync(target, payload);
  let downloads = 0;

  try {
    const result = await ensureVendoredTokscale({
      manifest: manifestFor(payload),
      requestedKey: 'darwin-arm64',
      download: async () => { downloads += 1; throw new Error('should not download'); },
      ...dependencies(target)
    });
    assert.equal(result.status, 'matched');
    assert.equal(downloads, 0);
    assert.deepEqual(fs.readFileSync(target), payload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure downloads, smoke-tests, and atomically replaces a mismatched binary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ensure-'));
  const target = path.join(dir, 'tokscale');
  const oldPayload = Buffer.from('stock binary');
  const newPayload = Buffer.from('vendored binary');
  fs.writeFileSync(target, oldPayload);
  let downloads = 0;
  let smokePath = '';

  try {
    const result = await ensureVendoredTokscale({
      manifest: manifestFor(newPayload),
      requestedKey: 'darwin-arm64',
      download: async () => { downloads += 1; return newPayload; },
      smoke: (filePath) => {
        smokePath = filePath;
        assert.deepEqual(fs.readFileSync(filePath), newPayload);
        return 'tokscale 4.13.0';
      },
      ...dependencies(target)
    });
    assert.equal(result.status, 'installed');
    assert.equal(downloads, 1);
    assert.match(smokePath, /\.vendor-tmp-\d+-[0-9a-f]{8}$/);
    assert.deepEqual(fs.readFileSync(target), newPayload);
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.vendor-tmp-')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure refuses a base-version mismatch before downloading', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ensure-'));
  const target = path.join(dir, 'tokscale');
  fs.writeFileSync(target, 'stock binary');
  let downloads = 0;

  try {
    await assert.rejects(
      ensureVendoredTokscale({
        manifest: manifestFor(Buffer.from('vendored binary')),
        requestedKey: 'darwin-arm64',
        download: async () => { downloads += 1; return Buffer.from('unexpected'); },
        ...dependencies(target, '4.14.0')
      }),
      /vendor override was built against 4\.13\.0/
    );
    assert.equal(downloads, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), 'stock binary');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure preserves the original binary when the replacement smoke test fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ensure-'));
  const target = path.join(dir, 'tokscale');
  const oldPayload = Buffer.from('stock binary');
  const newPayload = Buffer.from('vendored binary');
  fs.writeFileSync(target, oldPayload);

  try {
    await assert.rejects(
      ensureVendoredTokscale({
        manifest: manifestFor(newPayload),
        requestedKey: 'darwin-arm64',
        download: async () => newPayload,
        smoke: () => { throw new Error('bad executable'); },
        ...dependencies(target)
      }),
      /bad executable/
    );
    assert.deepEqual(fs.readFileSync(target), oldPayload);
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.vendor-tmp-')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure falls back on a source platform without a vendored asset', async () => {
  const logs = [];
  const result = await ensureVendoredTokscale({
    manifest: { platforms: {} },
    resolveOptional: () => ({ key: 'linux-arm64-musl', entry: null }),
    log: (message) => logs.push(message)
  });
  assert.deepEqual(result, { status: 'fallback', key: 'linux-arm64-musl' });
  assert.match(logs[0], /runtime capability filtering/);
});

test('explicitly requested unsupported target remains fail-closed', async () => {
  await assert.rejects(
    ensureVendoredTokscale({ manifest: { platforms: {} }, requestedKey: 'linux-arm64-musl' }),
    /No vendored tokscale binary recorded/
  );
});

test('a vendored target whose npm package is absent on this host fails closed by default', async () => {
  // Real case: packaging darwin-x64 on an Apple Silicon host (or vice versa)
  // — the platform is genuinely in the manifest, but npm's optionalDependencies
  // cpu/os gating means that platform's package was never installed here.
  // Every real packaging/distribution command must still fail here — only an
  // explicit opt-in (below) may accept the gap.
  const notInstalled = new Error("Cannot find module '@tokscale/cli-darwin-x64/package.json'");
  notInstalled.code = 'MODULE_NOT_FOUND';
  let downloads = 0;

  await assert.rejects(
    ensureVendoredTokscale({
      manifest: manifestFor(Buffer.from('vendored binary'), { package: '@tokscale/cli-darwin-x64' }),
      requestedKey: 'darwin-arm64',
      resolveTarget: () => { throw notInstalled; },
      download: async () => { downloads += 1; return Buffer.from('vendored binary'); },
      log: () => {}
    }),
    /is not installed for darwin-arm64/
  );
  assert.equal(downloads, 0);
});

test('--allow-missing-target-package lets a cross-arch structural build degrade instead of crashing', async () => {
  const notInstalled = new Error("Cannot find module '@tokscale/cli-darwin-x64/package.json'");
  notInstalled.code = 'MODULE_NOT_FOUND';
  const logs = [];
  let downloads = 0;

  const result = await ensureVendoredTokscale({
    manifest: manifestFor(Buffer.from('vendored binary'), { package: '@tokscale/cli-darwin-x64' }),
    requestedKey: 'darwin-arm64',
    allowMissingTargetPackage: true,
    resolveTarget: () => { throw notInstalled; },
    download: async () => { downloads += 1; return Buffer.from('vendored binary'); },
    log: (message) => logs.push(message)
  });

  assert.deepEqual(result, { status: 'unavailable', key: 'darwin-arm64' });
  assert.equal(downloads, 0);
  assert.ok(logs.some((line) => line.includes('explicitly allowed')));
});

test('a resolveTarget failure unrelated to a missing module still fails closed', async () => {
  const target = new Error('permission denied');
  await assert.rejects(
    ensureVendoredTokscale({
      manifest: manifestFor(Buffer.from('vendored binary')),
      requestedKey: 'darwin-arm64',
      resolveTarget: () => { throw target; },
      resolveVersion: () => '4.13.0',
      log: () => {}
    }),
    /permission denied/
  );
});

test('mode "upstream" resolves and verifies the npm-installed target but never downloads or replaces it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ensure-'));
  const target = path.join(dir, 'tokscale');
  fs.writeFileSync(target, 'npm-installed binary');
  const logs = [];

  try {
    const result = await ensureVendoredTokscale({
      manifest: { ...manifestFor(Buffer.from('vendored binary')), mode: 'upstream' },
      requestedKey: 'darwin-arm64',
      resolveTarget: () => target,
      resolveVersion: () => { throw new Error('must not be called in upstream mode'); },
      download: async () => { throw new Error('must not download in upstream mode'); },
      log: (message) => logs.push(message)
    });
    assert.deepEqual(result, { status: 'upstream', key: 'darwin-arm64', targetBinPath: target });
    assert.ok(logs.some((line) => line.includes('upstream')));
    assert.equal(fs.readFileSync(target, 'utf8'), 'npm-installed binary');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mode "upstream" still fails closed when an explicitly requested target\'s npm package is missing', async () => {
  // The cross-arch guarantee ensure-vendored-tokscale.js gives every other
  // mode must not quietly disappear once mode flips to "upstream" — a
  // missing npm optional package means there is nothing to ship for this
  // target regardless of whether a downstream binary would have been swapped
  // in afterward.
  const notInstalled = new Error("Cannot find module '@tokscale/cli-darwin-x64/package.json'");
  notInstalled.code = 'MODULE_NOT_FOUND';

  await assert.rejects(
    ensureVendoredTokscale({
      manifest: { ...manifestFor(Buffer.from('vendored binary'), { package: '@tokscale/cli-darwin-x64' }), mode: 'upstream' },
      requestedKey: 'darwin-arm64',
      resolveTarget: () => { throw notInstalled; },
      log: () => {}
    }),
    /is not installed for darwin-arm64/
  );
});

test('mode "upstream" + --allow-missing-target-package still degrades a structural cross-arch build instead of crashing', async () => {
  const notInstalled = new Error("Cannot find module '@tokscale/cli-darwin-x64/package.json'");
  notInstalled.code = 'MODULE_NOT_FOUND';
  const logs = [];

  const result = await ensureVendoredTokscale({
    manifest: { ...manifestFor(Buffer.from('vendored binary'), { package: '@tokscale/cli-darwin-x64' }), mode: 'upstream' },
    requestedKey: 'darwin-arm64',
    allowMissingTargetPackage: true,
    resolveTarget: () => { throw notInstalled; },
    log: (message) => logs.push(message)
  });

  assert.deepEqual(result, { status: 'unavailable', key: 'darwin-arm64' });
  assert.ok(logs.some((line) => line.includes('explicitly allowed')));
});

test('mode absent behaves exactly like mode "override" (backward compatible)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ensure-'));
  const target = path.join(dir, 'tokscale');
  const payload = Buffer.from('vendored binary');
  fs.writeFileSync(target, payload);
  const manifest = manifestFor(payload);
  assert.equal(manifest.mode, undefined);

  try {
    const result = await ensureVendoredTokscale({
      manifest,
      requestedKey: 'darwin-arm64',
      ...dependencies(target)
    });
    assert.equal(result.status, 'matched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
