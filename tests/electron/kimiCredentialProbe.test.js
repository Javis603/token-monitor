'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
const { resolveKimiManualSession, KIMI_AUTH_REFRESH_URL } = require('../../src/shared/providers/kimi/desktopSession');
const { sharedDataDir } = require('../../src/shared/config');

function jwt(sub, lifetime) {
  const iat = Math.floor(Date.now() / 1000);
  return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, iat, exp: iat + lifetime })).toString('base64url')}.sig`;
}
function pair(sub) { return { accessToken: jwt(sub, 900), refreshToken: jwt(sub, 90 * 86400) }; }
function response(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => '' }, json: async () => body };
}
const quota = { usages: [{ scope: 'FEATURE_CODING', detail: { used: 20, limit: 100 } }] };

async function fixture(t, { override = 'TOKEN_MONITOR_SHARED_DIR', quotaResponse, failSettings = false, activeStaleSeed = false, savedRefresh = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-probe-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { [override]: root, KIMI_CODE_API_KEY: 'must-not-vouch' };
  // APPDATA resolution is platform-specific; the injected dataDir is already
  // resolved by main before the credential env is stripped for the probe.
  const dataDir = sharedDataDir({ env, ...(override === 'APPDATA' ? { platform: 'win32' } : {}) });
  const cachePath = path.join(dataDir, 'kimi-manual-session.json');
  const oldSeed = jwt('old-seed', 90 * 86400);
  const oldPair = pair('old');
  await resolveKimiManualSession(oldSeed, { dataDir, fetch: async () => response(200, oldPair) });
  if (activeStaleSeed) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    cached.accessToken = jwt('old', -60);
    fs.writeFileSync(cachePath, JSON.stringify(cached));
  }
  const oldCache = fs.readFileSync(cachePath, 'utf8');
  const seed = activeStaleSeed ? oldSeed : jwt('new-seed', 90 * 86400);
  const rotated = pair('new');
  let settings = savedRefresh ? { kimiWebRefreshToken: oldSeed } : {};
  const exchanged = [];
  const api = createCredentialCommands({
    getSettings: () => settings,
    env,
    probeDeps: () => ({
      probe: true,
      dataDir,
      fetch: async (url, init) => {
        if (url === KIMI_AUTH_REFRESH_URL) {
          exchanged.push(JSON.parse(init.body).refreshToken);
          return response(200, rotated);
        }
        assert.equal(fs.readFileSync(cachePath, 'utf8'), oldCache, 'quota validation cannot replace the active cache');
        return quotaResponse ? quotaResponse(url, init) : response(200, quota);
      }
    }),
    applySettingsPatch: (patch, context) => {
      const rollback = context.commitProbeWrites?.();
      if (failSettings) {
        rollback?.();
        throw new Error('credential storage failed');
      }
      settings = { ...settings, ...patch };
      return { redacted: true };
    }
  });
  return { api, dataDir, cachePath, oldCache, seed, rotated, exchanged };
}

for (const override of ['TOKEN_MONITOR_SHARED_DIR', 'XDG_CONFIG_HOME', 'APPDATA']) {
  test(`Kimi accepted probe commits the rotated pair at the runtime ${override} path`, async (t) => {
    const f = await fixture(t, { override });
    const result = await f.api.saveCredential('kimi', { kimiWebAccessToken: f.seed });
    assert.equal(result.saved, true);
    assert.equal(result.verdict, 'valid');
    assert.deepEqual(f.exchanged, [f.seed], 'the saved refresh sibling must not vouch for the pasted token');
    const runtime = await resolveKimiManualSession(f.seed, {
      dataDir: f.dataDir,
      fetch: async () => { throw new Error('the already consumed seed must not be exchanged again'); }
    });
    assert.equal(runtime.accessToken, f.rotated.accessToken);
    assert.equal(runtime.refreshToken, f.rotated.refreshToken);
    assert.doesNotMatch(JSON.stringify(result), /eyJ/, 'no credential reaches the renderer');
  });
}

test('a rejected Kimi quota probe leaves the active cache unchanged', async (t) => {
  const f = await fixture(t, { savedRefresh: false, quotaResponse: () => response(401, {}) });
  const result = await f.api.saveCredential('kimi', { kimiWebAccessToken: f.seed });
  assert.equal(result.saved, false);
  assert.equal(result.verdict, 'invalid');
  assert.equal(fs.readFileSync(f.cachePath, 'utf8'), f.oldCache);
});

test('a superseded Kimi probe cannot replace the active cache', async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const f = await fixture(t, { savedRefresh: false, quotaResponse: () => { entered.resolve(); return finish.promise; } });
  const pending = f.api.saveCredential('kimi', { kimiWebAccessToken: f.seed });
  await entered.promise;
  f.api.noteSettingsPatch({ kimiWebAccessToken: 'newer-choice' });
  finish.resolve(response(200, quota));
  assert.equal((await pending).verdict, 'superseded');
  assert.equal(fs.readFileSync(f.cachePath, 'utf8'), f.oldCache);
});

test('a Kimi settings persistence failure rolls the staged cache back', async (t) => {
  const f = await fixture(t, { failSettings: true, savedRefresh: false });
  await assert.rejects(f.api.saveCredential('kimi', { kimiWebAccessToken: f.seed }), /credential storage failed/);
  assert.equal(fs.readFileSync(f.cachePath, 'utf8'), f.oldCache);
});

test('main passes the runtime directory and commits staged writes inside settings persistence', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const probe = main.slice(main.indexOf('function credentialProbeDeps'), main.indexOf('function electronLimitsDeps'));
  assert.match(probe, /dataDir: sharedDataDir\(\)/);
  const apply = main.slice(main.indexOf('function applySettingsPatch('));
  const commit = apply.indexOf('rollbackProbeWrites = limitContext.commitProbeWrites?.()');
  assert.ok(commit >= 0);
  assert.ok(apply.indexOf('saveSettings({ throwOnError: true })', commit) > commit);
  assert.match(apply, /rollbackProbeWrites\?\.\(\)/);
});

for (const scenario of ['superseded', 'failed save']) {
  test(`re-saving the active stale seed preserves its refresh token after ${scenario}`, async (t) => {
    const f = await fixture(t, { activeStaleSeed: true, failSettings: scenario === 'failed save' });
    const pending = f.api.saveCredential('kimi', { kimiWebAccessToken: f.seed });
    if (scenario === 'superseded') {
      f.api.noteSettingsPatch({ kimiApiKey: 'new-code-key' });
      assert.equal((await pending).verdict, 'superseded');
    } else {
      await assert.rejects(pending, /credential storage failed/);
    }
    assert.deepEqual(f.exchanged, [], 'draft probes do not consume the existing rotating chain');
    assert.equal(fs.readFileSync(f.cachePath, 'utf8'), f.oldCache);
  });
}
