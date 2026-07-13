'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { clientGradient, projectRowsForPeriod } = require('../../src/electron/renderer/projectRows');

test('projectRowsForPeriod merges sessions by workspace and sorts by cost', () => {
  const rows = projectRowsForPeriod({ sessions: {
    a: { client: 'codex', projectId: 'sha256:a', projectLabel: 'client-a', totalTokens: 100, costUsd: 2, models: { gpt: 100 } },
    b: { client: 'claude', projectId: 'sha256:a', projectLabel: 'client-a', totalTokens: 50, costUsd: 1, models: { claude: 50 } },
    c: { client: 'claude', projectId: 'sha256:b', projectLabel: 'client-b', totalTokens: 500, costUsd: 0.5 },
    d: { client: 'claude', totalTokens: 999, costUsd: 99 }
  } }, { clientLabels: { claude: 'Claude Code', codex: 'Codex' }, clientColors: { codex: '#00aabb', claude: '#cc7755' } });
  assert.equal(rows.length, 2);
  assert.deepEqual({ key: rows[0].key, name: rows[0].name, value: rows[0].value, cost: rows[0].cost, detail: rows[0].detail }, { key: 'sha256:a', name: 'client-a', value: 150, cost: 3, detail: '' });
  assert.deepEqual(rows[0].accordionRows, [
    { key: 'codex', name: 'Codex', value: 100, percent: 100 / 150 * 100, color: '#00aabb' },
    { key: 'claude', name: 'Claude Code', value: 50, percent: 50 / 150 * 100, color: '#cc7755' }
  ]);
  assert.equal(rows[1].name, 'client-b');
  assert.match(rows[0].barBackground, /^linear-gradient\(90deg, /);
  assert.match(rows[0].barBackground, /#00aabb/);
  assert.match(rows[0].barBackground, /#cc7755/);
});

test('clientGradient softly blends tool-share boundaries while preserving endpoints', () => {
  const gradient = clientGradient({ codex: 75, claude: 25 }, (client) => client === 'codex' ? '#111111' : '#eeeeee');
  assert.equal(gradient, 'linear-gradient(90deg, #111111 0%, #111111 73.50%, #eeeeee 76.50%, #eeeeee 100%)');
  assert.equal(clientGradient({ codex: 10 }, () => '#123456'), '#123456');
  assert.equal(clientGradient({ unknown: 10 }, () => undefined, '#abcdef'), '#abcdef');
});

test('projectRowsForPeriod safely aggregates client ids inherited by Object.prototype', () => {
  const rows = projectRowsForPeriod({ sessions: {
    a: { client: 'constructor', projectId: 'sha256:a', projectLabel: 'client-a', totalTokens: 10, costUsd: 1 }
  } }, { clientColors: { constructor: '#123456' } });
  assert.equal(rows[0].accordionRows[0].value, 10);
});

test('projectRowsForPeriod labels unattributed tool usage', () => {
  const rows = projectRowsForPeriod({ sessions: {
    a: { projectId: 'sha256:a', projectLabel: 'client-a', totalTokens: 10, costUsd: 1 }
  } }, { unknownClientLabel: 'Unknown tool' });
  assert.deepEqual(rows[0].accordionRows, [
    { key: 'unknown', name: 'Unknown tool', value: 10, percent: 100, color: '#73bdf5' }
  ]);
});
