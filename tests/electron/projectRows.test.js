'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { clientGradient, projectBreakdownIncomplete, projectRowsForPeriod } = require('../../src/electron/renderer/projectRows');
const { projectModelAliasStats } = require('../../src/electron/modelAliasPresentation');

test('projectBreakdownIncomplete only flags the all-time project breakdown', () => {
  const stats = { projectsIncomplete: true };
  assert.equal(projectBreakdownIncomplete(stats, 'allTime'), true);
  assert.equal(projectBreakdownIncomplete(stats, 'today'), false);
  assert.equal(projectBreakdownIncomplete(stats, 'month'), false);
  assert.equal(projectBreakdownIncomplete({ projectsIncomplete: false }, 'allTime'), false);
});

test('projectBreakdownIncomplete flags bounded synchronized periods', () => {
  const stats = { periodProjectsOmitted: { month: 12 } };
  assert.equal(projectBreakdownIncomplete(stats, 'today'), false);
  assert.equal(projectBreakdownIncomplete(stats, 'month'), true);
  assert.equal(projectBreakdownIncomplete(stats, 'allTime'), false);
});

test('projectRowsForPeriod merges sessions by workspace and sorts by cost', () => {
  const rows = projectRowsForPeriod({ sessions: {
    a: { client: 'codex', projectId: 'sha256:a', projectLabel: 'client-a', totalTokens: 100, costUsd: 2, models: { gpt: 100 } },
    b: { client: 'claude', projectId: 'sha256:a', projectLabel: 'client-a', totalTokens: 50, costUsd: 1, models: { claude: 50 } },
    c: { client: 'claude', projectId: 'sha256:b', projectLabel: 'client-b', totalTokens: 500, costUsd: 0.5 },
    d: { client: 'claude', totalTokens: 999, costUsd: 99 }
  } }, { clientLabels: { claude: 'Claude Code', codex: 'Codex' }, clientColors: { codex: '#00aabb', claude: '#cc7755' } });
  assert.equal(rows.length, 2);
  assert.deepEqual({ key: rows[0].key, name: rows[0].name, value: rows[0].value, cost: rows[0].cost, detail: rows[0].detail }, { key: 'client-a', name: 'client-a', value: 150, cost: 3, detail: '' });
  assert.deepEqual(rows[0].accordionRows, [
    { key: 'codex', name: 'Codex', value: 100, percent: 100 / 150 * 100, color: '#00aabb' },
    { key: 'claude', name: 'Claude Code', value: 50, percent: 50 / 150 * 100, color: '#cc7755' }
  ]);
  assert.equal(rows[1].name, 'client-b');
  assert.match(rows[0].barBackground, /^linear-gradient\(90deg, /);
  assert.match(rows[0].barBackground, /#00aabb/);
  assert.match(rows[0].barBackground, /#cc7755/);
});

test('projectRowsForPeriod prefers the bounded project rollup', () => {
  const rows = projectRowsForPeriod({
    projects: {
      'token monitor': {
        label: 'Token Monitor',
        tokens: 300,
        costUsd: 2.5,
        clients: { codex: 200, claude: 100 }
      }
    },
    sessions: {
      ignored: { client: 'codex', projectLabel: 'Ignored', totalTokens: 999, costUsd: 99 }
    }
  }, { clientLabels: { codex: 'Codex', claude: 'Claude Code' } });

  assert.equal(rows.length, 1);
  assert.deepEqual(
    { key: rows[0].key, name: rows[0].name, value: rows[0].value, cost: rows[0].cost },
    { key: 'token monitor', name: 'Token Monitor', value: 300, cost: 2.5 }
  );
  assert.deepEqual(rows[0].accordionRows.map(({ key, value }) => ({ key, value })), [
    { key: 'codex', value: 200 },
    { key: 'claude', value: 100 }
  ]);
});

test('project rows default to tool share and can show alias-aware model share with an unknown remainder', () => {
  const period = {
    projects: {
      app: {
        label: 'App',
        tokens: 200,
        costUsd: 1.25,
        clients: { codex: 150, claude: 50 },
        models: { 'vendor/gpt-5': 70, 'gpt-5': 50, 'claude-sonnet': 40 }
      }
    }
  };
  const tools = projectRowsForPeriod(period, { clientLabels: { codex: 'Codex', claude: 'Claude Code' } });
  assert.equal(tools[0].value, 200);
  assert.deepEqual(tools[0].accordionRows.map(({ key, value }) => ({ key, value })), [
    { key: 'codex', value: 150 },
    { key: 'claude', value: 50 }
  ]);

  const aliasedStats = projectModelAliasStats({ periods: { today: period } }, { 'vendor/gpt-5': 'gpt-5' });
  const models = projectRowsForPeriod(aliasedStats.periods.today, {
    shareBy: 'model',
    modelColor: (model) => model === 'gpt-5' ? '#111111' : '#eeeeee',
    unknownModelLabel: 'Unknown model'
  });
  assert.equal(models[0].value, 200);
  assert.equal(models[0].cost, 1.25);
  assert.deepEqual(models[0].accordionRows.map(({ key, name, value }) => ({ key, name, value })), [
    { key: 'gpt-5', name: 'gpt-5', value: 120 },
    { key: 'claude-sonnet', name: 'claude-sonnet', value: 40 },
    { key: 'unknown', name: 'Unknown model', value: 40 }
  ]);
  assert.equal(models[0].accordionRows.reduce((sum, row) => sum + row.value, 0), models[0].value);
  assert.match(models[0].barBackground, /#111111/);
  assert.match(models[0].barBackground, /#eeeeee/);
  assert.match(models[0].barBackground, /var\(--muted\)/);
});

test('project model share caps malformed attribution at the project total', () => {
  const [row] = projectRowsForPeriod({
    projects: { app: { label: 'App', tokens: 50, models: { alpha: 40, beta: 40 } } }
  }, { shareBy: 'model', unknownModelLabel: 'Unknown model' });
  assert.equal(row.value, 50);
  assert.deepEqual(row.accordionRows.map(({ key, value }) => ({ key, value })), [
    { key: 'alpha', value: 40 },
    { key: 'beta', value: 10 }
  ]);
  assert.equal(row.accordionRows.reduce((sum, entry) => sum + entry.value, 0), 50);
});

test('project model share does not infer missing model data from partial session details', () => {
  for (const models of [undefined, { 'gpt-5': 0 }]) {
    const project = { label: 'App', tokens: 100, clients: { codex: 100 } };
    if (models !== undefined) project.models = models;
    const [row] = projectRowsForPeriod({
      projects: { app: project },
      sessions: {
        partial: {
          client: 'codex',
          projectLabel: 'App',
          totalTokens: 100,
          models: { 'gpt-5': 100 }
        }
      }
    }, { shareBy: 'model', unknownModelLabel: 'Unknown model' });

    assert.equal(row.value, 100);
    assert.deepEqual(row.accordionRows.map(({ key, name, value }) => ({ key, name, value })), [
      { key: 'unknown', name: 'Unknown model', value: 100 }
    ]);
  }
});

test('project model share leaves incomplete session-derived project usage unattributed', () => {
  const [row] = projectRowsForPeriod({
    sessions: {
      partial: {
        client: 'codex',
        projectLabel: 'App',
        totalTokens: 100,
        models: { 'gpt-5': 100 }
      }
    }
  }, {
    shareBy: 'model',
    allowSessionModelAttribution: false,
    unknownModelLabel: 'Unknown model'
  });

  assert.equal(row.value, 100);
  assert.deepEqual(row.accordionRows.map(({ key, name, value }) => ({ key, name, value })), [
    { key: 'unknown', name: 'Unknown model', value: 100 }
  ]);
});

test('project model maps safely retain reserved keys without prototype pollution', () => {
  const period = JSON.parse('{"projects":{"app":{"label":"App","tokens":9,"models":{"__proto__":4,"constructor":3,"prototype":2}}}}');
  const [row] = projectRowsForPeriod(period, { shareBy: 'model' });

  assert.equal(Object.getPrototypeOf(row.modelTokens), null);
  assert.deepEqual(row.accordionRows.map(({ key, value }) => ({ key, value })), [
    { key: '__proto__', value: 4 },
    { key: 'constructor', value: 3 },
    { key: 'prototype', value: 2 }
  ]);
  assert.equal({}.polluted, undefined);
});

test('projectRowsForPeriod recovers trusted native attribution from local sessions when the native rollup is absent', () => {
  const rows = projectRowsForPeriod({
    projects: {
      'token monitor': { label: 'Token Monitor', tokens: 300, costUsd: 2.5, clients: { codex: 300 } }
    }
  }, {
    nativeProjects: {},
    nativeSessions: {
      'reasonix:project-session': {
        native: true,
        client: 'reasonix',
        projectId: 'sha256:token-monitor',
        projectLabel: 'Token Monitor',
        totalTokens: 140,
        periodTokenDataUnavailable: false
      }
    },
    clientLabels: { codex: 'Codex', reasonix: 'Reasonix' },
    clientColors: { codex: '#00aabb', reasonix: '#4d6bfe' }
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 440);
  assert.equal(rows[0].cost, 2.5);
  assert.deepEqual(rows[0].accordionRows.map(({ key, value }) => ({ key, value })), [
    { key: 'codex', value: 300 },
    { key: 'reasonix', value: 140 }
  ]);
});

test('projectRowsForPeriod merges noncanonical rollup keys with the same identity', () => {
  const rows = projectRowsForPeriod({
    projects: {
      'legacy-cafe': { label: 'Café', tokens: 100, costUsd: 1, clients: { codex: 100 } },
      'legacy-cafe-uppercase': { label: 'CAFÉ', tokens: 50, costUsd: 0.5, clients: { codex: 25, claude: 25 } }
    }
  }, { clientLabels: { codex: 'Codex', claude: 'Claude Code' } });

  assert.equal(rows.length, 1);
  assert.deepEqual(
    { key: rows[0].key, name: rows[0].name, value: rows[0].value, cost: rows[0].cost },
    { key: 'café', name: 'CAFÉ', value: 150, cost: 1.5 }
  );
  assert.deepEqual(rows[0].accordionRows.map(({ key, value }) => ({ key, value })), [
    { key: 'codex', value: 125 },
    { key: 'claude', value: 25 }
  ]);
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


test('project missing-price counts stay finite and bounded for rollups and session fallback', () => {
  for (const missing of [Infinity, NaN, 'bad', -10, 500, '50']) {
    const expected = missing === 500 ? 100 : missing === '50' ? 50 : 0;
    for (const period of [
      { projects: { fixture: { label: 'Fixture', tokens: 100, unpricedTokens: missing } } },
      { sessions: { fixture: { client: 'codex', projectLabel: 'Fixture', totalTokens: 100, unpricedTokens: missing } } }
    ]) {
      const [row] = projectRowsForPeriod(period);
      assert.equal(row.unpricedTokens || 0, expected);
    }
  }
});
