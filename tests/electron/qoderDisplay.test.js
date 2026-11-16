'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupRows, displayPreference, expandOrder, orderCommit, trackingState, setTracked, healthDetail } = require('../../src/electron/renderer/qoderDisplay');
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

test('fully priced editions omit unpricedTokens without erasing another edition’s unpriced warning', () => {
  const { attributionRows, usageCostLabel } = require('../../src/electron/renderer/usageAttributionRows');
  const rows = attributionRows({ qoder: 100, qodercn: 200 }, { qoder: 1 }, { unpricedTokens: { qodercn: 200 } });
  assert.equal(rows[0].unpricedTokens, undefined, 'priced rows omit the optional zero field');
  for (const versions of [rows, [...rows].reverse()]) {
    const [combined] = groupRows(versions);
    assert.equal(combined.value, 300);
    assert.equal(combined.cost, 1);
    assert.equal(combined.unpricedTokens, 200);
    assert.equal(usageCostLabel(combined.cost, combined.unpricedTokens, value => `$${value}`, String, 'unpriced'), '$1 + 200 unpriced');
  }
  assert.equal(groupRows(attributionRows({ qoder: 100, qodercn: 200 }, { qoder: 1, qodercn: 2 }))[0].unpricedTokens, 0);
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

test('reordering a pinned tool beside a CN-only pinned group preserves the original pin membership', () => {
  const clients = ['qoder', 'qodercn', 'codex', 'claude', 'pi'].map(id => ({ id }));
  assert.deepEqual(orderCommit(['qoder', 'claude', 'codex', 'pi'], clients, '', 'qodercn,codex,claude', 'claude'),
    { pinnedClients: 'qodercn,claude,codex' });
  assert.deepEqual(orderCommit(['codex', 'qoder', 'claude', 'pi'], clients, '', 'qodercn,codex,claude', 'qoder'),
    { pinnedClients: 'codex,qodercn,claude' });
  assert.deepEqual(orderCommit(['claude', 'qoder', 'codex', 'pi'], clients, '', 'qoder,codex,qodercn,claude', 'claude'),
    { pinnedClients: 'claude,qoder,qodercn,codex' });
  assert.deepEqual(orderCommit(['pi', 'qoder', 'codex', 'claude'], clients, '', 'qodercn,codex,claude', 'pi'),
    { clientDisplayOrder: 'pi,qoder,qodercn,codex,claude', pinnedClients: '' });
  assert.deepEqual(orderCommit(['qoder', 'pi', 'claude', 'codex'], clients, 'qoder,qodercn,codex,claude,pi', 'qodercn', 'pi'),
    { clientDisplayOrder: 'qoder,qodercn,pi,claude,codex', pinnedClients: '' });
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

test('one health panel combines edition source checks and usage while retaining per-edition collection and diagnostic identity', () => {
  const edition = (id, tokens, state, day) => ({ id, detail: {
    groups: [
      { id: 'source', key: 'source', state: tokens ? 'detected' : 'missing', checkedCount: 1, detectedCount: tokens ? 1 : 0, checks: [{ id: id + '-projects', exists: tokens > 0 }] },
      { id: 'collection', key: 'collection', state },
      { id: 'data', key: 'data', periods: ['today', 'month', 'allTime'].map(period => ({ period, tokens, cost: tokens / 100 })), lastActivityDay: day }
    ], notes: [{ code: 'source-missing', group: 'source', tone: 'muted' }]
  } });
  const source = [edition('qoder', 120, 'local', '2026-11-13'), edition('qodercn', 80, 'notTracked', '2026-11-14')];
  const before = structuredClone(source);
  const detail = healthDetail(source);
  assert.deepEqual(detail.groups.map(group => group.id), ['source', 'collection', 'data']);
  assert.equal(detail.groups[0].checkedCount, 2);
  assert.equal(detail.groups[0].detectedCount, 2);
  assert.deepEqual(detail.groups[0].checks.map(check => check.id), ['qoder-projects', 'qodercn-projects']);
  assert.deepEqual(detail.groups[1].editions.map(row => [row.id, row.collection.state]), [['qoder', 'local'], ['qodercn', 'notTracked']]);
  assert.deepEqual(detail.groups[2].periods.map(row => [row.tokens, row.cost]), [[200, 2], [200, 2], [200, 2]]);
  assert.equal(detail.groups[2].lastActivityDay, '2026-11-14');
  assert.deepEqual(detail.notes.map(note => note.clientId), ['qoder', 'qodercn']);
  assert.deepEqual(source, before);
  assert.equal(healthDetail([edition('qoder', 0, 'notTracked', ''), edition('qodercn', 0, 'notTracked', '')]).groups[0].state, 'missing');
});
