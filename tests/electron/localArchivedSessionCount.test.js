'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLocalArchivedSessionCounter } = require('../../src/electron/localArchivedSessionCount');

const live = { client: 'codex', sessionId: 'live', totalTokens: 10 };
const archived = { client: 'codex', sessionId: 'gone', totalTokens: 5, archived: true };
const deleted = { client: 'claude', sessionId: 'deleted', totalTokens: 5, sourceDeleted: true };

test('counts archived sessions in the local record across periods once each', () => {
  const record = {
    today: { sessions: { 'codex:gone': archived } },
    month: { sessions: { 'codex:gone': archived, 'codex:live': live } },
    allTime: { sessions: { 'codex:gone': archived, 'codex:live': live, 'claude:deleted': deleted } }
  };
  assert.equal(createLocalArchivedSessionCounter(() => record)(), 2);
  assert.equal(createLocalArchivedSessionCounter(() => ({ periods: record }))(), 2, 'a record nested under periods counts the same');
});

test('no local record yet has no count', () => {
  assert.equal(createLocalArchivedSessionCounter(() => null)(), null);
});

test('an activity patch reuses the count; a new scan recounts', () => {
  const allTime = { sessions: { 'codex:gone': archived } };
  let record = { today: { sessions: {} }, month: { sessions: {} }, allTime };
  let reads = 0;
  const sessions = new Proxy(allTime.sessions, { ownKeys(target) { reads += 1; return Reflect.ownKeys(target); } });
  record.allTime = { sessions };
  const count = createLocalArchivedSessionCounter(() => record);
  assert.equal(count(), 1);
  const scanned = reads;
  // Activity patches replace the record and add sessionActivity, keeping the maps.
  record = { ...record, receivedAt: 'later', today: { ...record.today, sessionActivity: {} } };
  assert.equal(count(), 1);
  assert.equal(reads, scanned, 'unchanged session maps are not walked again');
  record = { ...record, allTime: { sessions: { 'codex:gone': archived, 'claude:deleted': deleted } } };
  assert.equal(count(), 2);
});

test('a cleared archive counts zero until a new scan replaces the record', () => {
  let record = { today: { sessions: {} }, month: { sessions: {} }, allTime: { sessions: { 'codex:gone': archived } } };
  const count = createLocalArchivedSessionCounter(() => record);
  assert.equal(count(), 1);
  count.archiveCleared();
  assert.equal(count(), 0);
  record = { ...record, receivedAt: 'activity patch' };
  assert.equal(count(), 0, 'an activity patch still carries the pre-clear sessions');
  record = { ...record, allTime: { sessions: { 'claude:deleted': deleted } } };
  assert.equal(count(), 1, 'the next scan is counted again');
});
