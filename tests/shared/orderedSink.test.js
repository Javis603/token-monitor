'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createOrderedSink } = require('../../src/shared/orderedSink');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

test('ordered sink sends revision 1 then only the latest pending revision 3', async () => {
  const first = deferred();
  const sent = [];
  const sink = createOrderedSink({
    send: async (record) => {
      sent.push(record.id);
      if (record.id === 1) await first.promise;
    }
  });

  const one = sink.enqueue({ id: 1 }, 1);
  const two = sink.enqueue({ id: 2 }, 2);
  const three = sink.enqueue({ id: 3 }, 3);
  assert.deepEqual(sent, []);
  await Promise.resolve();
  assert.deepEqual(sent, [1]);
  assert.equal((await two).superseded, true);
  first.resolve();
  await Promise.all([one, three]);
  assert.deepEqual(sent, [1, 3]);
});

test('ordered sink ignores stale revisions even when they arrive later', async () => {
  const active = deferred();
  const sent = [];
  const sink = createOrderedSink({
    send: async (record) => {
      sent.push(record.id);
      if (record.id === 3) await active.promise;
    }
  });

  const three = sink.enqueue({ id: 3 }, 3);
  await Promise.resolve();
  const stale = await sink.enqueue({ id: 2 }, 2);
  assert.equal(stale.superseded, true);
  active.resolve();
  await three;
  assert.deepEqual(sent, [3]);
});

test('flush waits for active and latest pending delivery', async () => {
  const active = deferred();
  const sent = [];
  const sink = createOrderedSink({
    send: async (record) => {
      sent.push(record.id);
      if (record.id === 1) await active.promise;
    }
  });
  void sink.enqueue({ id: 1 }, 1);
  void sink.enqueue({ id: 2 }, 2);
  void sink.enqueue({ id: 3 }, 3);
  let flushed = false;
  const flush = sink.flush().then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);
  active.resolve();
  await flush;
  assert.deepEqual(sent, [1, 3]);
});

test('a failed send does not prevent the newest pending record from draining', async () => {
  const active = deferred();
  const sent = [];
  const errors = [];
  const sink = createOrderedSink({
    onError: (error) => errors.push(error.message),
    send: async (record) => {
      sent.push(record.id);
      if (record.id === 1) await active.promise;
    }
  });
  const failed = sink.enqueue({ id: 1 }, 1);
  const latest = sink.enqueue({ id: 2 }, 2);
  active.reject(new Error('offline'));
  await assert.rejects(failed, /offline/);
  await latest;
  assert.deepEqual(sent, [1, 2]);
  assert.deepEqual(errors, ['offline']);
});

test('stop discards pending records while allowing the active send to settle', async () => {
  const active = deferred();
  const sent = [];
  const sink = createOrderedSink({
    send: async (record) => {
      sent.push(record.id);
      if (record.id === 1) await active.promise;
    }
  });
  const first = sink.enqueue({ id: 1 }, 1);
  const pending = sink.enqueue({ id: 2 }, 2);
  sink.stop();
  assert.equal((await pending).stopped, true);
  active.resolve();
  await first;
  assert.deepEqual(sent, [1]);
});
