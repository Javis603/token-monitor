'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHub } = require('../../src/hub/server');
const { createSyncPayloadUploader } = require('../../src/shared/syncPayload');
const { summaryForUpload } = require('../fixtures/syncUpload');

for (const kind of ['Node', 'Worker']) {
  test(`${kind} legacy ingest retains omitted History and reconciles a deleted record`, async t => {
    let request;
    const base = 'https://hub.invalid';
    if (kind === 'Node') {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-history-upload-'));
      const hub = createHub({ port: 0, host: '127.0.0.1', secret: 'fixture', dataFile: path.join(directory, 'devices.json') });
      await hub.start();
      t.after(async () => { await hub.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
      const local = `http://127.0.0.1:${hub.server.address().port}`;
      request = (url, options) => fetch(url.replace(base, local), options);
    } else {
      const { HubDO } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
      const data = new Map();
      const hub = new HubDO({ storage: {
        async get(key) { return structuredClone(data.get(key)); },
        async put(key, value) { data.set(key, structuredClone(value)); },
        async delete(key) { data.delete(key); },
        async list({ prefix } = {}) { return new Map([...data].filter(([key]) => !prefix || key.startsWith(prefix))); }
      } }, { TOKEN_MONITOR_SECRET: 'fixture' });
      request = (url, options) => hub.fetch(new Request(url, options));
    }
    const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json', 'x-token-monitor-response': 'minimal' };
    let now = 0;
    const upload = createSyncPayloadUploader({ now: () => now });
    // Simulate an older Hub which ignores upload negotiation.
    const legacyRequest = (url, options) => { const h = new Headers(options.headers); h.delete('x-token-monitor-upload'); return request(url, { ...options, headers: h }); };
    const send = tick => upload(legacyRequest, `${base}/api/ingest`, { summary: summaryForUpload({ tick }), headers });
    const devices = async () => (await (await request(`${base}/api/devices`, { headers })).json()).devices;
    assert.ok((await send(0)).payload.history);
    assert.equal(Object.hasOwn((await send(1)).payload, 'history'), false);
    let stored = await devices();
    assert.equal(stored[0].history.daily.length, 151);
    assert.equal(stored[0].periods.today.totalTokens, 200001);
    await request(`${base}/api/devices/bandwidth-fixture`, { method: 'DELETE', headers });
    now = 15 * 60 * 1000;
    assert.ok((await send(2)).payload.history);
    stored = await devices();
    assert.equal(stored[0].history.daily.length, 151);
    assert.equal(stored[0].periods.today.totalTokens, 200002);
  });
}
