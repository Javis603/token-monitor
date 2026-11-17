// @ts-check
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const automatic = require('../../src/electron/renderer/limits/automaticAccountList');
const legacy = require('../../src/electron/renderer/limits/legacyAccountList');
const claudeOwner = require('../../src/electron/renderer/limits/providerOwners/claude');
const { createDocument } = require('./accountOwnerDom.fixture.cjs');
const { translate } = require('../../src/electron/renderer/i18n');
const { createBusyGuard } = require('../../src/electron/renderer/limits/accountShell');
const t = (key, params) => translate('en', key, params);
const reading = (accountKey, extra = {}) => ({ provider: 'grok', accountKey, source: 'rpc', status: 'ok', windows: [], ...extra });
const rows = node => [...node.walk()].filter(child => child.classList.contains('slot-row'));
const actions = node => [...node.walk()].filter(child => child.dataset.slotAction && !child.classList.contains('hidden'));
function harness(provider = 'grok') {
  const document = createDocument();
  const container = document.createElement('div'); document.root.append(container);
  const context = { settings: {}, localDeviceId: 'local', records: [], devices: [] };
  const calls = [];
  const bridge = { limits: { accountSlots: { presentation: async (...args) => {
    calls.push(args);
    const group = context.settings.limitAccountPresentation?.[provider] || {};
    const next = args[2] === 'rename' ? { ...group, labels: { ...group.labels, [args[1]]: args[3] } } : { ...group, order: args[3] };
    context.settings.limitAccountPresentation = { [provider]: next };
    return { ok: true, presentation: context.settings.limitAccountPresentation };
  } } } };
  const list = automatic.create({ document, provider, label: provider, container, t, bridge,
    getContext: () => context, preserveScroll: fn => fn(),
    sources: [{ id: 'rpc', labelKey: 'settings.limits.sources.cli' }, { id: 'cli', labelKey: 'settings.limits.sources.cli' }, { id: 'web', labelKey: 'settings.limits.sources.web' }] });
  return { document, container, context, list, calls, row: key => rows(container).find(row => row.dataset.slotId === `automatic:${key}`) };
}

test('automatic rows follow canonical keys and explicit aliases, never shared names or emails', () => {
  const old = reading('old', { stale: true });
  const resolved = reading('new', { accountKeyAliases: ['old'], accountEmail: 'same@example.com' });
  const separate = reading('separate', { accountEmail: 'same@example.com' });
  for (const readings of [[old, resolved, separate], [resolved, old, separate]]) {
    assert.deepEqual(automatic.accountsFromReadings('grok', readings).map(row => row.accountKey), ['new', 'separate']);
  }
  const cyclic = [reading('a', { accountKeyAliases: ['b'] }), reading('b', { accountKeyAliases: ['a'] })];
  assert.equal(automatic.accountsFromReadings('grok', cyclic).length, 2, 'ambiguous aliases do not pick an account');
  assert.equal(automatic.accountsFromReadings('claude', [reading('new-canonical', { provider: 'claude', source: 'oauth', accountKeyAliases: ['shared-old'] })],
    { represented: [{ accountKey: 'saved-canonical', accountKeyAliases: ['shared-old'] }] }).length, 1, 'shared historical alias alone does not merge canonical identities');
  assert.deepEqual(automatic.accountsFromReadings('claude', [
    reading('web-key', { provider: 'claude', source: 'oauth' }),
    reading('resolved', { provider: 'claude', source: 'cli', accountKeyAliases: ['saved-alias'] }),
    reading('other', { provider: 'claude', source: 'oauth', accountEmail: 'same@example.com' }),
    reading('unsaved-web', { provider: 'claude', source: 'web' })
  ], { represented: [{ accountKey: 'web-key' }, { accountKey: 'saved-alias', accountEmail: 'same@example.com' }] }).map(row => row.accountKey), ['other']);
});

for (const provider of ['grok', 'kiro']) test(`${provider}: empty discovery, known/stale accounts and removal reuse compact rows`, () => {
  const h = harness(provider);
  h.list.update([reading('', { provider, source: 'cli', status: 'notConfigured' })]);
  assert.equal(rows(h.container).length, 0);
  h.list.update([reading('known', { provider, source: 'cli', accountEmail: 'user@example.com' })]);
  const first = h.row('known');
  assert.ok(first);
  assert.match(first.textContent, /Connected/);
  assert.deepEqual(actions(first).map(node => node.dataset.slotAction), ['rename', 'up', 'down']);
  assert.equal(h.container.querySelector('.slot-add').classList.contains('hidden'), true);
  h.list.update([reading('known', { provider, source: 'cli', stale: true })]);
  assert.equal(h.row('known'), first);
  assert.equal(first.querySelector('.slot-status').textContent, `● ${t('settings.slots.stale')}`);
  h.list.update([reading('known', { provider, source: 'cli', status: 'notConfigured' })]);
  assert.equal(rows(h.container).length, 0, 'a missing credential is not a saved account');
  h.list.update([reading('known', { provider, source: 'cli', removed: true })]);
  assert.equal(rows(h.container).length, 0);
  h.list.update([]);
  assert.equal(rows(h.container).length, 0);
});

test('keyless healthy discovery is a read-only source observation without fabricated presentation identity', async () => {
  const h = harness();
  h.list.update([reading('', { accountEmail: 'unproven@example.com' })]);
  const [row] = rows(h.container);
  assert.ok(row.dataset.slotId.startsWith('observation:'));
  assert.match(row.textContent, /Connected/);
  assert.doesNotMatch(row.textContent, /unproven@example.com/, 'keyless observations expose their source rather than presenting an unproven identity');
  assert.equal(row.dataset.slotDraggable, 'false');
  assert.deepEqual(actions(row), []);
  assert.equal(row.querySelector('.slot-rename-button').classList.contains('hidden'), true);
  assert.equal(row.querySelector('.plugin-more').classList.contains('hidden'), true);
  assert.equal(row.querySelector('.slot-fix').classList.contains('hidden'), true, 'source observations cannot offer credential repair');
  await row.key('ArrowUp', true);
  for (const control of [...row.walk()].filter(node => node.dataset.slotAction)) await control.click();
  assert.deepEqual(h.calls, []);
  h.list.update([reading('', { status: 'unavailable' }), reading('', { status: 'notConfigured' })]);
  assert.equal(rows(h.container).length, 0, 'no successful observation or identity means no account');
});

test('known automatic accounts retain rename drafts, expose presentation only and exclude observations from order writes', async () => {
  const h = harness();
  const readings = [reading('a'), reading('b'), reading('')];
  h.list.update(readings);
  await h.row('a').querySelector('.slot-rename-button').click();
  const input = h.row('a').querySelector('.slot-rename');
  input.value = 'Work'; input.selectionStart = 2;
  h.list.update(readings.map(row => ({ ...row, updatedAt: 'later' })));
  assert.equal(h.row('a').querySelector('.slot-rename'), input);
  assert.equal(h.document.activeElement, input);
  assert.equal(input.selectionStart, 2);
  await input.key('Enter');
  assert.deepEqual(h.calls[0], ['grok', 'a', 'rename', 'Work']);
  await h.row('a').key('ArrowDown', true);
  assert.deepEqual(h.calls[1], ['grok', 'a', 'order', ['b', 'a']]);
  for (const control of [...h.row('a').walk()].filter(node => ['replaceKey', 'pause', 'remove'].includes(node.dataset.slotAction))) await control.click();
  assert.equal(h.calls.length, 2, 'synthetic clicks cannot invoke external account management');
});

test('remote-only accounts remain remote presentation rows and never become local discovery', async () => {
  const h = harness();
  const remote = reading('remote-account', { sourceDeviceId: 'other', accountName: 'Remote account' });
  h.context.records = [remote];
  h.context.devices = [{ deviceId: 'other', deviceName: 'Remote laptop', platform: 'win32' }];
  h.list.update([remote]);
  const [row] = rows(h.container);
  assert.equal(row.dataset.slotId, 'remote:remote-account');
  assert.equal(row.querySelector('.slot-status').textContent, `● ${t('settings.slots.connected')}`);
  assert.ok(row.querySelector('.row-device'));
  assert.equal(h.row('remote-account'), undefined);
  assert.deepEqual(actions(row).map(node => node.dataset.slotAction), ['rename', 'up', 'down']);
  await row.querySelector('.slot-rename-button').click();
  const input = row.querySelector('.slot-rename'); input.value = 'Shared'; await input.key('Enter');
  assert.deepEqual(h.calls, [['grok', 'remote-account', 'rename', 'Shared']]);
});

test('Claude combines Web management with strict local OAuth/CLI rows without duplicating the saved identity', async () => {
  const document = createDocument();
  const container = document.createElement('div'); container.id = 'claudeWebAccountList'; document.root.append(container);
  const settings = { deviceId: 'local', claudeManagedAccounts: [{ id: 'saved', accountKey: 'saved-key', enabled: true, accountEmail: 'same@example.com' }] };
  const local = [reading('saved-key', { provider: 'claude', source: 'oauth' }),
    reading('cli-other', { provider: 'claude', source: 'cli', accountEmail: 'same@example.com' }),
    reading('resolved-saved', { provider: 'claude', source: 'oauth', accountKeyAliases: ['saved-key'] })];
  const remote = reading('remote', { provider: 'claude', source: 'oauth', sourceDeviceId: 'other' });
  const owner = claudeOwner.create({ document, initial: {}, getSettings: () => settings,
    getAccountContext: () => ({ settings, localDeviceId: 'local', records: [remote], devices: [] }), preserveScroll: fn => fn(),
    localProviderStatuses: () => [...local, remote], strictLocalProviderStatuses: () => local,
    accountShellApi: { createBusyGuard }, providerLabel: 'Claude', t,
    window: { TokenMonitorLegacyAccountList: legacy, tokenMonitor: {} } });
  owner.renderClaudeWebAccounts();
  const allRows = rows(container);
  assert.deepEqual(allRows.map(row => row.dataset.slotId), ['saved', 'automatic:cli-other', 'remote:remote']);
  const automaticRow = allRows.find(row => row.dataset.slotId === 'automatic:cli-other');
  assert.match(automaticRow.textContent, /Connected/);
  assert.deepEqual(actions(automaticRow).map(node => node.dataset.slotAction), ['rename', 'up', 'down']);
  assert.equal(container.querySelector('.slot-add').classList.contains('hidden'), false, 'Web add entry remains visible');
  assert.equal(allRows[2].querySelector('.slot-status').textContent, `● ${t('settings.slots.connected')}`, 'remote OAuth keeps its own status');
  assert.ok(actions(allRows[0]).some(node => node.dataset.slotAction === 'remove'), 'saved Web controls remain reachable');
  local.length = 0;
  owner.renderClaudeWebAccounts();
  assert.deepEqual(rows(container).map(row => row.dataset.slotId), ['saved', 'remote:remote']);
});

test('automatic account drag ignores read-only source observations and persists canonical keys only', async () => {
  const previous = { window: global.window, requestAnimationFrame: global.requestAnimationFrame, cancelAnimationFrame: global.cancelAnimationFrame };
  const listeners = new Map(), frames = new Map(); let frame = 0;
  global.window = { addEventListener: (key, fn) => listeners.set(key, fn),
    removeEventListener: (key, fn) => { if (listeners.get(key) === fn) listeners.delete(key); } };
  global.requestAnimationFrame = fn => { frames.set(++frame, fn); return frame; };
  global.cancelAnimationFrame = id => frames.delete(id);
  try {
    const h = harness();
    h.list.update([reading('a'), reading('b'), reading('')]);
    rows(h.container).forEach((row, index) => { row.rect = { top: index * 50, bottom: index * 50 + 50, height: 50 }; });
    const press = row => row.listeners.pointerdown({ button: 0, pointerId: 1, clientY: row.rect.top + 10, currentTarget: row, target: row.querySelector('.slot-drag-handle') });
    press(rows(h.container).find(row => row.dataset.slotId.startsWith('observation:')));
    assert.equal(listeners.size, 0, 'an observation cannot begin a drag');
    press(h.row('b'));
    listeners.get('pointermove')({ pointerId: 1, clientY: 0, preventDefault() {} });
    listeners.get('pointerup')({ pointerId: 1, clientY: 0, preventDefault() {} });
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
    await new Promise(resolve => setTimeout(resolve, 5));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    assert.deepEqual(h.calls, [['grok', 'b', 'order', ['b', 'a']]]);
    assert.deepEqual(rows(h.container).map(row => row.dataset.slotId), ['automatic:b', 'automatic:a', 'observation:rpc:2']);
  } finally { Object.assign(global, previous); }
});
