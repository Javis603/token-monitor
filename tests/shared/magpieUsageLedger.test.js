'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sourceFromLedger, readMagpieUsageLedger } = require('../../src/shared/providers/magpie/usageLedger');

function fixture(t, rows) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, 'usage.jsonl');
  fs.writeFileSync(ledgerPath, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
  return { ledgerPath };
}
const record = (response_id, extra = {}) => ({ response_id, provider: 'codex', providerAccount: 'actual-account',
  creator_account_id: 'creator-account', in: 100, out: 50, ms: 900000, ttft_ms: 300000, ...extra });

test('actual final subscription account wins over creator and never exposes raw identity or request timings', async t => {
  const options = fixture(t, [record('response-1')]);
  const result = (await readMagpieUsageLedger(options)).get('response-1');
  assert.equal(result.source.accessType, 'subscription');
  assert.match(result.source.accountId, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.source.accountLabel, /^账号 [a-f0-9]{8}$/);
  assert.equal(result.source.accountId, sourceFromLedger(record('other', { creator_account_id: 'different' })).accountId);
  assert.notEqual(result.source.accountId, sourceFromLedger(record('other', { providerAccount: 'other-account' })).accountId);
  assert.equal(JSON.stringify(result).includes('actual-account'), false);
  assert.equal(JSON.stringify(result).includes('creator-account'), false);
  assert.deepEqual(Object.keys(result).sort(), ['input', 'output', 'source']);
});

test('credential and provider alone do not prove API billing; host and coding plan evidence are required', () => {
  const source = (provider, host, extra = {}) => sourceFromLedger({ provider, host, providerKeyId: 'key-fingerprint', ...extra });
  assert.equal(source('deepseek', 'api.deepseek.com').accessType, 'api');
  assert.equal(source('google', 'generativelanguage.googleapis.com').accessType, 'api');
  assert.equal(source('deepseek', 'localhost:8787').accessType, 'unknown');
  assert.equal(source('cmdc-gemini', 'localhost:8787').accessType, 'unknown');
  assert.equal(source('opencode-go', 'opencode.ai').accessType, 'subscription');
  assert.equal(source('kimi-code-cn', 'api.kimi.com').accessType, 'subscription');
  assert.equal(source('opencode-go', 'api.example.test').accessType, 'unknown');
  assert.equal(sourceFromLedger({ provider: 'codex', creator_account_id: 'creator' }).accountId, '');
  assert.equal(sourceFromLedger({ provider: 'codex', creator_account_id: 'creator' }).accessType, 'unknown');
});

test('byte-exact response IDs, valid counters and unambiguous duplicate evidence are mandatory', async t => {
  const options = fixture(t, [record('exact'), record('exact'), record(' exact '), record('conflict'),
    record('conflict', { providerAccount: 'other-account' }), record('bad-input', { in: -1 }),
    record('bad-output', { out: '50' }), '{invalid json']);
  const result = await readMagpieUsageLedger(options);
  assert.ok(result.get('exact'));
  assert.equal(result.get('conflict'), null);
  assert.equal(result.has(' exact '), false);
  assert.equal(result.has('bad-input'), false);
  assert.equal(result.has('bad-output'), false);
  assert.equal(result.size, 2);
});

test('ledger cache follows append and same-size replacement, missing files fail closed, and cancellation propagates', async t => {
  const options = fixture(t, [record('first')]);
  assert.ok((await readMagpieUsageLedger(options)).get('first'));
  fs.appendFileSync(options.ledgerPath, JSON.stringify(record('next')) + '\n');
  assert.ok((await readMagpieUsageLedger(options)).get('next'));
  fs.writeFileSync(options.ledgerPath, JSON.stringify(record('other')) + '\n');
  const replaced = await readMagpieUsageLedger(options);
  assert.ok(replaced.get('other'));
  assert.equal(replaced.has('first'), false);
  const controller = new AbortController();
  controller.abort(new Error('stop-source-scan'));
  await assert.rejects(readMagpieUsageLedger({ ...options, signal: controller.signal }), /stop-source-scan/);
  assert.equal((await readMagpieUsageLedger({ ledgerPath: path.join(path.dirname(options.ledgerPath), 'missing') })).size, 0);
});
