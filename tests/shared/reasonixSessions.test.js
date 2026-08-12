'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createReasonixNativeSessionCache,
  isReasonixNativeSessionPath,
  isReasonixNativeSessionSidecar,
  readReasonixNativeSession,
  REASONIX_META_MAX_BYTES,
  REASONIX_TELEMETRY_USAGE_MAX_BYTES,
  reasonixNativeSessionWatchRoots
} = require('../../src/shared/reasonixSessions');
const {
  readReasonixTelemetryUsage,
  REASONIX_TELEMETRY_TAIL_OVERHEAD_BYTES
} = require('../../src/shared/reasonixFileIo');
const { collectUsageOnce, projectIdentity, watchIgnoreMatcher, watchPathsForClients } = require('../../src/shared/collector');
const { syncPayload } = require('../../src/shared/syncPayload');
const { createDeviceState } = require('../../src/shared/deviceState');
const { captureSessionUsageArchive } = require('../../src/shared/sessionUsageArchive');
const { projectRowsForPeriod } = require('../../src/electron/renderer/projectRows');
const { sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');
const { composeLocalSyncStats } = require('../../src/electron/syncDisplayStats');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function paddedJson(value, size) {
  const json = Buffer.from(JSON.stringify(value));
  assert.ok(json.length <= size);
  return Buffer.concat([json, Buffer.alloc(size - json.length, 0x20)]);
}

function sidecars(directory, id, meta, telemetry) {
  const metaPath = path.join(directory, `${id}.jsonl.meta`);
  const telemetryPath = path.join(directory, `${id}.jsonl.telemetry.json`);
  if (meta !== undefined) writeJson(metaPath, meta);
  if (telemetry !== undefined) writeJson(telemetryPath, telemetry);
  return { metaPath, telemetryPath };
}

function cacheFor(stateHome, projectIdentity, allTimeSince) {
  return createReasonixNativeSessionCache({
    env: { REASONIX_STATE_HOME: stateHome },
    homeDir: path.dirname(stateHome),
    platform: process.platform,
    cwdDir: path.dirname(stateHome),
    projectIdentity,
    allTimeSince
  });
}

function localDateIso(date, dayOffset = 0) {
  const value = new Date(date);
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + dayOffset);
  return value.toISOString();
}

function nativeTelemetry(overrides = {}) {
  return {
    promptTokens: 80,
    completionTokens: 30,
    reasoningTokens: 10,
    totalTokens: 140,
    cacheHitTokens: 20,
    cacheMissTokens: 80,
    cacheWriteTokens: 0,
    requestCount: 7,
    sessionCostUsd: 0.25,
    ...overrides
  };
}

test('Reasonix native adapter reads official cumulative telemetry without inventing message counts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-'));
  const stateHome = path.join(root, 'state');
  const globalDir = path.join(stateHome, 'sessions');
  const routedDir = path.join(stateHome, 'projects', 'token-monitor', 'sessions');
  const workspaceRoot = path.join(root, 'workspaces', 'token-monitor');
  sidecars(globalDir, 'global-id', {
    id: 'global-id',
    created_at: '2026-08-07T03:00:00.000Z',
    updated_at: '2026-08-08T03:00:00.000Z',
    scope: 'global',
    topic_id: 'topic-1',
    topic_title: 'Automatic topic',
    custom_title: 'My Reasonix session',
    model: 'deepseek/deepseek-v4-flash',
    turns: 4,
    preview: 'preview text',
    schema_version: 1,
    parent_id: 'parent-id',
    fork_turn: 2,
    fork_message_index: 8,
    workspace_root: '/must-not-be-used-for-global-project'
  }, nativeTelemetry());
  sidecars(routedDir, 'project-id', {
    id: 'project-id',
    created_at: '2026-08-08T02:00:00.000Z',
    updated_at: '2026-08-08T04:00:00.000Z',
    scope: 'project',
    workspace_root: workspaceRoot,
    topic_title: 'Topic fallback',
    model: 'deepseek/deepseek-v4-pro',
    turns: 3,
    schema_version: 1
  }, nativeTelemetry({ totalTokens: 141, sessionCostUsd: 0.5, requestCount: 9 }));
  sidecars(globalDir, 'preview-id', {
    id: 'preview-id',
    created_at: '2026-08-08T05:00:00.000Z',
    updated_at: '2026-08-08T05:00:00.000Z',
    schema_version: 1,
    preview: 'Preview fallback'
  }, nativeTelemetry({ totalTokens: 1 }));
  sidecars(globalDir, 'name-id', {
    id: 'name-id',
    created_at: '2026-08-08T05:30:00.000Z',
    updated_at: '2026-08-08T05:30:00.000Z',
    name: 'Official branch name'
  }, nativeTelemetry({ totalTokens: 2 }));
  sidecars(globalDir, 'missing-id', { preview: 'skip this' }, nativeTelemetry());
  sidecars(globalDir, 'corrupt-meta', '{not-json', nativeTelemetry());
  sidecars(globalDir, 'corrupt-telemetry', { id: 'corrupt-telemetry' }, '{not-json');
  fs.writeFileSync(path.join(globalDir, 'project-id.jsonl.events.jsonl'), '{"shouldNot":"beRead"}\n');
  fs.writeFileSync(path.join(globalDir, 'project-id.event-index.json'), JSON.stringify({ offsets: [1] }));

  const cache = cacheFor(stateHome, projectIdentity);
  const view = cache.getView({ now: new Date('2026-08-08T12:00:00.000Z') });
  const allTime = view.sessions.allTime;

  assert.deepEqual(Object.keys(allTime).sort(), [
    'reasonix:global-id',
    'reasonix:name-id',
    'reasonix:preview-id',
    'reasonix:project-id'
  ]);
  assert.equal(allTime['reasonix:global-id'].title, 'My Reasonix session');
  assert.equal(allTime['reasonix:global-id'].model, 'deepseek-v4-flash');
  assert.deepEqual(allTime['reasonix:global-id'].models, { 'deepseek-v4-flash': 140 });
  assert.equal(allTime['reasonix:name-id'].title, 'Official branch name');
  assert.equal(allTime['reasonix:project-id'].title, 'Topic fallback');
  assert.equal(allTime['reasonix:preview-id'].title, 'Preview fallback');
  assert.equal(allTime['reasonix:project-id'].totalTokens, 141);
  assert.equal(allTime['reasonix:project-id'].reasoningTokens, 10);
  assert.equal(allTime['reasonix:project-id'].completionTokens, 30);
  assert.equal(allTime['reasonix:project-id'].requestCount, 9);
  assert.equal(Object.hasOwn(allTime['reasonix:project-id'], 'messageCount'), false);
  assert.equal(allTime['reasonix:project-id'].projectLabel, 'token-monitor');
  assert.equal(view.projects.allTime['token-monitor'].tokens, 141);
  assert.equal(view.projects.allTime['token-monitor'].clients.reasonix, 141);
  assert.deepEqual(view.projects.allTime['token-monitor'].sessionIds, ['reasonix:project-id']);
  assert.equal(JSON.stringify(view).includes(stateHome), false);
  assert.equal(JSON.stringify(view).includes(workspaceRoot), false);
});

test('Reasonix native adapter derives msg count from the trusted official transcript and leaves tokens unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-events-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'sessions');
  const metaPath = path.join(sessionsDir, 'official.jsonl.meta');
  const eventsPath = path.join(sessionsDir, 'official.events.jsonl');
  writeJson(metaPath, {
    BranchMeta: { ID: 'branch-from-official-meta' },
    schema_version: 1,
    created_at: '2026-08-08T09:00:00.000Z',
    updated_at: '2026-08-08T09:02:00.000Z',
    model: 'deepseek/deepseek-v4-flash'
  });
  fs.writeFileSync(eventsPath, `${JSON.stringify({
    schema_version: 1,
    type: 'replace',
    created_at: '2026-08-08T09:00:00.000Z',
    messages: [
      { role: 'user', raw_content: 'first', createdAt: 1786179601000 },
      { role: 'assistant', createdAt: 1786179602000, tool_calls: [{ name: 'search' }] },
      { role: 'tool', name: 'search', createdAt: 1786179602500 },
      { role: 'assistant', createdAt: 1786179603000 }
    ]
  })}\n`);

  const session = readReasonixNativeSession(metaPath, undefined, { eventPath: eventsPath });
  assert.equal(session.sessionId, 'reasonix:branch-from-official-meta');
  assert.equal(session.messageCount, 2);
  assert.equal(session.tokenDataUnavailable, true);
  assert.equal(session.sessionDetailAvailable, false);
  assert.equal(Object.hasOwn(session, 'totalTokens'), false);
  assert.equal(JSON.stringify(session).includes(root), false);

  const view = cacheFor(stateHome, projectIdentity).getView({ now: new Date(2026, 7, 8, 12, 0, 0) });
  assert.equal(view.sessions.today['reasonix:branch-from-official-meta'].messageCount, 2);
  assert.equal(Object.hasOwn(view.projects.today, 'token-monitor'), false);
});

test('Reasonix resumed sessions use the latest trusted event message for live periods', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-resumed-events-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'projects', '-home-global-workspace', 'sessions');
  const id = 'resumed-with-events';
  const paths = sidecars(sessionsDir, id, {
    id,
    schema_version: 1,
    created_at: '2026-08-08T13:00:00.000Z',
    updated_at: '2026-08-09T03:00:00.000Z',
    scope: 'global',
    model: 'deepseek-flash/deepseek-v4-flash'
  }, nativeTelemetry({ totalTokens: 320 }));
  const eventPath = path.join(sessionsDir, `${id}.events.jsonl`);
  fs.writeFileSync(eventPath, [
    {
      schema_version: 1,
      type: 'replace',
      created_at: '2026-08-08T13:00:00.000Z',
      messages: [
        { role: 'user', raw_content: '昨天的输入', content: '<reasoning-language>内部包装</reasoning-language>昨天的输入', createdAt: Date.parse('2026-08-08T13:00:00.000Z') },
        { role: 'assistant', createdAt: Date.parse('2026-08-08T13:00:01.000Z') }
      ]
    },
    {
      schema_version: 1,
      type: 'append',
      message_index: 2,
      created_at: '2026-08-09T03:00:00.000Z',
      messages: [
        { role: 'user', raw_content: '今天继续', createdAt: Date.parse('2026-08-09T03:00:00.000Z') },
        { role: 'assistant' }
      ]
    }
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');

  const session = readReasonixNativeSession(paths.metaPath, paths.telemetryPath, { eventPath });
  assert.equal(session.lastMessageAt, '2026-08-09T03:00:00.000Z');
  assert.equal(session.model, 'deepseek-v4-flash');
  assert.equal(session.reportedCostUsd, 0.25);
  assert.equal(session.sessionDetailAvailable, false);

  const view = cacheFor(stateHome, projectIdentity).getView({
    now: new Date('2026-08-09T12:00:00.000Z')
  });
  assert.ok(view.sessions.today[`reasonix:${id}`]);
  assert.ok(view.sessions.month[`reasonix:${id}`]);
  assert.ok(view.sessions.allTime[`reasonix:${id}`]);
  assert.equal(view.sessions.today[`reasonix:${id}`].periodTokenDataUnavailable, true);
  assert.notEqual(view.sessions.today[`reasonix:${id}`].tokenDataUnavailable, true);
  assert.equal(view.sessions.today[`reasonix:${id}`].totalTokens, 320);
  assert.equal(view.sessions.today[`reasonix:${id}`].reportedCostUsd, 0.25);
  assert.notEqual(view.sessions.month[`reasonix:${id}`].periodTokenDataUnavailable, true);
  assert.equal(view.sessions.month[`reasonix:${id}`].totalTokens, 320);
  assert.notEqual(view.sessions.allTime[`reasonix:${id}`].periodTokenDataUnavailable, true);
});

test('Reasonix native period attribution falls back to created_at without message timestamps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-periods-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'sessions');
  const now = new Date(2026, 7, 8, 12, 0, 0, 0);
  const workspaceRoot = path.join(root, 'workspace');
  const projectIdentity = () => ({ projectId: 'opaque-project', projectLabel: 'token-monitor' });

  sidecars(sessionsDir, 'new-today', {
    id: 'new-today',
    created_at: localDateIso(now),
    updated_at: localDateIso(now),
    scope: 'project',
    workspace_root: workspaceRoot,
    schema_version: 1
  }, nativeTelemetry({ totalTokens: 30621 }));
  sidecars(sessionsDir, 'resumed', {
    id: 'resumed',
    created_at: localDateIso(now, -1),
    updated_at: localDateIso(now),
    scope: 'project',
    workspace_root: workspaceRoot,
    schema_version: 1
  }, nativeTelemetry({ totalTokens: 110000 }));
  const previousMonth = new Date(now);
  previousMonth.setDate(1);
  previousMonth.setMonth(previousMonth.getMonth() - 1);
  sidecars(sessionsDir, 'cross-month', {
    id: 'cross-month',
    created_at: localDateIso(previousMonth),
    updated_at: localDateIso(now),
    scope: 'project',
    workspace_root: workspaceRoot,
    schema_version: 1
  }, nativeTelemetry({ totalTokens: 220000 }));

  const cache = cacheFor(stateHome, projectIdentity, '2026-01-01');
  const view = cache.getView({ now });
  const projectKey = 'token-monitor';

  assert.deepEqual(Object.keys(view.sessions.today), ['reasonix:new-today']);
  assert.deepEqual(Object.keys(view.sessions.month).sort(), ['reasonix:new-today', 'reasonix:resumed']);
  assert.deepEqual(Object.keys(view.sessions.allTime).sort(), [
    'reasonix:cross-month',
    'reasonix:new-today',
    'reasonix:resumed'
  ]);
  assert.equal(view.projects.today[projectKey].tokens, 30621);
  assert.equal(view.projects.month[projectKey].tokens, 140621);
  assert.equal(view.projects.allTime[projectKey].tokens, 360621);
  assert.equal(view.projects.today[projectKey].costUsd, 0);
});

test('Reasonix allTimeSince conservatively excludes sessions created before the boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-boundary-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'sessions');
  const now = new Date(2026, 7, 8, 12, 0, 0, 0);
  const beforeBoundary = new Date(2026, 6, 31, 12, 0, 0, 0);
  sidecars(sessionsDir, 'before-boundary', {
    id: 'before-boundary',
    created_at: beforeBoundary.toISOString(),
    updated_at: localDateIso(now),
    schema_version: 1
  }, nativeTelemetry({ totalTokens: 900 }));
  sidecars(sessionsDir, 'after-boundary', {
    id: 'after-boundary',
    created_at: localDateIso(now),
    updated_at: localDateIso(now),
    schema_version: 1
  }, nativeTelemetry({ totalTokens: 1000 }));

  const cache = cacheFor(stateHome, projectIdentity);
  const view = cache.getView({ now, allTimeSince: '2026-08-01' });
  assert.deepEqual(Object.keys(view.sessions.allTime), ['reasonix:after-boundary']);
  assert.equal(view.sessions.month['reasonix:after-boundary'].totalTokens, 1000);
  assert.equal(Object.hasOwn(view.sessions.month, 'reasonix:before-boundary'), false);
});

test('Reasonix rename/update does not move an old cumulative session into today', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-rename-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'sessions');
  const now = new Date(2026, 7, 8, 12, 0, 0, 0);
  const paths = sidecars(sessionsDir, 'renamed', {
    id: 'renamed',
    created_at: localDateIso(now, -1),
    updated_at: localDateIso(now, -1),
    custom_title: 'Before rename',
    schema_version: 1
  }, nativeTelemetry({ totalTokens: 110000 }));
  const cache = cacheFor(stateHome, projectIdentity);

  assert.equal(Object.hasOwn(cache.getView({ now }).sessions.today, 'reasonix:renamed'), false);
  fs.writeFileSync(paths.metaPath, JSON.stringify({
    id: 'renamed',
    created_at: localDateIso(now, -1),
    updated_at: localDateIso(now),
    custom_title: 'After rename',
    schema_version: 1
  }));
  cache.invalidate(paths.metaPath);
  const view = cache.getView({ now });
  assert.equal(Object.hasOwn(view.sessions.today, 'reasonix:renamed'), false);
  assert.equal(view.sessions.allTime['reasonix:renamed'].title, 'After rename');
});

test('Reasonix telemetry cost is USD-only and never contributes generic project cost', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-cost-'));
  const workspaceRoot = path.join(root, 'workspace');
  const make = (id, usage) => {
    const paths = sidecars(root, id, {
      id,
      created_at: '2026-08-08T00:00:00.000Z',
      scope: 'project',
      workspace_root: workspaceRoot,
      schema_version: 1
    }, usage);
    return readReasonixNativeSession(paths.metaPath, paths.telemetryPath, {
      projectIdentity: () => ({ projectId: 'opaque', projectLabel: 'Token Monitor' })
    });
  };

  const explicitUsd = make('explicit-usd', nativeTelemetry({ sessionCostUsd: 1.25 }));
  const cny = make('cny', nativeTelemetry({ sessionCostUsd: undefined, sessionCost: 99, sessionCurrency: 'CNY' }));
  const inferredUsd = make('inferred-usd', nativeTelemetry({ sessionCostUsd: undefined, sessionCost: 2.5, sessionCurrency: 'USD' }));
  assert.equal(explicitUsd.reportedCostUsd, 1.25);
  assert.equal(Object.hasOwn(cny, 'reportedCostUsd'), false);
  assert.equal(inferredUsd.reportedCostUsd, 2.5);
});

test('Reasonix schema_version gates turns and preview listing fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-schema-'));
  const make = (id, schemaVersion) => {
    const paths = sidecars(root, id, {
      id,
      schema_version: schemaVersion,
      turns: 7,
      preview: 'stale preview must not be used',
      created_at: '2026-08-08T00:00:00.000Z'
    }, nativeTelemetry());
    return readReasonixNativeSession(paths.metaPath, paths.telemetryPath);
  };

  const legacy = make('legacy', 0);
  const trusted = make('trusted', 1);
  assert.equal(legacy.title, 'Reasonix Session');
  assert.equal(Object.hasOwn(legacy, 'turns'), false);
  assert.equal(Object.hasOwn(legacy, 'preview'), false);
  assert.equal(legacy.schemaVersion, 0);
  assert.equal(trusted.title, 'stale preview must not be used');
  assert.equal(trusted.turns, 7);
  assert.equal(trusted.preview, 'stale preview must not be used');
});

test('Reasonix scanner keeps same-stem sidecars from different routed projects separate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-stems-'));
  const stateHome = path.join(root, 'state');
  const projectA = path.join(stateHome, 'projects', 'a', 'sessions');
  const projectB = path.join(stateHome, 'projects', 'b', 'sessions');
  const common = { created_at: '2026-08-08T00:00:00.000Z', schema_version: 1 };
  sidecars(projectA, 'same', { ...common, id: 'project-a' }, nativeTelemetry({ totalTokens: 11 }));
  sidecars(projectB, 'same', { ...common, id: 'project-b' }, nativeTelemetry({ totalTokens: 22 }));

  const view = cacheFor(stateHome, projectIdentity).getView({ now: new Date(2026, 7, 8, 12, 0, 0, 0) });
  assert.equal(view.sessions.allTime['reasonix:project-a'].totalTokens, 11);
  assert.equal(view.sessions.allTime['reasonix:project-b'].totalTokens, 22);
});

test('Reasonix native telemetry uses direct total, skips invalid sidecars, and invalidates on update/delete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-cache-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'sessions');
  const paths = sidecars(sessionsDir, 'stable-id', {
    id: 'stable-id',
    created_at: '2026-08-08T02:00:00.000Z',
    updated_at: '2026-08-08T03:00:00.000Z',
    custom_title: 'Before rename'
  }, nativeTelemetry({ totalTokens: 140, promptTokens: 1, completionTokens: 2, reasoningTokens: 99 }));
  const cache = cacheFor(stateHome, () => ({}));
  const now = new Date('2026-08-08T12:00:00.000Z');

  let view = cache.getView({ now });
  assert.equal(view.sessions.allTime['reasonix:stable-id'].totalTokens, 140);
  assert.equal(view.sessions.allTime['reasonix:stable-id'].reasoningTokens, 99);
  assert.equal(view.sessions.allTime['reasonix:stable-id'].completionTokens, 2);
  assert.equal(cache.isDirty(), false);

  fs.writeFileSync(paths.metaPath, JSON.stringify({
    id: 'stable-id',
    created_at: '2026-08-08T02:00:00.000Z',
    updated_at: '2026-08-08T04:00:00.000Z',
    custom_title: 'After rename'
  }));
  cache.invalidate(paths.metaPath);
  view = cache.getView({ now });
  assert.equal(view.sessions.allTime['reasonix:stable-id'].title, 'After rename');

  fs.rmSync(paths.metaPath);
  fs.rmSync(paths.telemetryPath);
  cache.invalidate(paths.metaPath);
  view = cache.getView({ now });
  assert.equal(Object.hasOwn(view.sessions.allTime, 'reasonix:stable-id'), false);
});

test('Reasonix native cache discovers a session root created after an empty scan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-root-discovery-'));
  const stateHome = path.join(root, 'state');
  const projectSessionsDir = path.join(stateHome, 'projects', 'token-monitor', 'sessions');
  const workspaceRoot = path.join(root, 'workspace');
  const now = new Date(2026, 7, 8, 12, 0, 0, 0);
  let projectIdentityCalls = 0;
  const projectIdentityForTest = (workspace) => {
    projectIdentityCalls += 1;
    assert.equal(workspace, workspaceRoot);
    return { projectId: 'token-monitor-project', projectLabel: 'Token Monitor' };
  };
  const cache = cacheFor(stateHome, projectIdentityForTest);

  assert.equal(fs.existsSync(projectSessionsDir), false);
  let view = cache.getView({ now });
  assert.deepEqual(Object.keys(view.sessions.allTime), []);
  assert.deepEqual(Object.keys(view.projects.allTime), []);
  assert.equal(cache.isDirty(), false);

  const sessionTime = new Date(2026, 7, 8, 10, 0, 0, 0);
  const paths = sidecars(projectSessionsDir, 'created-after-empty', {
    id: 'created-after-empty',
    scope: 'project',
    workspace_root: workspaceRoot,
    schema_version: 1,
    created_at: sessionTime.toISOString(),
    updated_at: sessionTime.toISOString(),
    model: 'deepseek/deepseek-v4-flash'
  }, nativeTelemetry({ totalTokens: 321 }));
  const eventsPath = path.join(projectSessionsDir, 'created-after-empty.events.jsonl');
  fs.writeFileSync(eventsPath, `${JSON.stringify({
    schema_version: 1,
    type: 'replace',
    created_at: sessionTime.toISOString(),
    messages: [
      { role: 'user', raw_content: 'create the project', createdAt: sessionTime.getTime() },
      { role: 'assistant', createdAt: sessionTime.getTime() + 1000 }
    ]
  })}\n`);

  view = cache.getView({ now });
  const session = view.sessions.today['reasonix:created-after-empty'];
  assert.ok(session);
  assert.equal(session.sessionId, 'reasonix:created-after-empty');
  assert.equal(session.totalTokens, 321);
  assert.equal(session.messageCount, 1);
  assert.equal(session.projectLabel, 'Token Monitor');
  assert.equal(view.projects.today['token monitor'].tokens, 321);
  assert.deepEqual(view.projects.today['token monitor'].sessionIds, ['reasonix:created-after-empty']);
  assert.equal(cache.isDirty(), false);
  assert.equal(JSON.stringify(view).includes(stateHome), false);
  assert.equal(JSON.stringify(view).includes(workspaceRoot), false);
  assert.equal(fs.existsSync(paths.metaPath), true);

  const scansAfterDiscovery = projectIdentityCalls;
  const cachedView = cache.getView({ now });
  assert.equal(cachedView, view);
  assert.equal(projectIdentityCalls, scansAfterDiscovery);
});

test('Reasonix native cache refreshes sidecar candidates without explicit invalidation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-candidate-refresh-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'sessions');
  const now = new Date(2026, 7, 8, 12, 0, 0, 0);
  const cache = cacheFor(stateHome, () => ({}));

  let view = cache.getView({ now });
  assert.deepEqual(Object.keys(view.sessions.allTime), []);

  const added = sidecars(sessionsDir, 'added', {
    id: 'added',
    created_at: '2026-08-08T02:00:00.000Z'
  }, nativeTelemetry({ totalTokens: 11 }));
  view = cache.getView({ now });
  assert.equal(view.sessions.allTime['reasonix:added'].totalTokens, 11);

  fs.rmSync(added.telemetryPath);
  view = cache.getView({ now });
  assert.equal(Object.hasOwn(view.sessions.allTime, 'reasonix:added'), false);

  const before = sidecars(sessionsDir, 'before-rename', {
    id: 'before-rename',
    created_at: '2026-08-08T03:00:00.000Z'
  }, nativeTelemetry({ totalTokens: 22 }));
  view = cache.getView({ now });
  assert.equal(view.sessions.allTime['reasonix:before-rename'].totalTokens, 22);

  const afterMetaPath = path.join(sessionsDir, 'after-rename.jsonl.meta');
  const afterTelemetryPath = path.join(sessionsDir, 'after-rename.jsonl.telemetry.json');
  fs.renameSync(before.metaPath, afterMetaPath);
  fs.renameSync(before.telemetryPath, afterTelemetryPath);
  fs.writeFileSync(afterMetaPath, JSON.stringify({
    id: 'after-rename',
    created_at: '2026-08-08T03:00:00.000Z'
  }));
  view = cache.getView({ now });
  assert.equal(Object.hasOwn(view.sessions.allTime, 'reasonix:before-rename'), false);
  assert.equal(view.sessions.allTime['reasonix:after-rename'].totalTokens, 22);

  const eventOnlyMetaPath = path.join(sessionsDir, 'event-only.jsonl.meta');
  const eventOnlyPath = path.join(sessionsDir, 'event-only.events.jsonl');
  writeJson(eventOnlyMetaPath, { id: 'event-only', created_at: '2026-08-08T04:00:00.000Z' });
  fs.writeFileSync(eventOnlyPath, `${JSON.stringify({
    schema_version: 1,
    type: 'replace',
    messages: [{ role: 'assistant' }]
  })}\n`);
  view = cache.getView({ now });
  assert.equal(view.sessions.allTime['reasonix:event-only'].messageCount, 1);
  fs.rmSync(eventOnlyPath);
  view = cache.getView({ now });
  assert.equal(Object.hasOwn(view.sessions.allTime, 'reasonix:event-only'), false);
});

test('Reasonix native cache negative-caches unchanged fail-closed candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-negative-cache-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'sessions');
  const metaPath = path.join(sessionsDir, 'broken.jsonl.meta');
  const eventsPath = path.join(sessionsDir, 'broken.events.jsonl');
  const now = new Date(2026, 7, 8, 12, 0, 0, 0);
  writeJson(metaPath, {
    id: 'broken',
    created_at: '2026-08-08T02:00:00.000Z'
  });
  fs.writeFileSync(eventsPath, '{"schema_version":1,"type":"replace","messages":[\n');

  const cache = cacheFor(stateHome, () => ({}));
  const originalOpenSync = fs.openSync;
  let replayReads = 0;
  fs.openSync = function openSync(filePath, ...args) {
    if (String(filePath) === eventsPath) replayReads += 1;
    return originalOpenSync.call(this, filePath, ...args);
  };

  try {
    let view = cache.getView({ now });
    assert.equal(Object.hasOwn(view.sessions.allTime, 'reasonix:broken'), false);
    assert.equal(replayReads, 1);

    view = cache.getView({ now });
    assert.equal(Object.hasOwn(view.sessions.allTime, 'reasonix:broken'), false);
    assert.equal(replayReads, 1, 'an unchanged fail-closed candidate should not replay again');

    cache.invalidate(eventsPath);
    view = cache.getView({ now });
    assert.equal(Object.hasOwn(view.sessions.allTime, 'reasonix:broken'), false);
    assert.equal(replayReads, 2, 'event invalidation should force a replay of the same signature');

    fs.writeFileSync(eventsPath, `${JSON.stringify({
      schema_version: 1,
      type: 'replace',
      messages: [{ role: 'assistant' }]
    })}\n`);
    view = cache.getView({ now });
    assert.equal(replayReads, 3, 'a changed event signature should retry replay');
    assert.equal(view.sessions.allTime['reasonix:broken'].messageCount, 1);
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test('Reasonix event updates invalidate only the corresponding native session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-event-cache-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'sessions');
  const first = sidecars(sessionsDir, 'first', {
    id: 'first',
    created_at: '2026-08-08T02:00:00.000Z'
  }, nativeTelemetry({ totalTokens: 10 }));
  const second = sidecars(sessionsDir, 'second', {
    id: 'second',
    created_at: '2026-08-08T02:00:00.000Z'
  }, nativeTelemetry({ totalTokens: 20 }));
  const firstEvents = path.join(sessionsDir, 'first.events.jsonl');
  const secondEvents = path.join(sessionsDir, 'second.events.jsonl');
  const snapshot = (assistantCount) => JSON.stringify({
    schema_version: 1,
    type: 'replace',
    created_at: '2026-08-08T02:00:00.000Z',
    messages: [
      { role: 'user', raw_content: 'prompt' },
      ...Array.from({ length: assistantCount }, (_, index) => ({ role: 'assistant', createdAt: `2026-08-08T02:00:0${index + 1}.000Z` }))
    ]
  });
  fs.writeFileSync(firstEvents, `${snapshot(1)}\n`);
  fs.writeFileSync(secondEvents, `${snapshot(1)}\n`);

  const cache = cacheFor(stateHome, () => ({}));
  const now = new Date('2026-08-08T12:00:00.000Z');
  let view = cache.getView({ now });
  assert.equal(view.sessions.allTime['reasonix:first'].messageCount, 1);
  assert.equal(view.sessions.allTime['reasonix:second'].messageCount, 1);

  fs.writeFileSync(firstEvents, `${snapshot(2)}\n`);
  cache.invalidate(firstEvents);
  assert.equal(cache.isDirty(), false, 'an events update should not dirty the whole native scan');
  view = cache.getView({ now });
  assert.equal(view.sessions.allTime['reasonix:first'].messageCount, 2);
  assert.equal(view.sessions.allTime['reasonix:second'].messageCount, 1);
  assert.equal(fs.existsSync(first.metaPath), true);
  assert.equal(fs.existsSync(second.metaPath), true);
});

test('Reasonix native watcher roots share the resolved state home and keep stats/events live', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'reasonix-native-watch-'));
  const stateHome = path.join(root, 'state');
  const statsDir = path.join(stateHome, 'stats');
  const sessionsDir = path.join(stateHome, 'sessions');
  const projectsDir = path.join(stateHome, 'projects');
  fs.mkdirSync(statsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  const previous = process.env.REASONIX_STATE_HOME;
  process.env.REASONIX_STATE_HOME = stateHome;
  try {
    const roots = reasonixNativeSessionWatchRoots({ env: process.env, homeDir: root, platform: process.platform, cwdDir: root });
    assert.deepEqual(roots, [sessionsDir, projectsDir]);
    assert.equal(isReasonixNativeSessionPath(path.join(sessionsDir, 'a.jsonl.meta'), roots), true);
    assert.equal(isReasonixNativeSessionSidecar('a.jsonl.meta'), true);
    assert.equal(isReasonixNativeSessionSidecar('a.events.jsonl'), true);

    const ignored = watchIgnoreMatcher('reasonix');
    assert.equal(typeof ignored, 'function');
    assert.equal(ignored(path.join(sessionsDir, 'a.jsonl.meta')), false);
    assert.equal(ignored(path.join(sessionsDir, 'a.jsonl.telemetry.json')), false);
    assert.equal(ignored(path.join(sessionsDir, 'a.events.jsonl')), false);
    assert.equal(ignored(path.join(sessionsDir, 'a.event-index.json')), true);
    assert.equal(ignored(sessionsDir), false);
    assert.deepEqual(watchPathsForClients('reasonix').sort(), [statsDir, projectsDir, sessionsDir].sort());
  } finally {
    if (previous === undefined) delete process.env.REASONIX_STATE_HOME;
    else process.env.REASONIX_STATE_HOME = previous;
  }
});

test('Reasonix native view stays outside aggregate, history, archive and sync payloads', async () => {
  const nativeSession = {
    native: true,
    client: 'reasonix',
    sessionId: 'reasonix:native-id',
    title: 'Native session',
    totalTokens: 999,
    reportedCostUsd: 3,
    messageCount: 0,
    lastUsedAt: '2026-08-08T03:00:00.000Z',
    models: { 'deepseek-v4': 999 }
  };
  const nativeView = {
    sessions: { today: { [nativeSession.sessionId]: nativeSession }, month: {}, allTime: { [nativeSession.sessionId]: nativeSession } },
    projects: { today: {}, month: {}, allTime: {} }
  };
  let capturedAnchor;
  const nativeCache = {
    getView: (options) => {
      assert.equal(options.allTimeSince, '2026-01-01');
      return nativeView;
    }
  };
  let tokScaleCalls = 0;
  const runTokscale = async ({ clients }) => {
    tokScaleCalls += 1;
    assert.equal(clients, 'reasonix');
    return { entries: [{
      client: 'reasonix',
      sessionId: 'reasonix-stats:/Users/test/.reasonix/stats/2026-08-08.jsonl',
      model: 'deepseek-v4',
      input: 80,
      output: 30,
      cacheRead: 20,
      reasoning: 10,
      cost: 0.25
    }] };
  };
  const summary = await collectUsageOnce({
    clients: 'reasonix',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'native-test',
    runTokscale,
    platform: 'linux',
    historyEnabled: false,
    wslScanEnabled: false,
    reasonixNativeSessionsEnabled: true,
    reasonixNativeSessionCache: nativeCache,
    onAnchorComputed: (capture) => { capturedAnchor = capture; }
  });

  assert.equal(summary.today.totalTokens, 140);
  assert.equal(tokScaleCalls, 3);
  assert.equal(summary.today.costUsd, 0.25);
  assert.equal(summary.today.clients.reasonix, 140);
  assert.deepEqual(summary.today.sessions, {});
  assert.equal(summary.nativeSessions.today[nativeSession.sessionId].totalTokens, 999);
  assert.deepEqual(capturedAnchor.nativeSessions, nativeView.sessions);
  assert.deepEqual(capturedAnchor.nativeProjects, nativeView.projects);
  assert.equal(summary.history, null);
  const archive = captureSessionUsageArchive({}, {
    nativeSessions: summary.nativeSessions,
    today: { sessions: {} },
    month: { sessions: {} },
    allTime: { sessions: {} }
  }, new Date(summary.updatedAt));
  assert.deepEqual(archive.sessions, {});

  const payload = syncPayload(summary);
  assert.equal(Object.hasOwn(payload, 'nativeSessions'), false);
  assert.equal(Object.hasOwn(payload, 'nativeProjects'), false);
  assert.doesNotMatch(JSON.stringify(payload), /Native session|reasonix:native-id/);

  const displayStats = composeLocalSyncStats(null, {
    deviceId: 'native-test',
    updatedAt: summary.updatedAt,
    receivedAt: summary.updatedAt,
    today: summary.today,
    month: summary.month,
    allTime: summary.allTime,
    nativeSessions: summary.nativeSessions,
    nativeProjects: summary.nativeProjects
  });
  assert.equal(displayStats.periods.today.totalTokens, 140);
  assert.equal(displayStats.nativeSessions.today[nativeSession.sessionId].totalTokens, 999);

  const records = [];
  const deviceState = createDeviceState({ onRecord: (record) => records.push(record) });
  deviceState.updateUsage({ month: {}, allTime: {}, nativeSessions: nativeView.sessions, nativeProjects: nativeView.projects });
  deviceState.updateUsage({ today: {} }, 'preview', { preview: true });
  assert.equal(records.at(-1).nativeSessions.today[nativeSession.sessionId].totalTokens, 999);
});

test('bounded native replay failure does not suppress Tokscale aggregate usage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-replay-failure-'));
  const stateHome = path.join(root, 'state');
  const sessionsDir = path.join(stateHome, 'sessions');
  const paths = sidecars(sessionsDir, 'broken', {
    id: 'broken',
    created_at: '2026-08-08T02:00:00.000Z'
  }, nativeTelemetry({ totalTokens: 999 }));
  fs.writeFileSync(path.join(sessionsDir, 'broken.events.jsonl'), 'not-json\n');

  const runTokscale = async () => ({ entries: [{
    client: 'reasonix',
    model: 'deepseek-v4',
    input: 80,
    output: 30,
    cacheRead: 20,
    reasoning: 10,
    cost: 0.25
  }] });
  const summary = await collectUsageOnce({
    clients: 'reasonix',
    allTimeSince: '2026-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'native-replay-failure-test',
    runTokscale,
    platform: 'linux',
    historyEnabled: false,
    wslScanEnabled: false,
    reasonixNativeSessionsEnabled: true,
    env: { REASONIX_STATE_HOME: stateHome },
    homeDir: root,
    cwdDir: root
  });

  assert.equal(summary.today.totalTokens, 140);
  assert.deepEqual(Object.keys(summary.nativeSessions.today), []);
  assert.equal(fs.existsSync(paths.metaPath), true);
});

test('Reasonix native rows use the common session formatter and merge project attribution', () => {
  const session = {
    native: true,
    client: 'reasonix',
    sessionId: 'reasonix:row-id',
    title: 'Build a dashboard',
    model: 'deepseek-v4',
    totalTokens: 140,
    promptTokens: 80,
    completionTokens: 30,
    reasoningTokens: 10,
    cacheHitTokens: 20,
    cacheMissTokens: 80,
    requestCount: 4,
    reportedCostUsd: 0.25,
    turns: 2,
    projectLabel: 'Token Monitor',
    lastUsedAt: new Date(2026, 7, 8, 11, 0).toISOString()
  };
  const rows = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: { 'reasonix:row-id': session },
    clientLabels: { reasonix: 'Reasonix' },
    clientColors: { reasonix: '#4d6bfe' },
    now: new Date(2026, 7, 8, 12, 0)
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'session');
  assert.equal(rows[0].key, 'session:reasonix:row-id');
  assert.equal(rows[0].name, 'Reasonix · deepseek-v4');
  assert.equal(rows[0].subtitle, '11:00');
  assert.equal(rows[0].detail, 'row-id');
  assert.equal(Object.hasOwn(rows[0], 'nativeSessionBreakdown'), false);
  assert.equal(rows[0].cost, 0.25);
  assert.equal(rows[0].sessionDetailAvailable, false);

  const projects = projectRowsForPeriod({ projects: {} }, {
    nativeProjects: {
      'token monitor': { label: 'Token Monitor', tokens: 140, costUsd: 999, clients: { reasonix: 140 } }
    },
    clientLabels: { reasonix: 'Reasonix' },
    clientColors: { reasonix: '#4d6bfe' }
  });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].value, 140);
  assert.equal(projects[0].cost, 0);
  assert.deepEqual(projects[0].accordionRows.map(({ key, value }) => ({ key, value })), [{ key: 'reasonix', value: 140 }]);
});

test('readReasonixNativeSession skips missing stable ID and missing/corrupt telemetry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-read-'));
  const metaPath = path.join(root, 'session.jsonl.meta');
  const telemetryPath = path.join(root, 'session.jsonl.telemetry.json');
  writeJson(metaPath, { created_at: '2026-08-08T00:00:00.000Z' });
  writeJson(telemetryPath, nativeTelemetry());
  assert.equal(readReasonixNativeSession(metaPath, telemetryPath), null);
  writeJson(metaPath, { id: 'stable' });
  assert.equal(readReasonixNativeSession(metaPath, path.join(root, 'missing')), null);
  fs.writeFileSync(telemetryPath, '{bad');
  assert.equal(readReasonixNativeSession(metaPath, telemetryPath), null);
});

test('readReasonixNativeSession bounds metadata and projected telemetry usage to regular files', () => {
  assert.equal(REASONIX_META_MAX_BYTES, 1 * 1024 * 1024);
  assert.equal(REASONIX_TELEMETRY_USAGE_MAX_BYTES, 4 * 1024 * 1024);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-sidecar-bounds-'));
  const metaPath = path.join(root, 'session.jsonl.meta');
  const telemetryPath = path.join(root, 'session.jsonl.telemetry.json');
  writeJson(metaPath, { id: 'bounded' });
  writeJson(telemetryPath, nativeTelemetry());
  assert.notEqual(readReasonixNativeSession(metaPath, telemetryPath), null);

  fs.writeFileSync(metaPath, paddedJson({ id: 'oversized-meta' }, REASONIX_META_MAX_BYTES + 1));
  assert.equal(readReasonixNativeSession(metaPath, telemetryPath), null);

  writeJson(metaPath, { id: 'bounded' });
  fs.writeFileSync(
    telemetryPath,
    paddedJson(nativeTelemetry(), REASONIX_TELEMETRY_USAGE_MAX_BYTES + 1)
  );
  assert.equal(readReasonixNativeSession(metaPath, telemetryPath), null);

  const metaDirectory = path.join(root, 'meta-directory');
  const telemetryDirectory = path.join(root, 'telemetry-directory');
  fs.mkdirSync(metaDirectory);
  fs.mkdirSync(telemetryDirectory);
  writeJson(telemetryPath, nativeTelemetry());
  assert.equal(readReasonixNativeSession(metaDirectory, telemetryPath), null);
  writeJson(metaPath, { id: 'bounded' });
  assert.equal(readReasonixNativeSession(metaPath, telemetryDirectory), null);

  const growingContent = paddedJson({ id: 'grew-after-fstat' }, REASONIX_META_MAX_BYTES * 2);
  let readOffset = 0;
  let totalReadBytes = 0;
  let readCalls = 0;
  let closed = false;
  const growingFs = {
    statSync: () => ({ isFile: () => true, size: 2 }),
    openSync: () => 1,
    fstatSync: () => ({ isFile: () => true, size: 2 }),
    readSync: (_descriptor, buffer, offset, length) => {
      readCalls += 1;
      const bytesRead = Math.min(length, growingContent.length - readOffset);
      if (bytesRead > 0) growingContent.copy(buffer, offset, readOffset, readOffset + bytesRead);
      readOffset += bytesRead;
      totalReadBytes += bytesRead;
      return bytesRead;
    },
    closeSync: () => { closed = true; }
  };
  assert.equal(readReasonixNativeSession('growing.json', 'unused.json', { fsModule: growingFs }), null);
  assert.ok(totalReadBytes > REASONIX_META_MAX_BYTES);
  assert.ok(totalReadBytes < growingContent.length);
  assert.ok(readCalls < Math.ceil(growingContent.length / (64 * 1024)));
  assert.equal(closed, true);
});

test('readReasonixNativeSession projects usage without reading oversized official ReadFiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-large-official-telemetry-'));
  const metaPath = path.join(root, 'session.jsonl.meta');
  const telemetryPath = path.join(root, 'session.jsonl.telemetry.json');
  writeJson(metaPath, { id: 'large-official' });
  const telemetry = JSON.stringify({
    version: 3,
    readFiles: [{
      path: 'x'.repeat(
        REASONIX_TELEMETRY_USAGE_MAX_BYTES + REASONIX_TELEMETRY_TAIL_OVERHEAD_BYTES + 1024
      ),
      turn: 1,
      time: 1
    }],
    usage: nativeTelemetry({ totalTokens: 987654 })
  }, null, 2);
  assert.ok(Buffer.byteLength(telemetry) > REASONIX_TELEMETRY_USAGE_MAX_BYTES);
  fs.writeFileSync(telemetryPath, telemetry);

  let totalReadBytes = 0;
  const measuringFs = {
    statSync: fs.statSync,
    openSync: fs.openSync,
    fstatSync: fs.fstatSync,
    readSync: (...args) => {
      const bytesRead = fs.readSync(...args);
      totalReadBytes += bytesRead;
      return bytesRead;
    },
    closeSync: fs.closeSync
  };
  const projected = readReasonixTelemetryUsage(telemetryPath, measuringFs);
  assert.equal(projected.totalTokens, 987654);
  assert.ok(totalReadBytes <= REASONIX_TELEMETRY_USAGE_MAX_BYTES + REASONIX_TELEMETRY_TAIL_OVERHEAD_BYTES);
  assert.ok(totalReadBytes < Buffer.byteLength(telemetry));

  const session = readReasonixNativeSession(metaPath, telemetryPath);
  assert.notEqual(session, null);
  assert.equal(session.totalTokens, 987654);
  assert.equal(session.requestCount, 7);
});
