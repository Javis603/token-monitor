'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeModelAliases,
  upsertModelAlias
} = require('../../src/electron/renderer/modelAliases');
const { projectModelAliasStats } = require('../../src/electron/modelAliasPresentation');

test('aliases cannot map a model to the same normalized identity', () => {
  assert.deepEqual(normalizeModelAliases({ 'gpt-5.5': 'GPT-5-5' }), {});
  assert.equal(upsertModelAlias({}, 'gpt-5.5', 'GPT-5-5'), null);
});

test('editing removes the previous alias by normalized identity', () => {
  const aliases = { 'Old.Alias': 'old-target', keep: 'other' };
  assert.deepEqual(upsertModelAlias(aliases, 'new-alias', 'new-target', 'old-alias'), {
    keep: 'other',
    'new-alias': 'new-target'
  });
});

test('presentation aliases scalar native-session model fields without mutating source data', () => {
  const stats = {
    periods: {
      today: {
        sessions: {
          session: {
            model: 'Anthropic/claude.opus',
            models: { 'Anthropic/claude.opus': 10 }
          }
        }
      }
    },
    nativeSessions: {
      today: {
        native: { model: 'Anthropic/claude.opus', totalTokens: 10 }
      }
    }
  };
  const projected = projectModelAliasStats(stats, {
    'anthropic/claude-opus': 'claude-opus'
  });

  assert.equal(projected.periods.today.sessions.session.model, 'claude-opus');
  assert.equal(projected.nativeSessions.today.native.model, 'claude-opus');
  assert.equal(stats.nativeSessions.today.native.model, 'Anthropic/claude.opus');
});
