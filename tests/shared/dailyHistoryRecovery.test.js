'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { runRecoveryScenario } = require('../fixtures/dailyHistoryRecovery');
const root = path.resolve(__dirname, '../..');
const run = scenario => runRecoveryScenario(root, scenario);

for (const scenario of ['graph-rename', 'headless-graph-rename']) {
  test(`${scenario}: a captured 100 -> 120 model correction keeps graph and allTime at 120 after reopen`, () => {
    const { visible, graph, absent, graphAfterReopen, observedModels } = run(scenario);
    assert.equal(visible.tokens, 120);
    assert.equal(visible.cost, 1.2);
    assert.deepEqual(visible.models, { 'new-model': 120 });
    assert.deepEqual(graph, { tokens: 120, cost: 1.2, models: { 'new-model': 120 } });
    assert.deepEqual(absent, visible);
    assert.deepEqual(graphAfterReopen, graph);
    assert.deepEqual(observedModels, ['new-model', 'old-model']);
  });
}

test('daily-only old 100 remains eligible for allTime recovery beside new 120 without changing the selected graph day', () => {
  const { visible, graph, absent, graphAfterReopen, observedModels } = run('graph-daily-only');
  assert.equal(visible.tokens, 220);
  assert.equal(visible.cost, 2.2);
  assert.deepEqual(visible.models, { 'new-model': 120, 'old-model': 100 });
  assert.deepEqual(graph, { tokens: 120, cost: 1.2, models: { 'new-model': 120 } });
  assert.deepEqual(absent, visible);
  assert.deepEqual(graphAfterReopen, graph);
  assert.deepEqual(observedModels, ['new-model']);
});

test('a full graph already containing old and new models retains its existing whole-day limitation', () => {
  const { visible, graph, absent } = run('graph-full-rename');
  assert.equal(visible.tokens, 120);
  assert.equal(visible.cost, 1.2);
  assert.deepEqual(graph, { tokens: 220, cost: 2.2, models: { 'old-model': 100, 'new-model': 120 } });
  assert.deepEqual(absent, visible);
});

test('daily-only legacy history restores the 20-day #808 model gap once', () => {
  const { first, repeated, dailyDays } = run('legacy');
  assert.equal(dailyDays, 20);
  assert.equal(first.models['claude-opus-4-8'], 234112672);
  assert.equal(first.models.sonnet, 20);
  assert.equal(first.tokens, 234112692);
  assert.deepEqual(repeated, first);
});

test('daily retention never reverses 100 -> 20 -> 0 through SQLite reopen and omission', () => {
  const { states, committed } = run('corrections');
  assert.deepEqual(states.map(s => s.tokens), [100, 20, 0, 0]);
  assert.deepEqual(states.map(s => s.cost), [1, 0.2, 0, 0]);
  assert.equal(committed, 0);
});

test('a model correction keeps prior model coverage after SQLite reopen', () => {
  const { renamed, absent, observedModels, leaksLocalCoverage } = run('rename');
  assert.deepEqual(renamed.models, { 'new-model': 100 });
  assert.deepEqual(absent.models, { 'new-model': 100 });
  assert.deepEqual(observedModels, ['new-model', 'old-model']);
  assert.equal(leaksLocalCoverage, false);
});

test('growing tokens with a lower or zero cost cannot pick up an old daily price', () => {
  const { lower, free, absent } = run('repricing');
  assert.equal(lower.tokens, 120);
  assert.equal(lower.cost, 1);
  assert.equal(free.cost, 0);
  assert.equal(absent.cost, 0);
});

test('a partial same-model gap remains unresolved instead of overriding a possible correction', () => {
  assert.equal(run('partial').tokens, 400);
});

test('unknown current attribution cannot authorize recovery of an absent named model', () => {
  const result = run('unknown');
  assert.equal(result.tokens, 50);
  assert.equal(result.models.opus, undefined);
});

test('a separate missing cost-only model restores its recorded cost without tokens', () => {
  const result = run('cost-only');
  assert.equal(result.tokens, 20);
  assert.equal(result.cost, 6);
});

test('disabling session retention also disables legacy daily recovery', () => {
  assert.equal(run('disabled').tokens, 20);
});

for (const scenario of ['codex-native', 'headless-codex-native']) {
  test(`${scenario}: native Codex daily history remains recoverable`, () => {
    assert.equal(run(scenario).tokens, 100);
  });
}

for (const scenario of ['codex-with-dots', 'codex-with-known-dots']) {
  test(`${scenario}: Dots neither suppresses native recovery nor survives hiding through generic archives`, () => {
    const { visible, hidden, reopened, repeated } = run(scenario);
    assert.equal(visible.tokens, 150);
    assert.equal(visible.models['retired-native'], scenario === 'codex-with-known-dots' ? 150 : 100);
    assert.equal(hidden.tokens, 100);
    assert.deepEqual(repeated, visible);
    assert.deepEqual(reopened, hidden);
  });
}

test('an uncaptured native zero still excludes recovery beside same-model Dots usage in a preview', () => {
  const { visible, repeated, archiveUnchanged } = run('codex-preview-zero');
  assert.equal(visible.tokens, 50);
  assert.equal(visible.cost, 0);
  assert.deepEqual(repeated, visible);
  assert.equal(archiveUnchanged, true);
});

test('released MiMo aliases cannot revive a zero observation via daily history', () => {
  const { zero, absent } = run('alias');
  assert.equal(zero.tokens, 0);
  assert.equal(absent.tokens, 0);
});

test('a read-only preview applies the correction without capturing or reviving daily usage', () => {
  const { visible, archiveUnchanged } = run('preview');
  assert.equal(visible.tokens, 20);
  assert.equal(archiveUnchanged, true);
});


test('named legacy sessions do not exclude an entirely absent historical model', () => {
  const result = run('legacy-session');
  assert.equal(result.tokens, 120);
  assert.equal(result.models.opus, 100);
});

for (const scenario of ['legacy-profile', 'headless-legacy-profile', 'legacy-profile-preview']) {
  test(`${scenario}: the #808 gap recovers alongside 2,859 pre-upgrade session rows`, () => {
    const { first, repeated, dailyDays, legacySessions, archiveUnchanged, absent } = run(scenario);
    assert.equal(dailyDays, 20);
    assert.equal(legacySessions, 2859);
    assert.equal(first.models['claude-opus-4-8'], 234112672);
    assert.equal(first.models.sonnet, 2879);
    assert.equal(first.tokens, 234115551);
    assert.deepEqual(repeated, first);
    if (scenario.endsWith('preview')) assert.equal(archiveUnchanged, true);
    else assert.deepEqual(absent, first);
  });
}

for (const [scenario, tokens, cost, models] of [
  ['legacy-rename', 20, 1, { sonnet: 20 }],
  ['legacy-zero', 0, 0, { opus: 0 }],
  ['legacy-repricing', 120, 1, { opus: 120 }],
  ['legacy-unknown', 20, 1, { sonnet: 20 }]
]) {
  test(`${scenario}: pre-upgrade observations still exclude unsafe recovery after SQLite reopen`, () => {
    const { first, absent } = run(scenario);
    assert.equal(first.tokens, tokens);
    assert.equal(first.cost, cost);
    assert.deepEqual(first.models, models);
    assert.equal(absent.tokens, tokens);
    assert.equal(absent.cost, cost);
    if (tokens > 0) assert.deepEqual(absent, first);
    else assert.deepEqual(absent.models, {});
  });
}

test('headless publication preserves downward corrections through reopen and omission', () => {
  const { states, committed } = run('headless-corrections');
  assert.deepEqual(states.map(s => s.tokens), [100, 20, 0, 0]);
  assert.equal(committed, 0);
});

test('headless dry-run keeps both the corrected projection and the committed archive', () => {
  const { visible, archiveUnchanged } = run('dry-run');
  assert.equal(visible.tokens, 20);
  assert.equal(archiveUnchanged, true);
});


test('an out-of-order capture may add exclusion evidence without replacing current accounting', () => {
  const { visible, observedModels } = run('stale-capture');
  assert.equal(visible.tokens, 20);
  assert.deepEqual(visible.models, { 'current-model': 20 });
  assert.deepEqual(observedModels, ['current-model', 'old-model']);
});

test('unknown model evidence stays conservative after a later named correction and reopen', () => {
  const result = run('unknown-upgrade');
  assert.equal(result.tokens, 50);
  assert.equal(result.models.opus, undefined);
});

test('an unknown client can overlap any historical named client', () => {
  assert.equal(run('cross-client-unknown').tokens, 50);
});


test('an unknown client zero remains an unresolved global scope after reopen', () => {
  assert.equal(run('unknown-client-zero').tokens, 0);
});
