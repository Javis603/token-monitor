'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SYNC_PAYLOAD_BUDGET_BYTES, postSyncPayload, serializeSyncPayload, syncPayload } = require('../../src/shared/syncPayload');

test('syncPayload preserves nullish inputs', () => {
  assert.equal(syncPayload(null), null);
  assert.equal(syncPayload(undefined), undefined);
});

test('syncPayload preserves the upload interval used by hub staleness checks', () => {
  const payload = syncPayload({
    deviceId: 'dev-a',
    syncUploadIntervalMs: 20 * 60 * 1000,
    limits: { providers: [] }
  });

  assert.equal(payload.syncUploadIntervalMs, 20 * 60 * 1000);
});

test('syncPayload bounds uploads by omitting all-time sessions', () => {
  const summary = {
    deviceId: 'dev-a',
    today: { totalTokens: 10, sessions: { today: { totalTokens: 10 } } },
    month: { totalTokens: 20, sessions: { month: { totalTokens: 20 } } },
    allTime: {
      totalTokens: 30,
      clients: { claude: 30 },
      models: { opus: 30 },
      sessions: { old: { totalTokens: 30 } }
    },
    history: { daily: [{ date: '2026-07-11', totalTokens: 10 }] },
    limits: { providers: [] }
  };

  const payload = syncPayload(summary);

  assert.equal(Object.hasOwn(payload.allTime, 'sessions'), false);
  assert.deepEqual(payload.today, summary.today);
  assert.deepEqual(payload.month, summary.month);
  assert.deepEqual(payload.allTime.clients, summary.allTime.clients);
  assert.deepEqual(payload.allTime.models, summary.allTime.models);
  assert.deepEqual(payload.history, summary.history);
  assert.equal(summary.allTime.sessions.old.totalTokens, 30);
});

test('syncPayload strips recomputable projects and keeps bounded all-time projects', () => {
  const summary = {
    today: { sessions: { a: { totalTokens: 1 } }, projects: { today: { tokens: 1 } } },
    month: { sessions: { a: { totalTokens: 1 } }, projects: { month: { tokens: 1 } } },
    allTime: { sessions: { a: { totalTokens: 1 } }, projects: { total: { label: 'Total', tokens: 1, clients: {} } } }
  };
  const payload = syncPayload(summary);
  assert.equal(Object.hasOwn(payload.today, 'projects'), false);
  assert.equal(Object.hasOwn(payload.month, 'projects'), false);
  assert.equal(Object.hasOwn(payload.allTime, 'sessions'), false);
  assert.equal(payload.allTime.projects.total.tokens, 1);
  assert.equal(Object.hasOwn(payload, 'allTimeProjectsOmitted'), false);
  assert.ok(summary.today.projects.today);
});

test('syncPayload strips project metadata when project tracking is disabled', () => {
  const summary = {
    projectsEnabled: false,
    today: {
      sessions: { a: { client: 'codex', projectId: 'sha256:private', projectLabel: 'Private App', project_id: 'legacy-id', project_label: 'Legacy App', totalTokens: 1 } },
      projects: { private: { label: 'Private App', tokens: 1 } }
    },
    month: {
      sessions: { a: { client: 'codex', projectId: 'sha256:private', projectLabel: 'Private App', totalTokens: 1 } },
      projects: { private: { label: 'Private App', tokens: 1 } }
    },
    allTime: { projects: { private: { label: 'Private App', tokens: 1 } } },
    allTimeProjectsIncomplete: true
  };

  const payload = syncPayload(summary);

  assert.equal(payload.projectsEnabled, false);
  assert.equal(Object.hasOwn(payload.today, 'projects'), false);
  assert.equal(Object.hasOwn(payload.today.sessions.a, 'projectId'), false);
  assert.equal(Object.hasOwn(payload.today.sessions.a, 'projectLabel'), false);
  assert.equal(Object.hasOwn(payload.today.sessions.a, 'project_id'), false);
  assert.equal(Object.hasOwn(payload.today.sessions.a, 'project_label'), false);
  assert.equal(Object.hasOwn(payload.month.sessions.a, 'projectId'), false);
  assert.equal(Object.hasOwn(payload.month.sessions.a, 'projectLabel'), false);
  assert.equal(Object.hasOwn(payload.allTime, 'projects'), false);
  assert.equal(Object.hasOwn(payload, 'allTimeProjectsIncomplete'), false);
  assert.equal(summary.today.sessions.a.projectLabel, 'Private App');
});

test('serializeSyncPayload drops only all-time projects when they exceed the byte budget', () => {
  const summary = {
    deviceId: 'dev',
    today: { totalTokens: 10, sessions: { current: { totalTokens: 10 } } },
    month: { totalTokens: 20, sessions: { current: { totalTokens: 20 } } },
    allTime: {
      totalTokens: 30,
      sessions: { old: { totalTokens: 30 } },
      projects: { huge: { label: 'x'.repeat(400), tokens: 30, costUsd: 1, clients: { codex: 30 } } }
    }
  };
  const { payload, bytes } = serializeSyncPayload(summary, { maxBytes: 250 });
  assert.equal(payload.allTimeProjectsOmitted, true);
  assert.equal(Object.hasOwn(payload.allTime, 'projects'), false);
  assert.equal(Object.hasOwn(payload.allTime, 'sessions'), false);
  assert.deepEqual(payload.today.sessions, summary.today.sessions);
  assert.deepEqual(payload.month.sessions, summary.month.sessions);
  assert.equal(payload.allTime.totalTokens, 30);
  assert.ok(bytes < 400);
});

test('postSyncPayload retries a legacy 413 once without all-time projects', async () => {
  const bodies = [];
  const responses = [
    { status: 413, ok: false, async arrayBuffer() { return new ArrayBuffer(0); } },
    { status: 200, ok: true }
  ];
  const logs = [];
  const { response, payload, retried } = await postSyncPayload(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return responses.shift();
  }, 'http://hub/api/ingest', {
    summary: { allTime: { totalTokens: 5, projects: { app: { label: 'App', tokens: 5, clients: {} } } } },
    logger: (message) => logs.push(message)
  });

  assert.equal(response.status, 200);
  assert.equal(retried, true);
  assert.equal(Object.hasOwn(bodies[0].allTime, 'projects'), true);
  assert.equal(Object.hasOwn(bodies[1].allTime, 'projects'), false);
  assert.equal(payload.allTimeProjectsOmitted, true);
  assert.equal(logs.length, 1);
});

test('postSyncPayload reports the actual reduced size after budget omission', async () => {
  let postedBody = '';
  const logs = [];
  const { payload } = await postSyncPayload(async (_url, options) => {
    postedBody = options.body;
    return { status: 200, ok: true };
  }, 'http://hub/api/ingest', {
    summary: {
      deviceId: 'large-project-list',
      allTime: {
        totalTokens: 1,
        projects: { huge: { label: 'x'.repeat(SYNC_PAYLOAD_BUDGET_BYTES), tokens: 1, clients: { codex: 1 } } }
      }
    },
    logger: (message) => logs.push(message)
  });

  const postedBytes = Buffer.byteLength(postedBody, 'utf8');
  assert.equal(payload.allTimeProjectsOmitted, true);
  assert.equal(logs[0], `all-time project breakdown omitted; payload reduced to ${postedBytes} bytes (budget ${SYNC_PAYLOAD_BUDGET_BYTES})`);
});
