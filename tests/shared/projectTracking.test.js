'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectIdentity, projectPathFromJsonl } = require('../../src/shared/collector');
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

test('projectPathFromJsonl caches unchanged transcript metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-project-cache-'));
  try {
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ cwd: '/work/cached' })}\n`);
    assert.equal(projectPathFromJsonl(file), '/work/cached');
    const originalOpen = fs.openSync;
    fs.openSync = () => { throw new Error('unchanged file was reread'); };
    try { assert.equal(projectPathFromJsonl(file), '/work/cached'); } finally { fs.openSync = originalOpen; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('opaque project identity survives normalization while raw paths are discarded', () => {
  const identity = projectIdentity('/work/app');
  const period = normalizePeriod({ sessions: { 'claude:s1': { client: 'claude', sessionId: 's1', totalTokens: 120, costUsd: 1.25, projectPath: '/private/alice/app', ...identity } } });
  assert.deepEqual({ projectId: period.sessions['claude:s1'].projectId, projectLabel: period.sessions['claude:s1'].projectLabel }, identity);
  assert.equal(Object.hasOwn(period.sessions['claude:s1'], 'projectPath'), false);
  const aggregate = aggregateDevices([{ deviceId: 'dev', updatedAt: new Date().toISOString(), today: period }], 60000);
  assert.equal(aggregate.periods.today.sessions['claude:s1'].projectId, identity.projectId);
  assert.equal(Object.hasOwn(aggregate.periods.today.sessions['claude:s1'], 'projectPath'), false);
});

test('projectIdentity canonicalizes Windows paths and preserves root labels', () => {
  const cased = projectIdentity('C:\\Code\\App\\');
  const lower = projectIdentity('c:/code/app');
  assert.equal(cased.projectId, lower.projectId);
  assert.equal(cased.projectLabel, 'App');
  assert.equal(lower.projectLabel, 'app');
  assert.equal(projectIdentity('C:\\').projectLabel, 'C:\\');
  assert.equal(projectIdentity('/').projectLabel, '/');
});

test('session aggregation keeps project id and label as one identity pair', () => {
  const aggregate = aggregateDevices([
    { deviceId: 'a', today: { sessions: { s: { client: 'claude', sessionId: 's', totalTokens: 1, projectId: 'sha256:a', projectLabel: 'project-a' } } } },
    { deviceId: 'b', today: { sessions: { s: { client: 'claude', sessionId: 's', totalTokens: 1, projectId: 'sha256:b', projectLabel: 'project-b' } } } }
  ], 60000);
  assert.equal(aggregate.periods.today.sessions['claude:s'].projectId, 'sha256:a');
  assert.equal(aggregate.periods.today.sessions['claude:s'].projectLabel, 'project-a');
});
