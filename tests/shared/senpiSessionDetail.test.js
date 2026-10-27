'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readSessionDetail } = require('../../src/shared/sessionDetail');
const { senpiSourceRoots } = require('../../src/shared/providers/senpi/paths');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-senpi-home-'));
}

function writeSession(dir, sessionId, usage) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-07-29T15-19-53-436Z_${sessionId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-07-29T15:19:53.436Z', cwd: '/tmp/workspace' }),
    JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: '2026-07-29T15:20:01.000Z',
      message: {
        role: 'assistant',
        model: 'grok-4.7',
        provider: 'xai',
        content: [{ type: 'text', text: 'done' }],
        usage
      }
    })
  ].join('\n'));
  return file;
}

test('OmO Native detail reads ~/.omo/agent/sessions and does not add reasoning to the total', () => {
  const home = tmpHome();
  try {
    const sessionId = 'senpi-main';
    writeSession(path.join(home, '.omo', 'agent', 'sessions', '-tmp-workspace'), sessionId, {
      input: 100, output: 40, cacheRead: 20, cacheWrite: 5, reasoning: 10, totalTokens: 165,
      cost: { total: 0.0032 }
    });

    const detail = readSessionDetail({ client: 'senpi', sessionId, sessionCost: 99, home, env: {} });

    assert.equal(detail.found, true);
    assert.equal(detail.exchanges[0].turns[0].tokens.reasoning, 10);
    assert.equal(detail.exchanges[0].turns[0].tokens.total, 165, 'reasoning is already inside output');
    assert.ok(Math.abs(detail.totals.costUsd - 0.0032) < 1e-9);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('SENPI_CODING_AGENT_DIR replaces only the legacy senpi root', () => {
  const home = path.join(path.sep, 'tmp', 'senpi-home');
  const roots = senpiSourceRoots(home, { SENPI_CODING_AGENT_DIR: '/custom/senpi-agent' }, { cwdDir: home });
  assert.deepEqual(roots.map(([id]) => id), ['senpi-sessions', 'senpi-omo-sessions', 'senpi-task-children']);
  assert.equal(roots[0][1], path.join('/custom/senpi-agent', 'sessions'));
  assert.equal(roots[1][1], path.join(home, '.omo', 'agent', 'sessions'));
  assert.equal(roots[2][1], path.join(home, '.omo', 'senpi-task', 'children'));
});
