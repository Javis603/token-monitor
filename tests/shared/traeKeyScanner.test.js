'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, pbkdf2Sync, randomBytes } = require('node:crypto');

const {
  extractTraeKeyFromProcess,
  findTraeAgentPid,
  findTraeKeyInBuffer,
  parsePidsFromTasklist
} = require('../../src/shared/traeKeyScanner');

function buildVerifiedPage1(keyHex, saltHex) {
  const key = Buffer.from(keyHex, 'hex');
  const salt = Buffer.from(saltHex, 'hex');
  const page = Buffer.alloc(4096);
  salt.copy(page, 0);
  page.fill(0xa5, 16, 4016);
  const macSalt = Buffer.from(salt);
  for (let i = 0; i < macSalt.length; i += 1) macSalt[i] ^= 0x3a;
  const macKey = pbkdf2Sync(key, macSalt, 2, 32, 'sha512');
  const hmac = createHmac('sha512', macKey);
  hmac.update(page.subarray(16, 4032));
  const pageLe = Buffer.alloc(4);
  pageLe.writeUInt32LE(1, 0);
  hmac.update(pageLe);
  hmac.digest().copy(page, 4032);
  return page;
}

test('parsePidsFromTasklist reads CSV rows, sorts by memory, and skips headers', () => {
  const output = [
    'INFO: No tasks are running which match the specified criteria.',
    '"Trae CN.exe","4242","Console","1","1,024 K"',
    '"Trae CN.exe","111","Console","1","98,304 K"',
    '',
    '"Trae CN.exe","abc","Console","1","12 K"'
  ].join('\r\n');
  const pids = parsePidsFromTasklist(output);
  assert.deepEqual(pids.map((entry) => entry.pid), [111, 4242]);
});

test('findTraeKeyInBuffer verifies the bare-64 and key+salt-96 hex forms', () => {
  const keyHex = randomBytes(32).toString('hex');
  const saltHex = randomBytes(16).toString('hex');
  const dbPage1 = buildVerifiedPage1(keyHex, saltHex);

  // Bare 64-hex key embedded in memory noise (zero bytes are not hex chars).
  const noise = Buffer.alloc(1024, 0);
  const bare = Buffer.concat([noise, Buffer.from(keyHex, 'latin1'), noise]);
  assert.equal(findTraeKeyInBuffer(bare, { saltHex, dbPage1 }), keyHex);

  // x'...' prefixed form carrying key + salt (96 hex chars).
  const prefixed = Buffer.from(`x'${keyHex}${saltHex}'`, 'latin1');
  assert.equal(findTraeKeyInBuffer(prefixed, { saltHex, dbPage1 }), keyHex);

  // A candidate key that does not verify against the database never passes,
  // no matter which salt shape surrounds it.
  const wrongKey = randomBytes(32).toString('hex');
  const otherSalt = randomBytes(16).toString('hex');
  assert.equal(findTraeKeyInBuffer(Buffer.from(wrongKey, 'latin1'), { saltHex, dbPage1 }), null);
  assert.equal(findTraeKeyInBuffer(Buffer.from(`${wrongKey}${otherSalt}`, 'latin1'), { saltHex, dbPage1 }), null);

  assert.equal(findTraeKeyInBuffer(randomBytes(256), { saltHex, dbPage1 }), null);
});

test('findTraeAgentPid probes modules for the highest-memory candidate', () => {
  const processes = [
    'tasklist|/FI|IMAGENAME eq Trae CN.exe|/FO|CSV|/NH'
  ];
  const runTasklist = (args) => {
    processes.push(args.join('|'));
    if (args.includes('/M')) {
      const pid = args[2].split(' ').pop();
      return pid === '111'
        ? '"Trae CN.exe","111","ai_agent.dll",""'
        : '"Trae CN.exe","4242","Trae CN.exe",""';
    }
    return '"Trae CN.exe","4242","Console","1","1,024 K"\r\n"Trae CN.exe","111","Console","1","98,304 K"';
  };
  assert.equal(findTraeAgentPid({ runTasklist }), 111, 'the process hosting ai_agent.dll wins even with less memory');

  const none = findTraeAgentPid({
    runTasklist: () => 'INFO: No tasks are running which match the specified criteria.'
  });
  assert.equal(none, null);
});

test('extractTraeKeyFromProcess fails closed off-Windows and without a database', () => {
  assert.throws(() => extractTraeKeyFromProcess({ platform: 'darwin' }),
    (error) => error.code === 'TRAE_NOT_WINDOWS');
  assert.throws(() => extractTraeKeyFromProcess({
    platform: 'win32',
    dbPath: 'Z:/definitely/missing/database.db'
  }), (error) => error.code === 'TRAE_DB_NOT_FOUND');
});
