'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHub } = require('../../src/hub/server');
const { syncPayload } = require('../../src/shared/syncPayload');
const { normalizeSharedSyncValue } = require('../../src/shared/syncContent');
const { createSyncContentRuntime, normalizeSyncContentState } = require('../../src/electron/syncContentRuntime');

function client(hub, deviceId) {
  const context = { mode: 'host', url: 'http://127.0.0.1:17321', secret: 'test', deviceId };
  let saved = normalizeSyncContentState(null);
  const local = { modelAliases: { modelAliases: {}, modelAliasGrouping: 'off' }, customPricing: [] };
  const applications = [];
  const runtime = createSyncContentRuntime({ getContext: () => context, getState: () => saved,
    saveState: next => { saved = next; }, getLocalValue: kind => local[kind],
    normalizeValue: normalizeSharedSyncValue, applyLocalValue: (kind, value) => { local[kind] = value; applications.push(kind); },
    request: async (_ctx, route, method, body) => {
      try {
        if (route === '/api/sync/content') return { status: 200, body: hub.getSyncContent() };
        const match = route.match(/^\/api\/sync\/settings\/(.*)$/);
        if (match) return { status: 200, body: { ok: true, ...(method === 'PUT'
          ? hub.setSyncSettings(match[1], body) : hub.getSyncSettings(match[1])) } };
        return { status: 200, body: { ok: true, ...hub.setSyncTitlePolicy(deviceId, body.enabled) } };
      } catch (error) { return { status: error.code === 'stale_write' ? 409 : 400, body: error.current }; }
    }
  });
  return { runtime, local, applications };
}

test('two clients share prices through the Hub, reapply on change, and reject a stale edit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-content-integration-'));
  try {
    const hub = createHub({ dataFile: path.join(dir, 'devices.json'), syncSessionTitles: true });
    const one = client(hub, 'one');
    const two = client(hub, 'two');
    one.local.customPricing = [{ modelId: 'model', inputPerM: 0, cacheWrite1hPerM: 2 }];
    const first = await one.runtime.preview('customPricing');
    await one.runtime.configure({ ...first, enabled: true, source: 'local' });
    const second = await two.runtime.preview('customPricing');
    assert.equal(second.hasServerValue, true);
    await two.runtime.configure({ ...second, enabled: true, source: 'server' });
    assert.deepEqual(two.local.customPricing, one.local.customPricing);
    const base = two.runtime.status();
    const ownerBase = one.runtime.status();
    await one.runtime.publishPatch({ customModelPricing: [{ modelId: 'model', outputPerM: 3 }] }, {
      identity: ownerBase.identity, revisions: ownerBase.revisions
    });
    two.runtime.notifyStats(hub.getStats());
    await two.runtime.refresh();
    assert.deepEqual(two.local.customPricing, [{ modelId: 'model', outputPerM: 3 }]);
    assert.deepEqual(two.applications, ['customPricing', 'customPricing']);
    await assert.rejects(two.runtime.publishPatch({ customModelPricing: [] }, {
      identity: base.identity, revisions: base.revisions
    }), { code: 'conflict' });
    assert.deepEqual(hub.getSyncSettings('customPricing').value, [{ modelId: 'model', outputPerM: 3 }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('revocation clears stored titles immediately and an old serialized upload cannot restore them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-titles-integration-'));
  try {
    const hub = createHub({ dataFile: path.join(dir, 'devices.json'), syncSessionTitles: true });
    const one = client(hub, 'one');
    const identity = one.runtime.status().identity;
    await one.runtime.configure({ kind: 'sessionTitles', enabled: true, identity, confirmed: true });
    const old = syncPayload({ deviceId: 'one', today: { sessions: { 'codex:test': {
      sessionId: 'test', client: 'codex', totalTokens: 5, title: 'Project ABC', preview: 'private body'
    } } } }, await one.runtime.prepareUpload());
    hub.ingest(old);
    assert.equal(hub.getDevices()[0].periods.today.sessions['codex:test'].title, 'Project ABC');
    await one.runtime.configure({ kind: 'sessionTitles', enabled: false, identity });
    assert.equal(hub.getDevices()[0].periods.today.sessions['codex:test'].title || '', '');
    hub.ingest(old);
    assert.equal(hub.getDevices()[0].periods.today.sessions['codex:test'].title || '', '');
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'devices.json'), 'utf8'), /Project ABC|private body/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a running client renews a generation revoked by a server restart while it was offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-title-generation-'));
  try {
    const dataFile = path.join(dir, 'devices.json');
    const hub = createHub({ dataFile, syncSessionTitles: true });
    const one = client(hub, 'one');
    await one.runtime.configure({ kind: 'sessionTitles', enabled: true,
      identity: one.runtime.status().identity, confirmed: true });
    const first = await one.runtime.prepareUpload();
    // Server-side revocation has the same persisted-policy effect as disabling
    // receiving on restart, before the client next probes the enabled server.
    hub.setSyncTitlePolicy('one', false);
    const renewed = await one.runtime.prepareUpload();
    assert.equal(renewed.syncSessionTitles, true);
    assert.ok(renewed.sessionTitleSyncGeneration > first.sessionTitleSyncGeneration);
    hub.ingest(syncPayload({ deviceId: 'one', today: { sessions: { 'codex:test': {
      sessionId: 'test', client: 'codex', title: 'Renewed title', totalTokens: 1
    } } } }, renewed));
    assert.equal(hub.getDevices()[0].periods.today.sessions['codex:test'].title, 'Renewed title');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
