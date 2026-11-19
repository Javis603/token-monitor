'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { nativeAccountingId, readT3IdentityBindings, supportsT3SessionClient, t3AccountingClient } = require('../../src/shared/t3SessionIdentity');

function settingsFile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-t3-bindings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { db: path.join(home, 'statev2.sqlite'), settings: path.join(home, 'settings.json') };
}

test('native IDs trim surrounding whitespace, enforce the length limit and reject non-string or embedded control data', () => {
  assert.equal(nativeAccountingId('devin', '  Mixed-Case:session_1  '), 'Mixed-Case:session_1');
  assert.equal(nativeAccountingId('devin', 'x'.repeat(512)), 'x'.repeat(512));
  for (const value of [undefined, null, 42, {}, [], '', '   ', 'x'.repeat(513), 'two words', 'a\nb', 'a\tb', 'a\0b']) {
    assert.equal(nativeAccountingId('devin', value), '', `reject ${JSON.stringify(value)}`);
  }
});

test('historical Codex and Claude IDs require UUIDs while opaque ACP IDs retain their case', () => {
  const uuid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  for (const client of ['codex', 'claude']) {
    assert.equal(nativeAccountingId(client, uuid, true), uuid.toLowerCase());
    assert.equal(nativeAccountingId(client, 'opaque-id', true), '');
    assert.equal(nativeAccountingId(client, 'opaque-id'), 'opaque-id');
  }
  assert.equal(nativeAccountingId('devin', uuid, true), uuid);
  assert.equal(nativeAccountingId('devin', 'Opaque-ID', true), 'Opaque-ID');
});

test('built-in drivers use explicit accounting clients and never inherit object properties', () => {
  const bindings = new Map([['codex', 'devin']]);
  for (const [driver, client] of Object.entries({ codex: 'codex', claudeAgent: 'claude', cursor: 'cursor', opencode: 'opencode', grok: 'grok', muse: 'muse' })) {
    assert.equal(t3AccountingClient(driver, 'codex', bindings), client);
    assert.equal(supportsT3SessionClient(client), true);
  }
  for (const driver of ['unknown', 'constructor', 'toString', '__proto__']) {
    assert.equal(t3AccountingClient(driver, 'codex', bindings), null);
    assert.equal(supportsT3SessionClient(driver), false);
  }
  assert.equal(t3AccountingClient('acpRegistry', 'codex', bindings), 'devin');
  assert.equal(t3AccountingClient('acpRegistry', 'devin', bindings), undefined, 'instance names cannot identify the agent');
});

test('ACP settings accept registry defaults and reject custom executable or malformed bindings individually', t => {
  const files = settingsFile(t);
  const instance = config => ({ driver: 'acpRegistry', config });
  fs.writeFileSync(files.settings, JSON.stringify({ providerInstances: {
    default: instance({ agentId: 'devin' }),
    explicit: instance({ agentId: 'claude-acp', source: 'registry', commandArgs: [] }),
    command: instance({ agentId: 'devin', commandPath: '/custom/agent' }),
    arguments: instance({ agentId: 'devin', commandArgs: ['--override'] }),
    local: instance({ agentId: 'devin', source: 'local' }),
    unknown: instance({ agentId: 'unknown' }),
    inherited: instance({ agentId: 'constructor' }),
    array: instance([]), missing: instance(null), empty: null,
    driver: { driver: 'codex', config: { agentId: 'devin' } }
  } }));
  assert.deepEqual(readT3IdentityBindings(files.db), new Map([['default', 'devin'], ['explicit', 'claude']]));
});

test('missing, malformed and replaced settings are reread without retaining stale agent bindings', t => {
  const files = settingsFile(t);
  assert.deepEqual(readT3IdentityBindings(files.db), new Map());
  fs.writeFileSync(files.settings, JSON.stringify({ providerInstances: { agent: { driver: 'acpRegistry', config: { agentId: 'devin' } } } }));
  assert.equal(readT3IdentityBindings(files.db).get('agent'), 'devin');
  fs.writeFileSync(files.settings, '{broken');
  assert.deepEqual(readT3IdentityBindings(files.db), new Map());
  fs.writeFileSync(files.settings, JSON.stringify({ providerInstances: { agent: { driver: 'acpRegistry', config: { agentId: 'opencode' } } } }));
  assert.equal(readT3IdentityBindings(files.db).get('agent'), 'opencode');
  fs.unlinkSync(files.settings);
  assert.deepEqual(readT3IdentityBindings(files.db), new Map());
});
