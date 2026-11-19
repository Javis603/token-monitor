'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { openDb } = require('../../src/shared/sqliteReadOnly');

test('read-only SQLite initialization returns an open connection to its caller', () => {
  let connection;
  const statements = [];
  let closes = 0;
  const sqlite = { DatabaseSync: class {
    constructor(file, options) {
      assert.equal(file, 'fixture.sqlite');
      assert.deepEqual(options, { readOnly: true });
      connection = this;
    }
    exec(sql) { statements.push(sql); }
    close() { closes++; }
  } };
  assert.equal(openDb('fixture.sqlite', sqlite), connection);
  assert.deepEqual(statements, ['PRAGMA busy_timeout = 250', 'PRAGMA query_only = ON']);
  assert.equal(closes, 0);
});

for (const failingStatement of ['PRAGMA busy_timeout = 250', 'PRAGMA query_only = ON']) {
  test(`read-only SQLite closes its connection when ${failingStatement} fails`, () => {
    for (const closeThrows of [false, true]) {
      const initializationError = new Error('initialization failed');
      let closes = 0;
      const sqlite = { DatabaseSync: class {
        exec(sql) { if (sql === failingStatement) throw initializationError; }
        close() {
          closes++;
          if (closeThrows) throw new Error('cleanup failed');
        }
      } };
      assert.throws(() => openDb('fixture.sqlite', sqlite), (error) => error === initializationError);
      assert.equal(closes, 1);
    }
  });
}
