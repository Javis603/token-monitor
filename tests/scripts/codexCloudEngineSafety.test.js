'use strict';
// Offline regression tests: no network, credentials, model turns or file imports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { argumentsFor } = require('../../scripts/codex-cloud-engine-usage');
const { CloudEngineUsage } = require('../../src/shared/providers/codex/cloudEngineUsage');
const { CloudLiveMeter } = require('../../src/shared/providers/codex/cloudLiveMeter');
const tid = '01900000-0000-7000-8000-000000000001';
const turn = '01900000-0000-7000-8000-000000000002';
const usage = { inputTokens: 90, outputTokens: 10, totalTokens: 100 };
function makeEvent(threadId = tid) { return JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: turn, tokenUsage: { total: usage, last: usage } } }); }
function fixture() {
  let revision = 'fixture-1'; let reads = 0;
  const observer = new CloudEngineUsage({ budgetMs: 1000 }, { loadCredential: () => {
    reads += 1; return { fileHash: revision, scopeFingerprint: 'fixture-account', accessToken: 'synthetic-not-auth' };
  } });
  observer.target = tid; observer.meter = new CloudLiveMeter(tid);
  return { observer, change: () => { revision = 'fixture-2'; }, reads: () => reads };
}
function temp(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-engine-safety-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p;
}
test('switched account is rejected before a numeric event can reach persistence', async () => {
  const f = fixture(); let persisted = 0;
  f.observer.onSample = () => { persisted += 1; };
  try {
    f.change(); f.observer.onMessage(makeEvent());
    assert.equal(persisted, 0); assert.equal(f.observer.meter.report().total, null);
    assert.equal(f.observer.closed, true); assert.equal(f.observer.failure, 'LOGIN_CHANGED');
  } finally { await f.observer.close(); }
});
test('valid event checks account and persists an independent copy', async () => {
  const f = fixture(); let persisted = 0;
  f.observer.onSample = (sample) => { persisted += 1; sample.total.totalTokens = 999; };
  try {
    f.observer.onMessage(makeEvent());
    assert.equal(persisted, 1); assert.equal(f.reads(), 2);
    assert.equal(f.observer.meter.report().total.totalTokens, 100);
  } finally { await f.observer.close(); }
});
test('persistence error closes observation rather than silently dropping future events', async () => {
  const f = fixture(); f.observer.onSample = () => { throw new Error('PRIVATE_STORAGE_ERROR'); };
  try {
    f.observer.onMessage(makeEvent());
    assert.equal(f.observer.closed, true); assert.equal(f.observer.failure, 'EVENT_PERSIST_FAILED');
    assert.ok(!JSON.stringify(f.observer.meter.report()).includes('PRIVATE_STORAGE_ERROR'));
  } finally { await f.observer.close(); }
});
test('foreign notifications never access account state or persistence callback', async () => {
  const f = fixture(); let persisted = 0; f.observer.onSample = () => { persisted += 1; };
  try {
    f.observer.onMessage(makeEvent(turn));
    f.observer.onMessage(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: tid, delta: 'PRIVATE_TEXT' } }));
    assert.equal(f.reads(), 1); assert.equal(persisted, 0);
  } finally { await f.observer.close(); }
});
test('CLI refuses equivalent output paths before creating an observer', (t) => {
  const root = temp(t), output = path.join(root, 'report.json');
  assert.throws(() => argumentsFor(['--thread', tid, '--attach-existing-thread', '--output', output, '--events', root + '/./report.json']), { code: 'OUTPUT_EXISTS' });
});
test('CLI refuses preexisting output even if it is a dangling symlink', { skip: process.platform === 'win32' }, (t) => {
  const root = temp(t), output = path.join(root, 'report.json');
  fs.symlinkSync(path.join(root, 'missing'), output);
  assert.throws(() => argumentsFor(['--thread', tid, '--attach-existing-thread', '--output', output]), { code: 'OUTPUT_EXISTS' });
});
test('CLI resolves symlinked parent aliases when checking collisions', { skip: process.platform === 'win32' }, (t) => {
  const root = temp(t), real = path.join(root, 'real'), alias = path.join(root, 'alias');
  fs.mkdirSync(real); fs.symlinkSync(real, alias);
  assert.throws(() => argumentsFor(['--thread', tid, '--attach-existing-thread', '--output', path.join(real, 'out'), '--html', path.join(alias, 'out')]), { code: 'OUTPUT_EXISTS' });
});
test('CLI requires bounded wait and explicit viewer attachment', () => {
  assert.throws(() => argumentsFor(['--thread', tid]), { code: 'EXPLICIT_ATTACH_REQUIRED' });
  assert.throws(() => argumentsFor(['--thread', tid, '--attach-existing-thread', '--wait-seconds', '0']), { code: 'INVALID_WAIT' });
  assert.throws(() => argumentsFor(['--thread', tid, '--attach-existing-thread', '--wait-seconds', '121']), { code: 'INVALID_WAIT' });
  assert.equal(argumentsFor(['--help']).help, true);
});
