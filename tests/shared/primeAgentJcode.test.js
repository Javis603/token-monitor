'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { clientSourceRoots } = require('../../src/shared/clientSources');
const { normalizeClientName } = require('../../src/shared/usage');
const { SOURCE_MARKERS } = require('../../src/shared/clientSourceRegistration');
const { primeAgentSessionRoots } = require('../../src/shared/providers/prime-agent/paths');

test('Prime Agent and Jcode sources match the scanner defaults and overrides', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-paths-'));
  try {
    const roots = clientSourceRoots('prime-agent,jcode', { homeDir, env: {} });
    assert.deepEqual(roots['prime-agent'].map(({ dir }) => dir), [path.join(homeDir, '.prime/agent/sessions'), path.join(homeDir, '.prime/agent/session-artifacts')]);
    assert.equal(roots.jcode[0].dir, path.join(homeDir, '.jcode/sessions'));
    const overridden = clientSourceRoots('prime-agent,jcode', { homeDir, env: { JCODE_HOME: '/custom/jcode', PRIME_AGENT_SESSION_DIR: '~/custom/sessions' } });
    assert.equal(overridden.jcode[0].dir, '/custom/jcode/sessions');
    assert.equal(overridden['prime-agent'][1].dir, path.join(homeDir, 'custom/session-artifacts'));
    assert.deepEqual(clientSourceRoots('claude', { homeDir, env: {} })['prime-agent'], undefined);
    for (const id of ['prime-agent', 'jcode']) assert.ok(SOURCE_MARKERS.some(({ client }) => client === id));
    for (const name of ['Prime Agent', 'prime_agent', 'prime-agent']) assert.equal(normalizeClientName(name), 'prime-agent');
    assert.equal(normalizeClientName('Jcode'), 'jcode');
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('Prime Agent settings precedence mirrors null, empty and legacy env semantics', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-settings-'));
  const cwd = path.join(homeDir, 'project');
  const agent = path.join(homeDir, 'agent');
  const globalFile = path.join(agent, 'settings.json');
  const projectFile = path.join(cwd, '.prime/agent/settings.json');
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.mkdirSync(agent);
  const env = { PRIME_AGENT_CODING_AGENT_DIR: agent };
  const read = (overrides = env) => primeAgentSessionRoots({ homeDir, cwd, env: overrides });
  try {
    fs.writeFileSync(globalFile, JSON.stringify({ sessionDir: '~/global/sessions' }));
    assert.equal(read()[0], path.join(homeDir, 'global/sessions'));
    fs.writeFileSync(projectFile, JSON.stringify({ sessionDir: null }));
    assert.equal(read()[0], path.join(agent, 'sessions'));
    fs.writeFileSync(projectFile, JSON.stringify({ sessionDir: '' }));
    assert.deepEqual(read(), [cwd, path.join(cwd, 'session-artifacts')]);
    fs.writeFileSync(projectFile, '{bad json');
    assert.equal(read()[0], path.join(homeDir, 'global/sessions'));
    assert.equal(read({ ...env, PRIME_AGENT_CODING_AGENT_SESSION_DIR: '~/legacy/sessions' })[0], path.join(homeDir, 'legacy/sessions'));
    // Empty primary override suppresses the legacy spelling; whitespace is a path.
    assert.equal(read({ ...env, PRIME_AGENT_SESSION_DIR: '', PRIME_AGENT_CODING_AGENT_SESSION_DIR: '/ignored' })[0], path.join(homeDir, 'global/sessions'));
    assert.equal(read({ ...env, PRIME_AGENT_SESSION_DIR: ' ' })[0], ' ');
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('Jcode independent reasoning is retained in both live and History totals', () => {
  const { extractUsageFromTokscale } = require('../../src/shared/usage');
  const { sumTokens, sumOutputTokens } = require('../../src/shared/history');
  const row = { client: 'jcode', sessionId: 'jcode-contract', model: 'claude-sonnet-4-5', input: 1000, output: 400, cacheRead: 200, cacheWrite: 50, reasoning: 150 };
  const usage = extractUsageFromTokscale({ entries: [row] });
  assert.equal(usage.totalTokens, 1800);
  assert.equal(usage.clientOutputs.jcode, 550);
  assert.equal(sumTokens(row, 'jcode'), 1800);
  assert.equal(sumOutputTokens(row, 'jcode'), 550);
});
