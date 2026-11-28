'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const implementations = {
  node: require('../../src/shared/usage'),
  worker: require('../../worker/src/shared/usage')
};

for (const [name, usage] of Object.entries(implementations)) {
  const make = extra => usage.normalizePeriod({ sessions: { record: {
    client: 'codex', sessionId: 'record', totalTokens: 10, costUsd: 1, ...extra
  } } });
  const row = period => period.sessions['codex:record'];

  test(`${name}: T3 wire identities enforce allowed characters and the 1024-character boundary`, () => {
    for (const id of ['Thread:1_%.-', 'x'.repeat(1024)]) {
      assert.equal(row(make({ t3ThreadId: id })).t3ThreadId, id);
    }
    for (const id of ['', 'x'.repeat(1025), '-thread', 'thread/id', 'two words', 'thread\n', 123, null, {}]) {
      assert.equal(row(make({ t3ThreadId: id })).t3ThreadId, undefined, `reject ${JSON.stringify(id)}`);
    }
  });

  test(`${name}: conflicting app identities remain rejected regardless of device merge order`, () => {
    const a = make({ t3ThreadId: 'Thread-A' });
    const b = make({ t3ThreadId: 'Thread-B' });
    const missing = make({});
    const before = JSON.stringify([a, b, missing]);
    for (const inputs of [[a, b, a], [b, a, b], [missing, a, b], [a, missing, b]]) {
      const merged = row(usage.mergePeriods(...inputs));
      assert.equal(merged.t3ThreadId, undefined);
      assert.equal(merged.totalTokens, 30);
      assert.equal(merged.costUsd, 3);
      assert.equal(merged.sessionId, 'record');
    }
    assert.equal(row(usage.mergePeriods(a, missing, a)).t3ThreadId, 'Thread-A');
    assert.equal(JSON.stringify([a, b, missing]), before);
  });

  test(`${name}: a T3 conflict does not discard an independently verified native identity`, () => {
    const nativeSessionId = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    const merged = usage.mergePeriods(
      make({ nativeSessionId, t3ThreadId: 'Thread' }),
      make({ nativeSessionId: nativeSessionId.toLowerCase(), t3ThreadId: 'thread' })
    );
    assert.equal(row(merged).t3ThreadId, undefined, 'T3 identities remain case sensitive');
    assert.equal(row(merged).nativeSessionId, nativeSessionId.toLowerCase());
    assert.equal(row(merged).totalTokens, 20);
  });

  test(`${name}: legacy parent fields use a canonical client namespace and reject true self-links`, () => {
    const cross = row(make({ parent_session_id: 'record', parent_client: 'claude-code' }));
    assert.equal(cross.parentSessionId, 'record');
    assert.equal(cross.parentClient, 'claude');
    for (const parentClient of [undefined, 'codex']) {
      const self = row(make({ parentSessionId: 'record', parentClient }));
      assert.equal(self.parentSessionId, undefined);
      assert.equal(self.parentClient, undefined);
    }
    const same = row(make({ parent_session_id: 'parent', parent_client: 'codex' }));
    assert.equal(same.parentSessionId, 'parent');
    assert.equal(same.parentClient, undefined);
  });

  test(`${name}: session entry attribution is optional, bounded and accounting-neutral`, () => {
    for (const entry of ['t3', 'codex-cli', 'antigravity-cli']) {
      assert.equal(row(make({ sessionEntry: entry })).sessionEntry, entry);
    }
    for (const entry of ['', 'T3', 'unknown', 'codex', 't3-code', 'codex cli', 7, null, {}]) {
      assert.equal(row(make({ sessionEntry: entry })).sessionEntry, undefined, `reject ${JSON.stringify(entry)}`);
    }
    const plain = make({});
    const attributed = make({ sessionEntry: 't3' });
    assert.equal(row(attributed).totalTokens, row(plain).totalTokens);
    assert.equal(row(attributed).costUsd, row(plain).costUsd);
    const mergedPlain = usage.mergePeriods(plain, plain);
    const mergedAttributed = usage.mergePeriods(attributed, attributed);
    assert.deepEqual(
      { tokens: mergedPlain.totalTokens, clients: mergedPlain.clients, models: mergedPlain.models, cost: mergedPlain.costUsd },
      { tokens: mergedAttributed.totalTokens, clients: mergedAttributed.clients, models: mergedAttributed.models, cost: mergedAttributed.costUsd }
    );
  });

  test(`${name}: conflicting session entries are discarded like conflicting T3 identities`, () => {
    const a = make({ sessionEntry: 't3' });
    const b = make({ sessionEntry: 'codex-cli' });
    const missing = make({});
    for (const inputs of [[a, b, a], [b, a, b], [missing, a, b], [a, missing, b]]) {
      const merged = row(usage.mergePeriods(...inputs));
      assert.equal(merged.sessionEntry, undefined);
      assert.equal(merged.totalTokens, 30);
    }
    assert.equal(row(usage.mergePeriods(a, missing, a)).sessionEntry, 't3');
  });
}
