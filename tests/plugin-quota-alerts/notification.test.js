'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessDataService } = require('../../src/electron/plugins/businessData');
const { evaluate } = require('../../plugins/quota-alerts/evaluator.cjs');
const { message, deliverTest } = require('../../plugins/quota-alerts/delivery.cjs');

test('notification titles consume formal tool names and keep quota detail in the body', async t => {
  const now = Date.parse('2026-10-30T02:00:00Z');
  const service = createBusinessDataService(); t.after(() => service.dispose());
  const providers = ['codex', 'opencode', 'copilot', 'claude'].map(provider => ({ provider, accountKey: 'fixture', status: 'ok', updatedAt: new Date(now).toISOString(),
    windows: [{ kind: 'session', remainingPercent: 7, resetsAt: new Date(now + 3600000).toISOString() }, { kind: 'weekly', remainingPercent: 48 }] }));
  service.publish({ updatedAt: new Date(now).toISOString(), limits: { providers } });
  const snapshot = await service.query({ version: 1, resource: 'limits' }, () => ({ active: true, pluginId: 'notification-fixture', revision: 1 }));
  const alerts = evaluate(snapshot.rows, 10, new Set(), now, new Map()).triggered;
  assert.equal(alerts.length, 4);
  for (const [provider, name] of Object.entries({ codex: 'Codex', opencode: 'OpenCode', copilot: 'GitHub Copilot', claude: 'Claude Code' })) {
    const alert = alerts.find(alert => alert.provider === provider);
    const payload = await message(alert, now, 'zh-TW');
    assert.equal(payload.title, `${name} 配額不足`);
    assert.match(payload.body, /Session: 剩餘 7%/);
    assert.match(payload.body, /Weekly: 剩餘 48%/);
    assert.match(payload.body, /重置時間/);
  }
});

test('display-name changes do not rearm an account and unknown tool identifiers retain the host-provided label', async () => {
  const now = Date.now(), alerted = new Set();
  const row = { provider: 'codex', providerLabel: 'Codex', accountId: 'fixture', identityAvailable: true, status: 'ok', updatedAt: new Date(now).toISOString(), windows: [{ kind: 'session', remainingPercent: 7 }] };
  assert.equal(evaluate([row], 10, alerted, now, new Map()).triggered.length, 1);
  assert.equal(evaluate([{ ...row, providerLabel: 'Changed display name' }], 10, alerted, now, new Map()).triggered.length, 0);
  const unknown = { event: 'low', provider: 'Unlisted-ID', providerLabel: 'Unlisted-ID', remaining: 7, windows: [] };
  assert.equal((await message(unknown, now, 'zh-TW')).title, 'Unlisted-ID 配額不足');
});

test('all six notification titles are compact and manual tests omit duplicate app branding', async () => {
  const expected = { en: 'Codex: quota low', 'zh-TW': 'Codex 配額不足', 'zh-CN': 'Codex 配额不足', ja: 'Codex の残量不足', ko: 'Codex 할당량 부족', 'pt-BR': 'Codex: cota baixa' };
  for (const [locale, title] of Object.entries(expected)) {
    assert.equal((await message({ event: 'low', provider: 'codex', providerLabel: 'Codex', remaining: 7, windows: [] }, Date.now(), locale)).title, title);
  }
  let test;
  await deliverTest({ locale: 'zh-TW', signal: new AbortController().signal,
    host: { call: async (method, payload) => { assert.equal(method, 'notify'); test = payload; } } });
  assert.equal(test.title, '測試通知');
  assert.equal(test.body, '這是配額提醒測試，不代表實際配額不足。');
});
