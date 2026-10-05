'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeSharedSyncValue, nextSharedSyncDocument, emptySharedSyncDocument } = require('../../src/shared/syncContent');
const { stripSessionTextFromDeviceRecord, stripSessionTextFromPeriod } = require('../../src/shared/usage');
const { syncPayload, serializeSyncPayload, postSyncPayload } = require('../../src/shared/syncPayload');

test('shared groups are canonical and preserve all pricing rates and explicit free', () => {
  const aliases = { modelAliases: { ' z ': ' Zed ', a: 'Aye' }, modelAliasGrouping: 'duplicates' };
  assert.deepEqual(normalizeSharedSyncValue('modelAliases', aliases), {
    modelAliases: { a: 'Aye', z: 'Zed' }, modelAliasGrouping: 'duplicates'
  });
  assert.equal(JSON.stringify(normalizeSharedSyncValue('modelAliases', aliases)), JSON.stringify(normalizeSharedSyncValue('modelAliases', {
    modelAliasGrouping: 'duplicates', modelAliases: { a: 'Aye', z: 'Zed' }
  })));
  const prices = [
    { modelId: 'z', inputPerM: '', outputPerM: 0, cacheReadPerM: null },
    { modelId: ' a ', inputPerM: 1, outputPerM: 2, cacheReadPerM: 3, cacheWritePerM: 4, cacheWrite1hPerM: 5 }
  ];
  assert.deepEqual(normalizeSharedSyncValue('customPricing', prices), [
    { modelId: 'a', inputPerM: 1, outputPerM: 2, cacheReadPerM: 3, cacheWritePerM: 4, cacheWrite1hPerM: 5 },
    { modelId: 'z', outputPerM: 0 }
  ]);
  assert.equal(prices[1].modelId, ' a ');
});

test('invalid groups and revision bodies cannot normalize into silent clears', () => {
  const badAliases = [null, [], {}, { modelAliases: [], modelAliasGrouping: 'off' },
    { modelAliases: {}, modelAliasGrouping: 'bad' },
    { modelAliases: { a: 1 }, modelAliasGrouping: 'off' },
    { modelAliases: { a: 'a' }, modelAliasGrouping: 'off' },
    { modelAliases: { 'a.b': 'x', 'a-b': 'y' }, modelAliasGrouping: 'off' },
    { modelAliases: {}, modelAliasGrouping: 'off', secret: 'never store' },
    { modelAliases: { ['a'.repeat(257)]: 'b' }, modelAliasGrouping: 'off' },
    { modelAliases: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`a${i}`, 'b'])), modelAliasGrouping: 'off' }];
  for (const value of badAliases) assert.throws(() => normalizeSharedSyncValue('modelAliases', value));
  const badPrices = [null, {}, [null], [{ modelId: 'a' }], [{ modelId: 'a', inputPerM: -1 }],
    [{ modelId: 'a', inputPerM: '0' }], [{ modelId: 'a', inputPerM: Infinity }],
    [{ modelId: 'a', inputPerM: 0, credential: 'never store' }],
    [{ modelId: 'a', inputPerM: 0 }, { modelId: 'a', outputPerM: 0 }],
    [{ modelId: 'a', inputPerM: 0, cacheWrite1hPerM: false }],
    Array.from({ length: 4097 }, (_, i) => ({ modelId: `a${i}`, inputPerM: 0 }))];
  for (const value of badPrices) assert.throws(() => normalizeSharedSyncValue('customPricing', value));
  for (const baseRevision of [undefined, null, '', '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => nextSharedSyncDocument('customPricing', emptySharedSyncDocument(), { baseRevision, value: [] }));
  }
  assert.deepEqual(emptySharedSyncDocument(), { version: 1, revision: 0, updatedAt: '', value: null });
  const written = nextSharedSyncDocument('customPricing', emptySharedSyncDocument(), { baseRevision: 0, value: [] });
  assert.equal(written.revision, 1);
  assert.deepEqual(written.value, []);
});

function privateSession() {
  return {
    client: 'codex', sessionId: 'a', totalTokens: 5, sessionKind: 'background-review',
    title: `  one\n two ${'😀'.repeat(200)}  `, preview: 'private preview', firstUserMessage: 'private message',
    sessionTitle: 'legacy title', session_title: 'legacy title', name: 'legacy name',
    first_user_message: 'private message', customTitle: 'custom', custom_title: 'custom', aiTitle: 'ai', ai_title: 'ai'
  };
}

test('sanitizers restore only bounded canonical titles in raw and normalized record periods', () => {
  const session = privateSession();
  const period = { totalTokens: 5, sessions: { a: session } };
  const safe = stripSessionTextFromPeriod(period, { preserveSessionTitles: true });
  assert.deepEqual(Object.keys(safe.sessions.a).sort(), ['client', 'sessionId', 'sessionKind', 'title', 'totalTokens'].sort());
  assert.equal(Array.from(safe.sessions.a.title).length, 160);
  assert.match(safe.sessions.a.title, /^one two 😀/);
  assert.equal(session.firstUserMessage, 'private message');
  const record = { today: period, periods: { month: period, allTime: period } };
  const safeRecord = stripSessionTextFromDeviceRecord(record, { preserveSessionTitles: true });
  assert.equal(safeRecord.periods.month.sessions.a.title, safe.sessions.a.title);
  assert.doesNotMatch(JSON.stringify(stripSessionTextFromDeviceRecord(record)), /private|legacy|custom|😀/);
  assert.equal(Object.hasOwn(stripSessionTextFromPeriod({ sessions: { a: { title: 42 } } }, { preserveSessionTitles: true }).sessions.a, 'title'), false);
});

test('payload opt-in sanitizes every compatibility field and keeps generation through reductions and 413 retry', async () => {
  const summary = {
    deviceId: 'a', sessionTitleSyncGeneration: 99,
    today: { totalTokens: 5, sessions: { a: privateSession() } },
    month: { totalTokens: 5, sessions: { a: privateSession() } },
    allTime: { totalTokens: 5, sessions: { a: privateSession() }, projects: { big: { label: 'big', tokens: 5 } } }
  };
  assert.doesNotMatch(JSON.stringify(syncPayload(summary)), /private|legacy|custom|😀|sessionTitleSyncGeneration/);
  const options = { syncSessionTitles: true, sessionTitleSyncGeneration: 7 };
  const normal = serializeSyncPayload(summary, options);
  assert.equal(normal.payload.sessionTitleSyncGeneration, 7);
  assert.equal(Array.from(normal.payload.today.sessions.a.title).length, 160);
  assert.doesNotMatch(normal.body, /private|legacy|custom/);
  const compact = serializeSyncPayload(summary, { ...options, maxBytes: 400 });
  assert.equal(compact.payload.sessionTitleSyncGeneration, 7);
  assert.equal(compact.payload.today.totalTokens, 5);
  const bodies = [];
  const result = await postSyncPayload(async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    return { status: bodies.length === 1 ? 413 : 200, arrayBuffer: async () => new ArrayBuffer(0) };
  }, 'https://hub.example/api/ingest', { summary, ...options });
  assert.equal(result.retried, true);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => body.sessionTitleSyncGeneration === 7 && body.today.sessions.a.title));
  assert.equal(Object.hasOwn(bodies[1].allTime, 'projects'), false);
});
