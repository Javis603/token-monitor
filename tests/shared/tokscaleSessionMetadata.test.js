'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { applyTokscaleSessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function scan() {
  return {
    groupBy: 'client,workspace,session,model',
    entries: [
      {
        client: 'claude',
        sessionId: 'session-1',
        workspaceKey: '-Users-someone-repo-a',
        workspaceLabel: 'repo-a',
        model: 'claude-sonnet-4-5',
        input: 10,
        output: 5,
        cost: 1
      },
      {
        client: 'codex',
        sessionId: 'session-2',
        workspaceKey: '/Users/someone/repo-a',
        workspaceLabel: 'repo-a',
        model: 'gpt-5.6',
        input: 20,
        output: 4,
        cost: 2
      }
    ],
    sessions: [
      { client: 'claude', sessionId: 'session-1', title: 'Fix the parser', firstActiveMs: 1789119106979, lastActiveMs: 1789123338309 },
      { client: 'codex', sessionId: 'session-2', title: null, firstActiveMs: 0, lastActiveMs: 0 }
    ],
    workspaces: [
      { workspaceKey: '-Users-someone-repo-a', label: 'repo-a', path: '/Users/someone/repo-a' },
      { workspaceKey: '/Users/someone/repo-a', label: 'repo-a', path: '/Users/someone/repo-a' }
    ]
  };
}

test('the decoded workspace path gives both clients the same project identity', () => {
  const json = scan();
  const applied = applyTokscaleSessionMetadata(json, { resolveProjects: true });

  assert.equal(applied.projects, 2);
  const expected = projectIdentity('/Users/someone/repo-a');
  assert.equal(json.entries[0].projectId, expected.projectId);
  assert.equal(json.entries[1].projectId, expected.projectId);
  assert.equal(json.entries[0].projectLabel, 'repo-a');
});

test('activity bounds and titles reach the extracted sessions', () => {
  const json = scan();
  applyTokscaleSessionMetadata(json, { resolveProjects: true });
  const period = extractUsageFromTokscale(json);

  const claude = period.sessions['claude:session-1'];
  assert.equal(claude.startedAt, new Date(1789119106979).toISOString());
  assert.equal(claude.lastUsedAt, new Date(1789123338309).toISOString());
  assert.equal(claude.title, 'Fix the parser');
});

test('a zero timestamp reads as unknown rather than as the epoch', () => {
  const json = scan();
  applyTokscaleSessionMetadata(json, { resolveProjects: true });

  assert.equal(json.entries[1].startedAt, undefined);
  assert.equal(json.entries[1].lastUsedAt, undefined);
});

test('projects stay out of the rows when project resolution is off', () => {
  const json = scan();
  const applied = applyTokscaleSessionMetadata(json, { resolveProjects: false });

  assert.equal(applied.projects, 0);
  assert.equal(json.entries[0].projectId, undefined);
  // Timestamps are not part of the projects opt-out.
  assert.equal(applied.sessions, 2);
  assert.ok(json.entries[0].startedAt);
});

test('a scan without the arrays leaves every row untouched', () => {
  const json = { entries: [{ client: 'claude', sessionId: 'session-1', input: 1, output: 1, cost: 1 }] };
  const applied = applyTokscaleSessionMetadata(json, { resolveProjects: true });

  assert.deepEqual(applied, { sessions: 0, projects: 0 });
  assert.equal(json.entries[0].projectId, undefined);
  assert.equal(json.entries[0].startedAt, undefined);
});

test('a workspace key that decodes to nothing still identifies itself', () => {
  const json = {
    entries: [{ client: 'commandcode', sessionId: 'session-3', workspaceKey: 'users-someone-repo-b', input: 1, output: 1, cost: 1 }],
    sessions: [{ client: 'commandcode', sessionId: 'session-3', firstActiveMs: 1789119106979, lastActiveMs: 1789119106979 }],
    workspaces: [{ workspaceKey: 'users-someone-repo-b', label: 'users-someone-repo-b' }]
  };

  applyTokscaleSessionMetadata(json, { resolveProjects: true });

  assert.equal(json.entries[0].projectId, projectIdentity('users-someone-repo-b').projectId);
});
