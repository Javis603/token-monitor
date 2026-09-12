'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applySessionMetadata, applyTokscaleSessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
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

test('a workspace key that decodes to nothing is left unattributed', () => {
  // tokscale reports no path for a key that is an opaque client id or whose
  // directory is gone. Hashing the raw key would mint a second identity for a
  // directory other clients still name correctly, and — worse — mark the
  // session attributed so its transcript is never read for the real cwd.
  const json = {
    entries: [{ client: 'commandcode', sessionId: 'session-3', workspaceKey: 'users-someone-repo-b', input: 1, output: 1, cost: 1 }],
    sessions: [{ client: 'commandcode', sessionId: 'session-3', firstActiveMs: 1789119106979, lastActiveMs: 1789119106979 }],
    workspaces: [{ workspaceKey: 'users-someone-repo-b', label: 'users-someone-repo-b' }]
  };

  const result = applyTokscaleSessionMetadata(json, { resolveProjects: true });

  assert.equal(json.entries[0].projectId, undefined);
  assert.equal(result.projects, 0);
  // The timestamps ride the same pass and are unaffected by the missing path.
  assert.equal(json.entries[0].startedAt, new Date(1789119106979).toISOString());
});

test('a Claude slug whose directory is gone still recovers its path from the transcript', () => {
  // The regression this guards: the slug decode fails once the directory is
  // deleted, but the transcript still records the cwd, so the resolver must
  // keep answering instead of being skipped as already attributed.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-deleted-workspace-'));
  try {
    const transcript = path.join(home, 'session.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ cwd: '/Users/someone/repo-gone' })}\n`);
    const json = {
      entries: [{ client: 'claude', sessionId: 'session-4', workspaceKey: '-Users-someone-repo-gone', input: 1, output: 1, cost: 1 }],
      sessions: [{ client: 'claude', sessionId: 'session-4', firstActiveMs: 1789119106979, lastActiveMs: 1789119106979 }],
      workspaces: [{ workspaceKey: '-Users-someone-repo-gone', label: 'repo-gone' }]
    };
    applyTokscaleSessionMetadata(json, { resolveProjects: true });
    const periods = { allTime: extractUsageFromTokscale(json) };

    applySessionMetadata(periods, home, {
      sessionMetadataResolvers: new Map([
        ['claude', { resolve: (ids, context) => new Map([...ids].map((id) => [id, context.fileSessionMetadata(id, transcript, {})])) }]
      ])
    });

    assert.equal(
      periods.allTime.sessions['claude:session-4'].projectId,
      projectIdentity('/Users/someone/repo-gone').projectId
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a session the scan could not attribute still reaches the file-reading resolver', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-mixed-projects-'));
  try {
    const transcript = path.join(home, 'session.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ cwd: '/Users/someone/repo-b' })}\n`);
    const periods = {
      allTime: {
        sessions: {
          // What a scan-attributed session looks like by the time this pass runs.
          'claude:attributed': {
            client: 'claude',
            sessionId: 'attributed',
            projectId: projectIdentity('/Users/someone/repo-a').projectId,
            projectLabel: 'repo-a'
          },
          // Same collection, a client whose parser records no workspace.
          'kimi:unattributed': { client: 'kimi', sessionId: 'unattributed', projectId: '', projectLabel: '' }
        }
      }
    };
    const resolvers = new Map([
      ['claude', { resolve: (ids, context) => new Map([...ids].map((id) => [id, context.fileSessionMetadata(id, transcript, {})])) }],
      ['kimi', { resolve: (ids, context) => new Map([...ids].map((id) => [id, context.fileSessionMetadata(id, transcript, {})])) }]
    ]);

    applySessionMetadata(periods, home, { sessionMetadataResolvers: resolvers });

    const sessions = periods.allTime.sessions;
    assert.equal(
      sessions['kimi:unattributed'].projectId,
      projectIdentity('/Users/someone/repo-b').projectId,
      'one client answering for itself must not switch off another client’s resolver'
    );
    // The already-attributed session keeps what the scan gave it and pays no read.
    assert.equal(sessions['claude:attributed'].projectId, projectIdentity('/Users/someone/repo-a').projectId);
    assert.equal(sessions['claude:attributed'].projectLabel, 'repo-a');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a scan that attributes one client leaves the other client to its own resolver', async () => {
  const { collectUsageOnce } = require('../../src/shared/collector');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-collector-projects-'));
  try {
    const transcript = path.join(home, 'kimi.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ cwd: '/Users/someone/repo-b' })}\n`);
    const runTokscale = async () => ({
      entries: [
        // Claude comes back attributed, the way a parser that records a workspace does.
        { client: 'claude', sessionId: 'claude-1', workspaceKey: '/Users/someone/repo-a', model: 'claude-sonnet-4-5', input: 10, output: 5, cost: 1 },
        // Kimi comes back with no workspace at all, which is normal for its parser.
        { client: 'kimi', sessionId: 'kimi-1', model: 'kimi-k2', input: 10, output: 5, cost: 1 }
      ],
      sessions: [
        { client: 'claude', sessionId: 'claude-1', firstActiveMs: 1789119106979, lastActiveMs: 1789119106979 },
        { client: 'kimi', sessionId: 'kimi-1', firstActiveMs: 1789119106979, lastActiveMs: 1789119106979 }
      ],
      workspaces: [{ workspaceKey: '/Users/someone/repo-a', label: 'repo-a', path: '/Users/someone/repo-a' }]
    });

    const summary = await collectUsageOnce({
      clients: 'claude,kimi',
      allTimeSince: '2024-01-01',
      deviceId: 'mixed-projects-test',
      historyEnabled: false,
      wslScanEnabled: false,
      limitsEnabled: false,
      projectsEnabled: true,
      homeDir: home,
      runTokscale,
      sessionMetadataDeps: {
        sessionMetadataResolvers: new Map([
          ['kimi', { resolve: (ids, context) => new Map([...ids].map((id) => [id, context.fileSessionMetadata(id, transcript, {})])) }]
        ])
      }
    });

    const sessions = summary.allTime.sessions;
    assert.equal(sessions['claude:claude-1'].projectId, projectIdentity('/Users/someone/repo-a').projectId);
    assert.equal(
      sessions['kimi:kimi-1'].projectId,
      projectIdentity('/Users/someone/repo-b').projectId,
      'the scan attributing Claude must not switch off Kimi’s resolver'
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the headless agent and the widget agree on the Projects default', () => {
  const agentSource = fs.readFileSync(path.join(__dirname, '../../src/agent/agent.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');

  // One setting, one default: a widget and an agent on the same machine post to
  // the same hub, and a per-entry-point default would make them disagree about
  // whether this device reports projects at all.
  assert.match(agentSource, /TOKEN_MONITOR_PROJECTS_ENABLED,\s*true\)/);
  assert.match(mainSource, /TOKEN_MONITOR_PROJECTS_ENABLED,\s*true\)/);
});
