'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { collectUsageOnce } = require('../../src/shared/collector');
const { applySessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
const { projectRowsForPeriod } = require('../../src/electron/renderer/projectRows');

test('DSH usage reaches both project tool and model breakdowns from its transcript cwd', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-project-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = 'session-project';
  const dir = path.join(home, '.dsh', 'sessions', 'opaque-workspace-key', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const header = {
    type: 'session', version: 4, id: sessionId, createdAt: 1750000000000,
    cwd: 'C:\\work\\Demo', isSeeded: false, delegationDepth: 0
  };
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)));
  const result = await collectUsageOnce({
    clients: 'dsh', projectsEnabled: true, homeDir: home, env: {},
    allTimeSince: '2024-01-01', commandTimeoutMs: 1000,
    deviceId: 'test-device', agentVersion: 'test',
    limitsEnabled: false, historyEnabled: false,
    sessionMetadataDeps: { dshSessionFileCache: new Map() },
    runTokscale: async () => ({ entries: [
      { client: 'dsh', sessionId, model: 'deepseek-v4.1-flash', input: 100, output: 50, cost: 0.001 },
      { client: 'dsh', sessionId, model: 'deepseek-v4.1', input: 30, output: 20, cost: 0.002 }
    ] }),
    collectWslUsage: async () => ({ bundle: { today: {}, month: {}, allTime: {} }, detected: [] })
  });
  for (const name of ['today', 'month', 'allTime']) {
    const period = result[name];
    assert.equal(period.sessions[`dsh:${sessionId}`].totalTokens, 200, `${name}: DSH usage is collected`);
    const tools = projectRowsForPeriod(period, { clientLabels: { dsh: 'DeepSeek Harness' } });
    assert.equal(tools.length, 1, `${name}: DSH usage must appear in Projects`);
    assert.equal(tools[0].name, 'Demo');
    assert.equal(tools[0].value, 200);
    assert.deepEqual(tools[0].accordionRows.map(({ key, value }) => ({ key, value })), [{ key: 'dsh', value: 200 }]);
    const models = projectRowsForPeriod(period, { shareBy: 'model' });
    assert.equal(models[0].value, 200);
    assert.deepEqual(models[0].accordionRows.map(({ key, value }) => ({ key, value })), [
      { key: 'deepseek-v4.1-flash', value: 150 },
      { key: 'deepseek-v4.1', value: 50 }
    ]);
  }
});

function metadataFixture(t, cwd) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-project-meta-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const id = 'session-metadata';
  const dir = path.join(home, '.dsh', 'sessions', 'opaque-workspace-key', id);
  fs.mkdirSync(dir, { recursive: true });
  const header = { type: 'session', id, createdAt: 1750000000000, cwd };
  fs.writeFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify(header)}\n`);
  const dshSessionFileCache = new Map();
  return {
    dir,
    header,
    read(options = {}) {
      const periods = { today: { sessions: { [`dsh:${id}`]: { client: 'dsh', sessionId: id, totalTokens: 200 } } } };
      applySessionMetadata(periods, home, {
        env: {}, dshSessionFileCache, dshDirectoryFingerprintsReliable: false, ...options
      });
      return periods.today.sessions[`dsh:${id}`];
    }
  };
}

test('DSH project metadata survives cached reads and a Projects opt-out', (t) => {
  const fixture = metadataFixture(t, 'C:\\work\\Demo');
  const disabled = fixture.read({ resolveProjects: false });
  assert.ok(disabled.startedAt, 'timestamps remain available with project tracking disabled');
  assert.equal(disabled.projectId, undefined);
  for (let tick = 0; tick < 2; tick += 1) {
    const session = fixture.read();
    assert.equal(session.projectId, projectIdentity('c:/work/demo/').projectId);
    assert.equal(session.projectLabel, 'Demo');
    assert.equal(session.totalTokens, 200);
  }
});

test('DSH project metadata uses the preferred generation when it replaces a cached legacy log', (t) => {
  const fixture = metadataFixture(t, '/work/stale');
  assert.equal(fixture.read().projectLabel, 'stale');
  fs.writeFileSync(path.join(fixture.dir, 'session.v4.jsonl'), `${JSON.stringify({ ...fixture.header, cwd: '/work/current' })}\n`);
  for (let tick = 0; tick < 2; tick += 1) {
    const session = fixture.read();
    assert.equal(session.projectId, projectIdentity('/work/current').projectId);
    assert.equal(session.projectLabel, 'current');
  }
});

test('DSH without a valid cwd never treats its directory bucket as a project', (t) => {
  for (const cwd of [undefined, '', '  ', null, 42, { path: '/work/not-a-string' }]) {
    const session = metadataFixture(t, cwd).read();
    assert.ok(session.startedAt);
    assert.equal(session.totalTokens, 200);
    assert.equal(session.projectId, undefined);
    assert.equal(session.projectLabel, undefined);
  }
});

test('DSH header recovery does not attribute usage to a different session', (t) => {
  const fixture = metadataFixture(t, undefined);
  const file = path.join(fixture.dir, 'session.jsonl');
  fs.writeFileSync(file, '{"type":"session"\n');
  assert.equal(fixture.read().projectId, undefined);
  fs.writeFileSync(file, `${JSON.stringify({ ...fixture.header, id: 'another-session', cwd: '/work/other' })}\n`);
  assert.equal(fixture.read().projectId, undefined);
});
