'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLimitWindowsView } = require('../../src/electron/renderer/limits/windowsView');

const view = createLimitWindowsView({
  settings: () => ({ workbuddyQuotaTotalEnabled: true }),
  presentation: require('../../src/electron/renderer/limits/providerPresentation'),
  optionalFiniteNumber: (value) => value === null || value === undefined || value === ''
    ? null : Number.isFinite(Number(value)) ? Number(value) : null
});
const account = (key, extra = {}) => ({
  provider: 'workbuddy', accountKey: key, status: 'ok', region: 'cn',
  windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', used: 20, remaining: 80, limit: 100 }],
  ...extra
});

test('WorkBuddy totals include every finite healthy account and preserve original rows', () => {
  const rows = [account('a'), account('b')];
  const total = view.workbuddyCombinedProvider(rows);
  assert.equal(total.windows[0].remaining, 160);
  assert.equal(total.windows[0].limit, 200);
  assert.equal(total.windows[0].usedPercent, 20);
  assert.equal(total.accountKey, '');
  assert.equal(rows[0].accountKey, 'a');
  assert.deepEqual(total.groupAccounts, rows);
});

for (const [label, extra] of [
  ['authentication failure', { status: 'unauthorized', windows: [] }],
  ['unavailable retained reading', { status: 'unavailable' }],
  ['stale reading', { stale: true }],
  ['different realm', { region: 'ai' }],
  ['different reset boundary', { windows: [{ kind: 'billing', metric: 'credits', currency: 'CREDITS', used: 20, remaining: 80, limit: 100, resetsAt: '2026-11-01T00:00:00.000Z' }] }],
  ['unlimited quota', { windows: [{ kind: 'billing', metric: 'credits', detail: 'unlimited', used: 20 }] }],
  ['no active package', { windows: [] }],
  ['missing denominator', { windows: [{ kind: 'billing', metric: 'credits', remaining: 80 }] }]
]) {
  test(`WorkBuddy ${label} keeps account rows instead of publishing a partial total`, () => {
    const rows = [account('a'), account('b', extra)];
    assert.equal(view.workbuddyCombinedProvider(rows), null);
    assert.strictEqual(view.collapseWorkbuddyAccounts(rows), rows);
  });
}

test('Home total preserves other providers and WorkBuddy position', () => {
  const qoder = { provider: 'qoder' };
  const rows = [qoder, account('a'), { provider: 'codex' }, account('b')];
  const collapsed = view.collapseWorkbuddyAccounts(rows);
  assert.equal(collapsed.length, 3);
  assert.strictEqual(collapsed[0], qoder);
  assert.equal(collapsed[1].balance.amount, 160);
  assert.equal(collapsed[2].provider, 'codex');
});


test('WorkBuddy totals are opt-in and changing the preference preserves account records', () => {
  const settings = {};
  const view = createLimitWindowsView({
    presentation: require('../../src/electron/renderer/limits/providerPresentation'),
    settings: () => settings
  });
  const rows = [account('a'), account('b')];
  assert.equal(view.workbuddyCombinedProvider(rows), null);
  assert.strictEqual(view.collapseWorkbuddyAccounts(rows), rows);
  settings.workbuddyQuotaTotalEnabled = true;
  assert.equal(view.collapseWorkbuddyAccounts(rows)[0].balance.amount, 160);
  settings.workbuddyQuotaTotalEnabled = false;
  assert.strictEqual(view.collapseWorkbuddyAccounts(rows), rows);
  assert.equal(rows[0].windows[0].remaining, 80);
});
