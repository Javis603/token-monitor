'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inferModelAliases,
  createModelAliasResolver,
  projectModelAliasStats,
  projectModelAliasHistory
} = require('../../src/electron/modelAliasPresentation');

test('observed provider, separator and case variants merge; vendor suffixes do not', () => {
  const models = [
    'anthropic/claude-opus-5',
    'claude-opus-5',
    'claude-opus-5-cc',
    'openrouter/anthropic/Claude.Sonnet_4.5',
    'claude-sonnet-4-5',
    'gpt-5.5',
    'gpt-5.5-pro',
    'claude-sonnet-4-5-20260901'
  ];
  const resolve = createModelAliasResolver({}, models, 'duplicates');
  assert.equal(resolve('anthropic/claude-opus-5'), 'claude-opus-5');
  assert.equal(resolve('openrouter/anthropic/Claude.Sonnet_4.5'), 'claude-sonnet-4-5');
  assert.equal(resolve('gpt-5.5-pro'), 'gpt-5.5-pro');
  assert.equal(resolve('claude-sonnet-4-5-20260901'), 'claude-sonnet-4-5-20260901');
  // `-cc` marks a supply channel in someone else's naming convention, not a spelling
  // of the same id. Folding it is one manual alias away, which is where tokscale's
  // own modelAliases leaves it too.
  assert.equal(resolve('claude-opus-5-cc'), 'claude-opus-5-cc');
  assert.deepEqual(inferModelAliases(models, 'duplicates'), {
    'anthropic/claude-opus-5': 'claude-opus-5',
    'openrouter/anthropic/Claude.Sonnet_4.5': 'claude-sonnet-4-5'
  });
});

test('a lone qualified model is not renamed without duplicate evidence', () => {
  const model = 'anthropic/claude-opus-5';
  assert.equal(createModelAliasResolver({}, [model], 'duplicates')(model), model);
  assert.deepEqual(inferModelAliases([model], 'duplicates'), {});
});

test('manual aliases override one source or the whole inferred duplicate family', () => {
  const models = ['anthropic/claude-opus-5', 'claude-opus-5'];
  const family = createModelAliasResolver({ 'claude-opus-5': 'opus' }, models, 'duplicates');
  assert.equal(family('anthropic/claude-opus-5'), 'opus');
  assert.equal(family('claude-opus-5'), 'opus');

  const source = createModelAliasResolver({ 'anthropic/claude-opus-5': 'provider-specific' }, models, 'duplicates');
  assert.equal(source('anthropic/claude-opus-5'), 'provider-specific');
  assert.equal(source('claude-opus-5'), 'claude-opus-5');
});

test('automatic folding covers live, nested and historical model maps without changing source data', () => {
  const stats = {
    periods: {
      today: {
        totalTokens: 60,
        costUsd: 6,
        models: {
          'anthropic/claude-opus-5': 10,
          'claude-opus-5': 20,
          'openrouter/anthropic/Claude.Sonnet_4.5': 12,
          'claude-sonnet-4-5': 18
        },
        modelCosts: {
          'anthropic/claude-opus-5': 1,
          'claude-opus-5': 2,
          'openrouter/anthropic/Claude.Sonnet_4.5': 1.2,
          'claude-sonnet-4-5': 1.8
        },
        sessions: {
          one: {
            model: 'anthropic/claude-opus-5',
            models: { 'anthropic/claude-opus-5': 10 }
          }
        }
      }
    },
    nativeSessions: {
      today: {
        native: { model: 'openrouter/anthropic/Claude.Sonnet_4.5', totalTokens: 12 }
      }
    }
  };
  const source = structuredClone(stats);
  const projected = projectModelAliasStats(stats, {}, { grouping: 'duplicates' });
  assert.deepEqual(projected.periods.today.models, {
    'claude-opus-5': 30,
    'claude-sonnet-4-5': 30
  });
  assert.deepEqual(projected.periods.today.modelCosts, {
    'claude-opus-5': 3,
    'claude-sonnet-4-5': 3
  });
  assert.equal(projected.periods.today.sessions.one.model, 'claude-opus-5');
  assert.equal(projected.nativeSessions.today.native.model, 'claude-sonnet-4-5');
  assert.deepEqual(stats, source);
});

test('history-only duplicate evidence is enough to fold daily, monthly and favorite model', () => {
  const history = {
    daily: [{
      date: '2026-09-12',
      perModel: {
        'anthropic/claude-opus-5': { tokens: 10, cost: 1, unclassifiedTokens: 0 },
        'claude-opus-5': { tokens: 20, cost: 2, unclassifiedTokens: 0 }
      }
    }],
    monthly: [{
      month: '2026-09',
      perModel: {
        'anthropic/claude-opus-5': { tokens: 10, cost: 1, unclassifiedTokens: 0 },
        'claude-opus-5': { tokens: 20, cost: 2, unclassifiedTokens: 0 }
      }
    }],
    summary: { totalTokens: 30, totalCost: 3, favoriteModel: 'anthropic/claude-opus-5' }
  };
  const projected = projectModelAliasHistory(history, {}, { grouping: 'duplicates' });
  assert.deepEqual(projected.daily[0].perModel, {
    'claude-opus-5': { tokens: 30, cost: 3, unclassifiedTokens: 0 }
  });
  assert.equal(projected.summary.favoriteModel, 'claude-opus-5');
});

test('automatic grouping is opt-in and manual aliases apply either way', () => {
  const stats = {
    periods: { today: { models: { 'anthropic/claude-opus-5': 10, 'claude-opus-5': 20 } } }
  };
  // Default: two spellings of one model stay apart until the user asks for grouping.
  assert.strictEqual(projectModelAliasStats(stats, {}), stats);
  assert.deepEqual(
    projectModelAliasStats(stats, {}, { grouping: 'off' }).periods.today.models,
    { 'anthropic/claude-opus-5': 10, 'claude-opus-5': 20 }
  );
  assert.deepEqual(
    projectModelAliasStats(stats, {}, { grouping: 'duplicates' }).periods.today.models,
    { 'claude-opus-5': 30 }
  );
  // A typed alias is not gated on the setting.
  assert.deepEqual(
    projectModelAliasStats(stats, { 'anthropic/claude-opus-5': 'claude-opus-5' }).periods.today.models,
    { 'claude-opus-5': 30 }
  );
});

test('a history projection is opt-in the same way', () => {
  const history = {
    daily: [{ date: '2026-09-12', perModel: { 'anthropic/claude-opus-5': { tokens: 10 }, 'claude-opus-5': { tokens: 20 } } }],
    monthly: [],
    summary: { totalTokens: 30, favoriteModel: 'claude-opus-5' }
  };
  assert.strictEqual(projectModelAliasHistory(history, {}), history);
  assert.deepEqual(
    projectModelAliasHistory(history, {}, { grouping: 'duplicates' }).daily[0].perModel,
    // unclassifiedTokens is re-derived because the fixture carries no component
    // breakdown, which is the existing merge rule rather than anything opt-in.
    { 'claude-opus-5': { tokens: 30, unclassifiedTokens: 30 } }
  );
});

test('strip-prefix grouping also shortens a name that stands alone', () => {
  const models = ['commandcode/deepseek-v4.1-flash', 'gpt-5.6-sol', 'anthropic/claude-opus-5', 'claude-opus-5'];
  // 'duplicates' leaves the lone qualified name alone; 'prefix' is the same pass
  // without that guard, so it is a superset and never splits what 'duplicates' joined.
  assert.deepEqual(inferModelAliases(models, 'duplicates'), { 'anthropic/claude-opus-5': 'claude-opus-5' });
  assert.deepEqual(inferModelAliases(models, 'prefix'), {
    'commandcode/deepseek-v4.1-flash': 'deepseek-v4.1-flash',
    'anthropic/claude-opus-5': 'claude-opus-5'
  });
  // A bare name has no prefix to strip, so neither mode renames it.
  assert.equal(createModelAliasResolver({}, models, 'prefix')('gpt-5.6-sol'), 'gpt-5.6-sol');
});

test('an unknown or missing grouping mode collects nothing', () => {
  const stats = { periods: { today: { models: { 'anthropic/claude-opus-5': 10, 'claude-opus-5': 20 } } } };
  for (const grouping of [undefined, null, '', 'nonsense', 'off']) {
    assert.strictEqual(projectModelAliasStats(stats, {}, { grouping }), stats);
  }
  assert.deepEqual(
    projectModelAliasStats(stats, {}, { grouping: 'prefix' }).periods.today.models,
    { 'claude-opus-5': 30 }
  );
});

test('stripping prefixes merges names that land on the same short form', () => {
  // Grouping keys on the normalized last segment and renames to that segment, so two
  // supply channels for one model necessarily land in the same row. That is the point
  // of the mode, and the reason it is a separate choice rather than a refinement of
  // merge-duplicates: the prefix is often the only thing telling the two apart.
  const models = ['openai/gpt-5.5', 'azure/gpt-5.5'];
  const resolve = createModelAliasResolver({}, models, 'prefix');
  assert.equal(resolve('openai/gpt-5.5'), 'gpt-5.5');
  assert.equal(resolve('azure/gpt-5.5'), 'gpt-5.5');
  const stats = { periods: { today: { models: { 'openai/gpt-5.5': 10, 'azure/gpt-5.5': 25 } } } };
  assert.deepEqual(projectModelAliasStats(stats, {}, { grouping: 'prefix' }).periods.today.models, { 'gpt-5.5': 35 });
  // merge-duplicates reaches the same rows here, because both spellings are present.
  assert.deepEqual(projectModelAliasStats(stats, {}, { grouping: 'duplicates' }).periods.today.models, { 'gpt-5.5': 35 });
});
