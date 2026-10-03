'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeUsageCostRules,
  costIncluded,
  projectUsageCosts
} = require('../../src/electron/usageCostPolicy');

const rule = {
  client: 'codex',
  modelPrefix: 'chatgpt-web/',
  included: true,
  models: { 'chatgpt-web/extra-high': false }
};

function period(overrides = {}) {
  return {
    totalTokens: 100,
    costUsd: 5,
    clientCosts: { codex: 5 },
    modelCosts: { 'chatgpt-web/extra-high': 5 },
    clientModelCosts: { codex: { 'chatgpt-web/extra-high': 5 } },
    ...overrides
  };
}

test('invalid leading entries do not consume the rule limit', () => {
  const input = Array.from({ length: 150 }, () => ({ client: '', modelPrefix: '' }));
  input.push(rule);
  assert.deepEqual(normalizeUsageCostRules(input), [rule]);
});

test('the last matching rule decides inclusion without changing unrelated tools', () => {
  const rules = [
    { client: 'codex', modelPrefix: 'chatgpt-web/', included: false },
    rule
  ];
  assert.equal(costIncluded(rules, 'codex', 'chatgpt-web/pro'), true);
  assert.equal(costIncluded(rules, 'codex', 'chatgpt-web/extra-high'), false);
  assert.equal(costIncluded(rules, 'claude', 'chatgpt-web/extra-high'), true);
});

test('root periods and nested periods use the same projection', () => {
  const source = {
    today: period(),
    periods: { today: period() }
  };
  const result = projectUsageCosts(source, [rule]);
  assert.equal(result.today.costUsd, 0);
  assert.equal(result.periods.today.costUsd, 0);
  assert.equal(source.today.costUsd, 5);
});

test('missing joint attribution remains included and is marked incomplete', () => {
  const source = {
    periods: {
      today: period({ clientModelCosts: {} })
    }
  };
  const result = projectUsageCosts(source, [rule]);
  assert.equal(result.periods.today.costUsd, 5);
  assert.equal(result.periods.today.costPolicyIncomplete, true);
  assert.equal(result.costPolicyIncomplete, true);
});

test('project coverage uses the same canonical label key as project aggregation', () => {
  const source = {
    periods: {
      today: period({
        sessions: {
          one: {
            client: 'codex',
            projectLabel: 'Project',
            costUsd: 5,
            modelCosts: { 'chatgpt-web/extra-high': 5 }
          }
        },
        projects: { project: { label: 'Project', costUsd: 5 } }
      })
    }
  };
  const result = projectUsageCosts(source, [rule]);
  assert.equal(result.periods.today.projects.project.costUsd, 0);
  assert.equal(result.periods.today.projects.project.costPolicyIncomplete, undefined);
});

test('cache revisions stay compact even with many saved model choices', () => {
  const models = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [`chatgpt-web/model-${index}`, false])
  );
  const result = projectUsageCosts({ periods: { today: period() } }, [{ ...rule, models }]);
  assert.match(result.historyRevision, /^:costs:[0-9a-f]{8}$/);
  assert.ok(result.historyRevision.length < 32);
});
