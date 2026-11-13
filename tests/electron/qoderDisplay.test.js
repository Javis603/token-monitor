'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupRows, displayPreference, expandOrder, trackingState, setTracked } = require('../../src/electron/renderer/qoderDisplay');
const { clientsCsvForSetting, DEFAULT_CLIENTS } = require('../../src/shared/clientTracking');

test('combines visible editions without changing source rows, totals or unrelated identities', () => {
  const rows = [
    { key: 'codex', value: 7, cost: 0.1 },
    { key: 'qodercn', value: 30, cost: 2, unpricedTokens: 3, outputTokens: 10,
      modelRows: [{ key: 'auto', value: 10, cost: 0, unpricedTokens: 3 }, { key: 'gpt-5', value: 20, cost: 2 }] },
    { key: 'qoder', value: 70, cost: 4, unpricedTokens: 0, outputTokens: 20,
      modelRows: [{ key: 'gpt-5', value: 70, cost: 4 }] }
  ];
  const before = structuredClone(rows);
  const merged = groupRows(rows);
  assert.equal(merged.length, 2);
  assert.strictEqual(merged[0], rows[0]);
  assert.deepEqual(merged.map(r => r.key), ['codex', 'qoder']);
  assert.equal(merged[1].value, 100);
  assert.equal(merged[1].cost, 6);
  assert.equal(merged[1].outputTokens, 30);
  assert.equal(merged[1].unpricedTokens, 3);
  assert.equal(merged[1].cacheReadTokens, undefined, 'unknown attribution stays unknown');
  assert.deepEqual(merged[1].modelRows.map(m => [m.key, m.value, m.cost, m.percent]), [['gpt-5', 90, 6, 90], ['auto', 10, 0, 10]]);
  assert.deepEqual(rows, before);
  assert.strictEqual(groupRows(rows, true), rows, 'separate display has no projection allocation');
});

test('a hidden edition is excluded before grouping; CN-only displays as Qoder without inventing usage', () => {
  const { applyClientDisplayPreferences } = require('../../src/electron/renderer/clientDisplayPreferences');
  const clients = [{ id: 'qoder' }, { id: 'qodercn' }];
  const source = [{ key: 'qoder', name: 'Qoder', value: 70, cost: 4 }, { key: 'qodercn', name: 'Qoder CN', value: 30, cost: 2 }];
  const visible = applyClientDisplayPreferences(source, '', 'qoder', clients, '');
  const rows = groupRows(visible);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Qoder');
  assert.equal(rows[0].value, 30);
  assert.equal(rows[0].cost, 2);
  assert.deepEqual(groupRows([]), []);
});

test('group display preferences preserve individual settings and grouping moves both real ids', () => {
  const saved = 'codex,qodercn,claude,qoder';
  assert.equal(displayPreference(saved, false), 'codex,qoder,claude');
  assert.equal(displayPreference(saved, true), saved);
  assert.deepEqual(expandOrder(['codex', 'qoder', 'claude']), ['codex', 'qoder', 'qodercn', 'claude']);
});

test('fresh defaults enable both but saved CN-only, empty and explicit selections are never expanded', () => {
  for (const id of ['qoder', 'qodercn']) assert.ok(DEFAULT_CLIENTS.split(',').includes(id));
  assert.equal(clientsCsvForSetting('qodercn'), 'qodercn');
  assert.equal(clientsCsvForSetting(''), '');
  assert.equal(clientsCsvForSetting('codex,qoder'), 'codex,qoder');
  assert.deepEqual(trackingState('codex,qodercn'), { checked: false, mixed: true });
  assert.deepEqual(trackingState(''), { checked: false, mixed: false });
  assert.equal(setTracked('codex,qodercn', true), 'codex,qoder,qodercn');
  assert.equal(setTracked('qoder,codex,qodercn', false), 'codex');
  assert.equal(setTracked('codex,qodercn', false), 'codex');
});
