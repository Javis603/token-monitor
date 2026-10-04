'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../../scripts/codex-task-usage.js');
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('CLI help never accesses credentials', () => {
  const p = run(['--help']); assert.equal(p.status, 0); assert.match(p.stdout, /account-wide fetching is not implemented/);
});

test('CLI imports, filters, exports once and protects existing files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.jsonl'); const output = path.join(dir, 'report.json');
  fs.writeFileSync(input, JSON.stringify({ type: 'token_usage_record', payload: {
    thread_id: 'root', response_id: 'r1', usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 }
  } }) + '\n');
  const args = ['--no-local', '--events', input, '--thread', 'root', '--json', '--output', output];
  assert.equal(run(args).status, 0); const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.knownUsage.totalTokens, 100); assert.equal(report.accountCloudCoverage, 'unknown');
  assert.equal(run(args).status, 1); assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).knownUsage.totalTokens, 100);
});

test('CLI unknown flags fail without scanning', () => {
  const p = run(['--unknown']); assert.equal(p.status, 1); assert.equal(p.stdout, '');
});
