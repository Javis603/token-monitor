'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

function harness() {
  const instances = [];
  const timers = new Map();
  let timerId = 0;
  class Worker extends EventEmitter {
    constructor() { super(); instances.push(this); this.messages = []; }
    unref() {}
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; return Promise.resolve(1); }
    respond(result) { this.emit('message', { id: this.messages.at(-1).id, result }); }
  }
  const file = require.resolve('../../src/electron/taskSpeedHost');
  const nativeRequire = createRequire(file);
  const requireFixture = id => id === 'node:worker_threads' ? { Worker } : nativeRequire(id);
  requireFixture.resolve = nativeRequire.resolve;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: requireFixture, module,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { read: module.exports.readTaskSpeedStats, instances, timers };
}

test('a failed worker late exit cannot reject or orphan its replacement', async () => {
  const { read, instances, timers } = harness();
  const first = read({}).catch(error => error.message);
  const old = instances[0];
  old.emit('error', new Error('crashed'));
  assert.equal(await first, 'crashed');
  const second = read({});
  const replacement = instances[1];
  old.emit('exit', 1);
  old.respond('stale response');
  replacement.respond('new result');
  assert.equal(await second, 'new result');
  const third = read({});
  assert.equal(instances.length, 2);
  replacement.respond('still owned');
  assert.equal(await third, 'still owned');
  assert.equal(timers.size, 0);
});

test('a timeout terminates its worker and rejects queued requests before a fresh reader starts', async () => {
  const { read, instances, timers } = harness();
  const first = read({}).catch(error => error.message);
  const queued = read({}).catch(error => error.message);
  timers.values().next().value();
  assert.equal(instances[0].terminated, true);
  assert.equal(await first, 'Task speed data timed out');
  assert.equal(await queued, 'Task speed data timed out');
  assert.equal(timers.size, 0);
  const next = read({});
  instances[0].emit('exit', 1);
  instances[1].respond('recovered');
  assert.equal(await next, 'recovered');
});
