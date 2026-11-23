'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAccountPresentation } = require('../../src/electron/limits/accountPresentation');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
test('presentation settings boundary drops junk, bounds entries and uses slot label rules', () => {
  for (const junk of [null, [], true, 'secret']) assert.deepEqual(normalizeAccountPresentation(junk), {});
  const result = normalizeAccountPresentation({ unknown: {}, qoder: { labels: { k: ' Work ', secret: {}, email: 'x@y.com', long: 'x'.repeat(33) }, order: ['k', 'k', null, {}, '', 'x'.repeat(257)], cookie: 'SECRET', values: { token: 'SECRET' } } });
  assert.deepEqual(result, { qoder: { labels: { k: 'Work' }, order: ['k'] } });
  const many = Array.from({ length: 250 }, (_, i) => `k${i}`);
  const bounded = normalizeAccountPresentation({ qoder: { labels: Object.fromEntries(many.map(k => [k, k])), order: many } }).qoder;
  assert.equal(Object.keys(bounded.labels).length, 200); assert.equal(bounded.order.length, 200);
});
test('remote rename/order write only the non-secret presentation object', async () => {
  const settings = { qoderAccountSlots: [] }, writes = [];
  const service = createAccountSlotService({ getSettings: () => settings, write: async patch => { writes.push(patch); Object.assign(settings, patch); }, env: {} });
  assert.equal((await service.presentation('qoder', 'remote', 'rename', 'Work')).ok, true);
  assert.equal((await service.presentation('qoder', 'remote', 'order', ['other', 'remote'])).ok, true);
  assert.deepEqual(settings.limitAccountPresentation, { qoder: { labels: { remote: 'Work' }, order: ['other', 'remote'] } });
  assert.ok(writes.every(patch => Object.keys(patch).join() === 'limitAccountPresentation'));
  assert.equal((await service.presentation('qoder', 'remote', 'remove')).ok, false);
  assert.equal((await service.presentation('qoder', 'remote', 'order', [{}])).ok, false);
  assert.deepEqual(settings.qoderAccountSlots, []);
});

for (const provider of ['grok', 'kiro']) test(`${provider} local rename and order survive persisted normalization`, async () => {
  let settings = {};
  const service = createAccountSlotService({ getSettings: () => settings, write: async patch => { settings = { ...settings, ...patch }; },
    presentationAccounts: async () => ['first', 'second'], env: {} });
  assert.equal((await service.presentation(provider, 'first', 'rename', 'Work')).ok, true);
  assert.equal((await service.presentation(provider, 'first', 'order', ['second', 'first'])).ok, true);
  const restarted = normalizeAccountPresentation(JSON.parse(JSON.stringify(settings.limitAccountPresentation)));
  assert.deepEqual(restarted[provider], { labels: { first: 'Work' }, order: ['second', 'first'] });
});
