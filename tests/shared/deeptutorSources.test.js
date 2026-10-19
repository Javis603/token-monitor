'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { deeptutorDatabasePath, deeptutorSourceFingerprint } = require('../../src/shared/providers/deeptutor/paths');
const { CLIENT_CATALOG } = require('../../src/shared/clientCatalog');
const { clientSourceRoots } = require('../../src/shared/clientSources');
const { normalizeClientName } = require('../../src/shared/usage');
const { configFingerprint, watchIgnoreMatcher } = require('../../src/shared/collector');

test('DeepTutor uses explicit absolute paths with no cwd or account discovery', () => {
  assert.equal(deeptutorDatabasePath({ env: {}, platform: 'win32' }), '');
  assert.equal(deeptutorDatabasePath({ env: { DEEPTUTOR_HOME: '\\Tutor' }, platform: 'win32' }), '');
  assert.equal(deeptutorDatabasePath({ env: { DEEPTUTOR_HOME: 'C:\\Tutor' }, platform: 'win32' }), 'C:\\Tutor\\data\\user\\usage.sqlite3');
  assert.equal(deeptutorDatabasePath({ env: { TOKEN_MONITOR_DEEPTUTOR_DB_PATH: '/account/usage.sqlite3', DEEPTUTOR_HOME: '/ignored' }, platform: 'linux' }), '/account/usage.sqlite3');
  assert.equal(deeptutorDatabasePath({ env: { TOKEN_MONITOR_DEEPTUTOR_DB_PATH: 'relative.sqlite3', DEEPTUTOR_HOME: '/ignored' }, platform: 'linux' }), '');
});

test('DeepTutor watches only the selected DB and WAL, not private neighboring data', () => {
  const db = path.resolve('synthetic-tutor', 'usage.sqlite3');
  const options = { env: { TOKEN_MONITOR_DEEPTUTOR_DB_PATH: db } };
  const ignore = watchIgnoreMatcher('deeptutor,deeptutor-estimated', options);
  for (const file of [path.dirname(db), db, `${db}-wal`]) assert.equal(ignore(file), false, file);
  for (const file of [`${db}-shm`, path.join(path.dirname(db), 'credentials.json'),
    path.join(path.dirname(db), 'conversations', 'private.json')]) assert.equal(ignore(file), true, file);
});

test('changing the selected DeepTutor ledger invalidates the collector anchor', () => {
  const fingerprint = (client, db) => configFingerprint(client, '2026-01-01', true, '', '', null,
    'fixed-pricing', { env: { TOKEN_MONITOR_DEEPTUTOR_DB_PATH: path.resolve(db) } }, '');
  assert.notEqual(fingerprint('deeptutor', 'first.db'), fingerprint('deeptutor', 'second.db'));
  assert.equal(fingerprint('codex', 'first.db'), fingerprint('codex', 'second.db'));
});

test('DeepTutor exact and estimated partitions are opt-in and remain separate', () => {
  for (const id of ['deeptutor', 'deeptutor-estimated']) {
    const client = CLIENT_CATALOG.find(c => c.id === id);
    assert.equal(client.defaultTracked, false);
    assert.equal(client.forkOnly, true);
    assert.equal(normalizeClientName(id), id);
    assert.equal(normalizeClientName(client.label), id);
  }
});

test('only enabled DeepTutor clients expose the exact ledger root', () => {
  const options = { platform: 'win32', homeDir: 'C:\\User', env: { DEEPTUTOR_HOME: 'C:\\Tutor' } };
  const roots = clientSourceRoots('deeptutor,deeptutor-estimated', options);
  assert.deepEqual(roots.deeptutor, [{ id: 'deeptutor-ledger', dir: 'C:\\Tutor\\data\\user', sourcePath: 'C:\\Tutor\\data\\user\\usage.sqlite3' }]);
  assert.deepEqual(roots['deeptutor-estimated'], roots.deeptutor);
  assert.equal(clientSourceRoots('codex', options).deeptutor, undefined);
  assert.equal(clientSourceRoots('deeptutor', { ...options, env: {} }).deeptutor, undefined);
});

test('source fingerprints change only for selected DeepTutor paths', () => {
  const options = { platform: 'linux', env: { DEEPTUTOR_HOME: '/one' } };
  assert.equal(deeptutorSourceFingerprint('codex', options), '');
  assert.equal(deeptutorSourceFingerprint('deeptutor', options), '/one/data/user/usage.sqlite3');
  assert.notEqual(deeptutorSourceFingerprint('deeptutor', options), deeptutorSourceFingerprint('deeptutor', { ...options, env: { DEEPTUTOR_HOME: '/two' } }));
});
