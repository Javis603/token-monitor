'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { args, main } = require('../../scripts/codex-cloud-usage');
const id = '00000000-0000-4000-8000-000000000001', turnId = '00000000-0000-4000-8000-000000000002';
test('CLI help uses no login or network', () => {
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/codex-cloud-usage.js'), '--help'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: '/does-not-exist' } });
  assert.equal(r.status, 0, r.stderr); assert.ok(r.stdout.includes('no login'));
});
test('CLI requires explicit thread/discovery and validates budgets before any query', () => {
  for (const argv of [[], ['--thread', 'task-card'], ['--discover', '--max-turns', '0'], ['--discover', '--budget', '1000'], ['--bogus']]) assert.throws(() => args(argv));
  assert.equal(args(['--thread', id, '--quotas']).quotas, true);
});
test('CLI integration writes unknown tokens plus real-format history, not fake success totals', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cloud-cli-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'report'); let closed = false;
  const rpc = { audit: { startedModelTurns: 0 }, async initialize() {}, assertIdentity() {}, async close() { closed = true; },
    async request(m) { return m === 'thread/read' ? { thread: { id } } : { data: [{ id: turnId, startedAt: 1791000000, completedAt: 1791000010 }], nextCursor: null }; },
    async estimates() { const e = new Error('not allowed'); e.code = 'FORBIDDEN'; throw e; } };
  const r = await main(['--thread', id, '--output-dir', dir], { createTransport: () => rpc, seedReferences: [] });
  assert.equal(closed, true); assert.equal(r.status, 'partial'); assert.equal(r.turns.length, 1); assert.equal(r.totals.observedSettledTokens, null);
  assert.ok(fs.readFileSync(path.join(dir, 'report.html'), 'utf8').includes('FORBIDDEN'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'report.json')).mode & 0o777, 0o600);
  await assert.rejects(main(['--thread', id, '--output-dir', dir], { createTransport: () => { throw Error('SHOULD_NOT_CONNECT'); } }), { code: 'EEXIST' });
});


test('existing usage CLI dispatches cloud help without authentication', () => {
  const entry = path.resolve(__dirname, '../../scripts/codex-task-usage.js');
  const r = spawnSync(process.execPath, [entry, '--cloud', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.ok(r.stdout.includes('hosted cloud'));
  const conflict = spawnSync(process.execPath, [entry, '--cloud', '--live'], { encoding: 'utf8' });
  assert.notEqual(conflict.status, 0); assert.ok(conflict.stderr.includes('CONFLICTING_SOURCE'));
});
