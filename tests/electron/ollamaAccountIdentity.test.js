'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { fetchOllamaLimits } = require('../../src/shared/providers/ollama/limits');
const { hashKey } = require('../../src/shared/hashKey');

function response(email) {
  const html = `${email ? `<span id="header-email">${email}</span>` : ''}<section>Weekly usage<span>10% used</span></section>`;
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => html };
}

test('Ollama rejects replacing one verified email with another and keeps their histories separate', async () => {
  let settings = { limitsEnabled: true, limitProviders: 'ollama' };
  let email = 'alice@example.com';
  const service = createAccountSlotService({ getSettings: () => settings, env: {},
    write: async patch => { settings = { ...settings, ...patch }; },
    probeDeps: () => ({ fetch: async () => response(email), bypassValidationCache: true }) });
  const added = await service.add('ollama', { ollamaCookie: 'wos-session=alice' });
  assert.equal(added.saved, true);
  const id = added.accounts[0].id;
  assert.equal((await service.replace('ollama', id, { ollamaCookie: 'wos-session=alice-rotated' })).saved, true);
  email = 'bob@example.com';
  const rejected = await service.replace('ollama', id, { ollamaCookie: 'wos-session=bob' });
  assert.equal(rejected.verdict, 'differentAccount');
  assert.equal(settings.ollamaAccountSlots[0].accountKey, hashKey('ollama', 'alice@example.com'));
  const bob = await service.add('ollama', { ollamaCookie: 'wos-session=bob' });
  assert.equal(bob.saved, true);
  assert.equal(settings.ollamaAccountSlots[1].accountKeyAliases.includes(hashKey('ollama', 'alice@example.com')), false);
});

test('Ollama credential fallback keys never claim server identity proof', async () => {
  const declaration = require('../../src/shared/providers/ollama/account');
  const limits = require('../../src/shared/providers/ollama/limits');
  assert.equal(typeof limits[declaration.serverAccountKey], 'function');
  const provesServer = limits[declaration.serverAccountKey];
  for (const email of ['', 'alice@example.com']) {
    const values = { ollamaCookie: 'wos-session=proof' };
    const row = await fetchOllamaLimits(values, { env: {}, bypassValidationCache: true, fetch: async () => response(email) });
    assert.equal(provesServer(row.accountKey, values, row.accountKeyAliases), Boolean(email));
    assert.equal(provesServer(hashKey('unrelated'), values, []), false);
  }
});


test('Ollama API email proof includes its key fallback and probes remain unproven', async () => {
  const { isOllamaServerAccountKey } = require('../../src/shared/providers/ollama/limits');
  const values = { ollamaApiKey: 'proof-api-key' };
  const deps = { env: {}, fetch: async url => ({ ok: true, status: 200,
    json: async () => String(url).endsWith('/api/me') ? { Email: 'alice@example.com' }
      : { included: { session: { remaining_percent: 90 } } } }) };
  const row = await fetchOllamaLimits(values, deps);
  assert.equal(isOllamaServerAccountKey(row.accountKey, values, row.accountKeyAliases), true);
  const probe = await fetchOllamaLimits(values, { ...deps, probe: true });
  assert.equal(isOllamaServerAccountKey(probe.accountKey, values, probe.accountKeyAliases), false);
  assert.equal(isOllamaServerAccountKey(row.accountKey, { ollamaApiKey: 'different-key' }, row.accountKeyAliases), false);
});

test('Ollama unproven cookie rotation remains replaceable', async () => {
  let settings = { limitsEnabled: true, limitProviders: 'ollama' };
  const service = createAccountSlotService({ getSettings: () => settings, env: {},
    write: async patch => { settings = { ...settings, ...patch }; },
    probeDeps: () => ({ fetch: async () => response(''), bypassValidationCache: true }) });
  const added = await service.add('ollama', { ollamaCookie: 'wos-session=unproven-one' });
  const oldKey = settings.ollamaAccountSlots[0].accountKey;
  const replaced = await service.replace('ollama', added.accounts[0].id, { ollamaCookie: 'wos-session=unproven-two' });
  assert.equal(replaced.saved, true);
  assert.equal(settings.ollamaAccountSlots[0].serverIdentity, false);
  assert.ok(settings.ollamaAccountSlots[0].accountKeyAliases.includes(oldKey));
});
