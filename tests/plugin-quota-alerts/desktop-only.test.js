'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPreferences, defaults, schema } = require('../../plugins/quota-alerts/preferences.cjs');
const { deliver } = require('../../plugins/quota-alerts/delivery.cjs');

test('initial settings expose two independent desktop alert types and threshold without test mode', () => {
  assert.deepEqual(schema.fields.map(field => field.id), ['lowQuota', 'threshold', 'recovery']);
  assert.deepEqual(defaults, { lowQuota: false, threshold: 10, recovery: false });
});

test('unknown settings are rejected without a migration or silent projection', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-schema-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preferences = createPreferences(directory);
  assert.throws(() => preferences.update({ expectedRevision: 0, patch: { removedField: true } }), /Invalid preference patch/);
  fs.writeFileSync(path.join(directory, 'preferences.json'), JSON.stringify({ version: 1, revision: 0, values: { ...defaults, removedField: true } }));
  assert.throws(() => createPreferences(directory), /Cannot load preferences/);
});

test('disabled desktop alerts never invoke network or notification delivery', async t => {
  let outbound = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; assert.fail('No network transport is supported'); });
  const options = { host: { call: () => assert.fail('No desktop alert was opted in') }, signal: new AbortController().signal };
  assert.deepEqual(await deliver({ event: 'low' }, defaults, options), []);
  assert.deepEqual(await deliver({ event: 'full' }, defaults, options), []);
  assert.equal(outbound, 0);
});
