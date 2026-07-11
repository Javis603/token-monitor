'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projectName, projectRowsForPeriod } = require('../../src/electron/renderer/projectRows');

test('projectRowsForPeriod merges sessions by workspace and sorts by cost', () => {
  const rows = projectRowsForPeriod({ sessions: {
    a: { client: 'claude', projectPath: '/work/client-a/', totalTokens: 100, costUsd: 2 },
    b: { client: 'codex', projectPath: '/work/client-a', totalTokens: 50, costUsd: 1 },
    c: { client: 'claude', projectPath: '/work/client-b', totalTokens: 500, costUsd: 0.5 },
    d: { client: 'claude', totalTokens: 999, costUsd: 99 }
  } }, { clientLabels: { claude: 'Claude Code', codex: 'Codex' } });
  assert.equal(rows.length, 2);
  assert.deepEqual({ key: rows[0].key, name: rows[0].name, value: rows[0].value, cost: rows[0].cost, detail: rows[0].detail }, { key: '/work/client-a', name: 'client-a', value: 150, cost: 3, detail: 'Claude Code, Codex' });
  assert.equal(rows[1].name, 'client-b');
});

test('projectName supports Windows and POSIX paths', () => {
  assert.equal(projectName('C:\\Code\\token-monitor'), 'token-monitor');
  assert.equal(projectName('/work/token-monitor/'), 'token-monitor');
});
