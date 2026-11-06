'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  affectedComponentNames,
  agoBucket,
  statusHeadline,
  localizeProvider
} = require('../../src/electron/renderer/serviceStatusPresentation');

test('DeepSeek selects simplified Chinese only for zh-CN and English for all other app locales', () => {
  const source = {
    id: 'deepseek',
    incidentTitle: 'DeepSeek 网页/API 部分中断（DeepSeek Web/API Partially Unavailable）',
    description: 'Partial Service Outage',
    componentIssues: [
      { name: 'DeepSeek V4.1 Flash API服务(API Service)', status: 'partial_outage' },
      { name: '对话服务(Chatservice)', status: 'partial_outage' }
    ]
  };
  const chinese = localizeProvider(source, 'zh-CN');
  assert.equal(statusHeadline(chinese), 'DeepSeek 网页/API 部分中断');
  assert.equal(chinese.description, '部分服务中断');
  assert.deepEqual(affectedComponentNames(chinese.componentIssues).all, ['DeepSeek V4.1 Flash API服务', '对话服务']);
  for (const locale of ['en', 'zh-TW', 'ja', 'ko', 'pt-BR']) {
    const english = localizeProvider(source, locale);
    assert.equal(statusHeadline(english), 'DeepSeek Web/API Partially Unavailable', locale);
    assert.deepEqual(affectedComponentNames(english.componentIssues).all, ['DeepSeek V4.1 Flash API Service', 'Chatservice'], locale);
    assert.equal(english.componentIssues[0].status, 'partial_outage');
  }
  // Reusing the same cached snapshot on a language switch must not mutate it.
  assert.equal(localizeProvider(source, 'zh-CN').incidentTitle, chinese.incidentTitle);
  assert.match(source.incidentTitle, /（/);
  assert.match(source.componentIssues[0].name, /\(API Service\)/);
});

test('DeepSeek language follows auto resolution and preserves unpaired source text', () => {
  const i18n = require('../../src/electron/renderer/i18n');
  const source = { id: 'deepseek', incidentTitle: '搜索服务异常（Search service error）', description: 'Degraded Performance', componentIssues: [] };
  assert.equal(localizeProvider(source, i18n.resolveLocale('auto', ['zh-CN'])).incidentTitle, '搜索服务异常');
  assert.equal(localizeProvider(source, i18n.resolveLocale('auto', ['zh-HK'])).incidentTitle, 'Search service error');
  assert.equal(localizeProvider({ ...source, incidentTitle: 'New incident without paired translation' }, 'zh-CN').incidentTitle, 'New incident without paired translation');
  assert.equal(localizeProvider({ ...source, incidentTitle: '' }, 'zh-CN').description, '服务性能下降');
  const other = { ...source, id: 'claude' };
  assert.equal(localizeProvider(other, 'zh-CN'), other);
});

test('affectedComponentNames splits names into a visible slice and overflow count', () => {
  const issues = [
    { name: 'claude.ai' },
    { name: 'Claude API' },
    { name: 'Claude Code' },
    { name: 'Claude Cowork' }
  ];

  assert.deepEqual(affectedComponentNames(issues, 2), {
    all: ['claude.ai', 'Claude API', 'Claude Code', 'Claude Cowork'],
    visible: ['claude.ai', 'Claude API'],
    overflow: 2
  });
});

test('affectedComponentNames has no overflow when names fit within the limit', () => {
  const issues = [{ name: 'API' }, { name: 'Search' }];

  assert.deepEqual(affectedComponentNames(issues, 2), {
    all: ['API', 'Search'],
    visible: ['API', 'Search'],
    overflow: 0
  });
});

test('affectedComponentNames ignores blank names and tolerates bad input', () => {
  assert.deepEqual(affectedComponentNames([], 2), { all: [], visible: [], overflow: 0 });
  assert.deepEqual(affectedComponentNames(null, 2), { all: [], visible: [], overflow: 0 });
  assert.deepEqual(affectedComponentNames([{ name: '  ' }, { name: 'Search' }], 2), {
    all: ['Search'],
    visible: ['Search'],
    overflow: 0
  });
});

test('statusHeadline prefers the active incident title over the generic description', () => {
  assert.equal(
    statusHeadline({ incidentTitle: 'Elevated errors on Claude Haiku 4.5', description: 'Partially Degraded Service' }),
    'Elevated errors on Claude Haiku 4.5'
  );
});

test('statusHeadline falls back to the description when no incident is active', () => {
  assert.equal(statusHeadline({ incidentTitle: '', description: 'All Systems Operational' }), 'All Systems Operational');
  assert.equal(statusHeadline({ description: 'All Systems Operational' }), 'All Systems Operational');
});

test('statusHeadline returns an empty string when nothing is known', () => {
  assert.equal(statusHeadline({}), '');
  assert.equal(statusHeadline(null), '');
});

test('agoBucket buckets into seconds, minutes, and hours', () => {
  assert.deepEqual(agoBucket(0), { unit: 'seconds', value: 0 });
  assert.deepEqual(agoBucket(5_000), { unit: 'seconds', value: 5 });
  assert.deepEqual(agoBucket(65_000), { unit: 'minutes', value: 1 });
  assert.deepEqual(agoBucket(3_600_000), { unit: 'hours', value: 1 });
  assert.deepEqual(agoBucket(7_500_000), { unit: 'hours', value: 2 });
});

test('OpenCode affected services use readable names below the headline without changing other providers', () => {
  const { affectedServicesLabel } = require('../../src/electron/renderer/serviceStatusPresentation');
  const i18n = require('../../src/electron/renderer/i18n');
  const provider = { id: 'opencode', componentIssues: [{ name: 'Go' }] };
  assert.equal(affectedServicesLabel(provider, (key, values) => i18n.translate('zh-TW', key, values)), '受影響服務：Go');
  assert.equal(affectedServicesLabel(provider, (key, values) => i18n.translate('en', key, values)), 'Affected services: Go');
  assert.equal(affectedServicesLabel({ ...provider, id: 'claude' }, () => { throw new Error('not OpenCode'); }), '');
  assert.equal(affectedServicesLabel({ ...provider, componentIssues: [] }, () => { throw new Error('no issues'); }), '');
  const many = { ...provider, componentIssues: ['Go', 'Pay-as-you-go', 'Free inference'].map((name) => ({ name })) };
  assert.equal(affectedServicesLabel(many, (key, values) => i18n.translate('en', key, values)), 'Affected services: Go, Pay-as-you-go +1');
});
