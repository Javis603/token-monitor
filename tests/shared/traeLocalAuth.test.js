'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { hashKey } = require('../../src/shared/hashKey');
const { traeAccountKey, traeTokenAccountId } = require('../../src/shared/traeAccount');
const {
  TRAE_AUTH_STORAGE_KEY,
  decryptTraeAuthStorageValue,
  readTraeLocalAccount,
  traeLocalAuthStoragePaths
} = require('../../src/shared/traeLocalAuth');

const TEST_TOKEN = 'e30.eyJkYXRhIjp7ImlkIjoiYWNjb3VudC0xMjMifSwiZXhwIjoxODkzNDU2MDAwfQ.signature';
const TEST_ENVELOPE = 'dGMFEAAAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9nMZd0IMZHNUazcOt8yrjNE+PWL8s3a+Dn/faCeC3qs30L8Ds96KDMgnxVnbC7auOYTQcfjWs2yauTWC2naGIVPewjrbqiM//IrdDfESZvrDxNcYAaL1gexjRt1d8Aagf8jtDxmaGfWstdxSWdb4hvPdgyNyVYkr+u+sNHJNVlVtEJVeZCGP9k5cKTqKMR6/2ix8isulUsVxfpbkY8yz9qhuJVMVsNq+9XeSXQ6HsIMCTO9cbfma1HpCw1uKow7Ohr8qRMQYZ2ML+JMEHyOee/MrgDv5C+C7ZRLk/RTq3hjIPStQj8MJIW23aPlfwFijyeNTzPhLqFkkFtYmhV6ZSbMofcgCaWs9W4xKyuUBGaDg==';

test('Trae account keys remain stable across JWT refreshes', () => {
  const refreshed = `e30.${Buffer.from(JSON.stringify({ data: { id: 'account-123' }, exp: 1_999_999_999 })).toString('base64url')}.new-signature`;
  assert.equal(traeTokenAccountId(TEST_TOKEN), 'account-123');
  assert.equal(traeAccountKey(TEST_TOKEN), hashKey('trae', 'account-123'));
  assert.equal(traeAccountKey(refreshed), traeAccountKey(TEST_TOKEN));
  assert.notEqual(traeAccountKey('opaque-a'), traeAccountKey('opaque-b'));
});

test('decryptTraeAuthStorageValue validates and decodes Trae byteCrypto records', () => {
  const user = decryptTraeAuthStorageValue(TEST_ENVELOPE);
  assert.equal(user.token, TEST_TOKEN);
  assert.equal(user.userId, 'account-123');
  assert.equal(user.account.username, 'Test Trae');
  assert.throws(() => decryptTraeAuthStorageValue('not-a-record'), /Unsupported/);
});

test('readTraeLocalAccount returns only collector-safe account metadata', () => {
  const document = JSON.stringify({ [TRAE_AUTH_STORAGE_KEY]: TEST_ENVELOPE });
  const account = readTraeLocalAccount({
    storagePaths: ['missing.json', 'current.json'],
    readFileSync: (storagePath) => {
      if (storagePath === 'missing.json') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return document;
    }
  });
  assert.deepEqual(account, {
    accessToken: TEST_TOKEN,
    accountId: 'account-123',
    accountKey: hashKey('trae', 'account-123'),
    accountLabel: 'Test Trae',
    accountScope: 'marscode',
    tokenExpiresAt: '2030-01-01T00:00:00.000Z',
    sourcePath: 'current.json'
  });
});

test('readTraeLocalAccount fails closed for missing or malformed records', () => {
  assert.equal(readTraeLocalAccount({
    storagePaths: ['missing.json'],
    readFileSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
  }), null);
  assert.equal(readTraeLocalAccount({
    storagePaths: ['bad.json'],
    readFileSync: () => JSON.stringify({ [TRAE_AUTH_STORAGE_KEY]: 'not-a-record' })
  }), null);
});

test('traeLocalAuthStoragePaths follows each platform application-data root', () => {
  const windows = traeLocalAuthStoragePaths({
    homeDir: 'C:\\Users\\test',
    env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
    platform: 'win32'
  });
  assert.deepEqual(windows, [
    path.join('C:\\Users\\test\\AppData\\Roaming', 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json'),
    path.join('C:\\Users\\test\\AppData\\Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json')
  ]);
  assert.equal(
    traeLocalAuthStoragePaths({ homeDir: '/home/test', env: {}, platform: 'linux' })[0],
    path.join('/home/test/.config', 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json')
  );
});
