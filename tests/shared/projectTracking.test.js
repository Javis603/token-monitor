'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectPathFromJsonl } = require('../../src/shared/collector');
const { aggregateDevices, normalizePeriod } = require('../../src/shared/usage');

test('projectPathFromJsonl reads direct and nested session cwd metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-project-'));
  try {
    const claude = path.join(root, 'claude.jsonl');
    const codex = path.join(root, 'codex.jsonl');
    fs.writeFileSync(claude, `${JSON.stringify({ type: 'user', cwd: '/work/client-a' })}\n`);
    fs.writeFileSync(codex, `${JSON.stringify({ type: 'session_meta', payload: { cwd: 'C:\\Code\\client-b' } })}\n`);
    assert.equal(projectPathFromJsonl(claude), '/work/client-a');
    assert.equal(projectPathFromJsonl(codex), 'C:\\Code\\client-b');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('projectPath survives period normalization and device aggregation', () => {
  const period = normalizePeriod({ sessions: { 'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 120, costUsd: 1.25, projectPath: '/work/app' } } });
  assert.equal(period.sessions['claude:s1'].projectPath, '/work/app');
  const aggregate = aggregateDevices([{ deviceId: 'dev', updatedAt: new Date().toISOString(), today: period }], 60000);
  assert.equal(aggregate.periods.today.sessions['claude:s1'].projectPath, '/work/app');
});
