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

test('syncPayload carries OS version metadata to the hub', () => {
  const payload = syncPayload({
    deviceId: 'dev-a',
    osName: 'macOS',
    osVersion: '26.0',
    limits: { providers: [] }
  });

  assert.equal(payload.osName, 'macOS');
  assert.equal(payload.osVersion, '26.0');
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
  const { payload, bytes } = serializeSyncPayload(summary, { maxBytes: 400 });
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

test('serializeSyncPayload keeps totals and projects while bounding large month session detail', () => {
  const sessions = {};
  for (let index = 0; index < 24; index += 1) {
    const key = `codex:session-${String(index).padStart(2, '0')}`;
    sessions[key] = {
      client: 'codex',
      sessionId: `session-${String(index).padStart(2, '0')}`,
      totalTokens: 1000 + index,
      costUsd: index / 100,
      messageCount: 10,
      startedAt: `2026-07-${String(index + 1).padStart(2, '0')}T08:00:00.000Z`,
      lastUsedAt: `2026-07-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
      projectId: 'sha256:project',
      projectLabel: 'Token Monitor',
      models: { 'gpt-5': 1000 + index },
      modelCosts: { 'gpt-5': index / 100 },
      providers: { openai: 1000 + index }
    };
  }
  const todaySessions = { 'codex:today': { client: 'codex', sessionId: 'today', totalTokens: 50 } };
  const summary = {
    deviceId: 'large-month',
    projectsEnabled: true,
    today: { totalTokens: 50, sessions: todaySessions, projects: { today: { label: 'Today', tokens: 50, costUsd: 0, clients: { codex: 50 } } } },
    month: {
      totalTokens: 25000,
      costUsd: 2.76,
      clients: { codex: 25000 },
      models: { 'gpt-5': 25000 },
      sessions,
      projects: { 'token monitor': { label: 'Token Monitor', tokens: 25000, costUsd: 2.76, clients: { codex: 25000 } } }
    },
    allTime: { totalTokens: 50000 }
  };

  const { payload, body, bytes } = serializeSyncPayload(summary, { maxBytes: 3500 });
  const keptKeys = Object.keys(payload.month.sessions);
  const expectedOrder = Object.keys(sessions).reverse();

  assert.ok(bytes <= 3500, `expected ${bytes} bytes to fit the test budget`);
  assert.ok(keptKeys.length > 0 && keptKeys.length < Object.keys(sessions).length);
  assert.deepEqual(keptKeys, expectedOrder.slice(0, keptKeys.length));
  assert.equal(payload.sessionDetailsOmitted.month, Object.keys(sessions).length - keptKeys.length);
  assert.deepEqual(payload.month.projects, summary.month.projects);
  assert.deepEqual(payload.today.sessions, todaySessions);
  assert.equal(payload.month.totalTokens, 25000);
  assert.equal(payload.month.costUsd, 2.76);
  assert.equal(JSON.parse(body).month.totalTokens, 25000);
  assert.equal(Object.keys(summary.month.sessions).length, 24);
});

test('bounded session detail keeps project metadata private when tracking is disabled', () => {
  const sessions = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [
    `codex:s${index}`,
    { client: 'codex', sessionId: `s${index}`, totalTokens: 10, projectId: 'sha256:private', projectLabel: 'Private App', lastUsedAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z` }
  ]));
  const summary = {
    projectsEnabled: false,
    month: { totalTokens: 500, sessions, projects: { private: { label: 'Private App', tokens: 500, clients: { codex: 500 } } } }
  };

  const { payload, bytes } = serializeSyncPayload(summary, { maxBytes: 1500 });

  assert.ok(bytes <= 1500);
  assert.ok(payload.sessionDetailsOmitted.month > 0);
  assert.equal(Object.hasOwn(payload.month, 'projects'), false);
  for (const session of Object.values(payload.month.sessions)) {
    assert.equal(Object.hasOwn(session, 'projectId'), false);
    assert.equal(Object.hasOwn(session, 'projectLabel'), false);
  }
  assert.equal(summary.month.sessions['codex:s0'].projectLabel, 'Private App');
});

test('serializeSyncPayload omits an oversized period project rollup as a final fallback', () => {
  const sessions = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `codex:s${index}`,
    { client: 'codex', sessionId: `s${index}`, totalTokens: 100, lastUsedAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, projectId: `sha256:p${index}`, projectLabel: `Project ${index}` }
  ]));
  const projects = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
    `project-${index}`,
    { label: `Project ${index} ${'x'.repeat(256)}`, tokens: 100, costUsd: 0.1, clients: { codex: 100 } }
  ]));
  const summary = {
    deviceId: 'many-projects',
    month: { totalTokens: 2000, costUsd: 2, clients: { codex: 2000 }, sessions, projects },
    allTime: { totalTokens: 2000 }
  };

  const { payload, bytes } = serializeSyncPayload(summary, { maxBytes: 2200 });

  assert.ok(bytes <= 2200, `expected ${bytes} bytes to fit the test budget`);
  assert.equal(payload.month.totalTokens, 2000);
  assert.equal(payload.month.costUsd, 2);
  assert.equal(Object.hasOwn(payload.month, 'projects'), false);
  assert.equal(payload.periodProjectsOmitted.month, 30);
  assert.ok(payload.sessionDetailsOmitted.month > 0);
  assert.equal(Object.keys(summary.month.projects).length, 30);
});

test('postSyncPayload reports omitted session detail without changing period totals', async () => {
  const sessions = Object.fromEntries(Array.from({ length: 2600 }, (_, index) => [
    `claude:s${index}`,
    { client: 'claude', sessionId: `s${index}`, totalTokens: 100, lastUsedAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`, projectId: 'sha256:large', projectLabel: 'x'.repeat(256), models: { opus: 100 } }
  ]));
  const logs = [];
  let posted;
  const { response, payload } = await postSyncPayload(async (_url, options) => {
    posted = JSON.parse(options.body);
    return { status: 200, ok: true };
  }, 'http://hub/api/ingest', {
    summary: {
      deviceId: 'large',
      month: { totalTokens: 260000, sessions, projects: { large: { label: 'Large', tokens: 260000, costUsd: 0, clients: { claude: 260000 } } } },
      allTime: { totalTokens: 260000 }
    },
    logger: (message) => logs.push(message)
  });

  assert.equal(response.ok, true);
  assert.equal(posted.month.totalTokens, 260000);
  assert.ok(Buffer.byteLength(JSON.stringify(posted), 'utf8') <= SYNC_PAYLOAD_BUDGET_BYTES);
  assert.deepEqual(posted.sessionDetailsOmitted, payload.sessionDetailsOmitted);
  assert.ok(payload.sessionDetailsOmitted.month > 0);
  assert.match(logs.at(-1), /^session detail omitted for sync \(month: \d+\)/);
});
