'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inferModelAliases,
  createModelAliasResolver,
  projectModelAliasStats,
  projectModelAliasHistory
} = require('../../src/electron/modelAliasPresentation');

test('observed provider, separator, case and Claude Code variants merge automatically', () => {
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
  const resolve = createModelAliasResolver({}, models);
  assert.equal(resolve('anthropic/claude-opus-5'), 'claude-opus-5');
  assert.equal(resolve('claude-opus-5-cc'), 'claude-opus-5');
  assert.equal(resolve('openrouter/anthropic/Claude.Sonnet_4.5'), 'claude-sonnet-4-5');
  assert.equal(resolve('gpt-5.5-pro'), 'gpt-5.5-pro');
  assert.equal(resolve('claude-sonnet-4-5-20260901'), 'claude-sonnet-4-5-20260901');
  assert.deepEqual(inferModelAliases(models), {
    'anthropic/claude-opus-5': 'claude-opus-5',
    'claude-opus-5-cc': 'claude-opus-5',
    'openrouter/anthropic/Claude.Sonnet_4.5': 'claude-sonnet-4-5'
  });
});

test('a lone qualified model is not renamed without duplicate evidence', () => {
  const model = 'anthropic/claude-opus-5';
  assert.equal(createModelAliasResolver({}, [model])(model), model);
  assert.deepEqual(inferModelAliases([model]), {});
});

test('manual aliases override one source or the whole inferred duplicate family', () => {
  const models = ['anthropic/claude-opus-5', 'claude-opus-5'];
  const family = createModelAliasResolver({ 'claude-opus-5': 'opus' }, models);
  assert.equal(family('anthropic/claude-opus-5'), 'opus');
  assert.equal(family('claude-opus-5'), 'opus');

  const source = createModelAliasResolver({ 'anthropic/claude-opus-5': 'provider-specific' }, models);
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
  const projected = projectModelAliasStats(stats, {});
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
  const projected = projectModelAliasHistory(history, {});
  assert.deepEqual(projected.daily[0].perModel, {
    'claude-opus-5': { tokens: 30, cost: 3, unclassifiedTokens: 0 }
  });
  assert.equal(projected.summary.favoriteModel, 'claude-opus-5');
});
