'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

let trackingApi = {};
try {
  trackingApi = require('../../src/shared/clientTracking');
} catch (_) {}

const { DEFAULT_CLIENTS, KNOWN_CLIENTS, clientsCsvForSetting } = trackingApi;

test('clientsCsvForSetting uses defaults only for missing settings', () => {
  assert.equal(typeof DEFAULT_CLIENTS, 'string');
  assert.equal(typeof clientsCsvForSetting, 'function');
  assert.equal(clientsCsvForSetting(undefined), DEFAULT_CLIENTS);
  assert.equal(clientsCsvForSetting(null), DEFAULT_CLIENTS);
});

test('default tracked clients include current tokscale-supported tools', () => {
  const clients = DEFAULT_CLIENTS.split(',');
  for (const client of ['cline', 'kimi', 'qwen', 'grok', 'copilot', 'pi', 'zed', 'kilocode', 'zcode', 'kiro', 'codebuddy', 'workbuddy']) {
    assert.ok(clients.includes(client), `${client} should be tracked by default`);
  }
});

test('micode is intentionally NOT default-tracked (mimocode.db double-counts Claude imports)', () => {
  assert.ok(!DEFAULT_CLIENTS.split(',').includes('micode'),
    'micode must stay opt-in until tokscale dedups claude-import sessions');
});

test('KNOWN_CLIENTS is a superset of DEFAULT_CLIENTS and still includes opt-in micode', () => {
  // Display-preference normalization (hide/pin/reorder) keys off the KNOWN list, not
  // the default-tracked list — so an opt-in client like micode must stay here or its
  // prefs get silently dropped on save/read.
  const known = KNOWN_CLIENTS.split(',');
  assert.ok(known.includes('micode'), 'micode must remain a known client');
  for (const client of DEFAULT_CLIENTS.split(',')) {
    assert.ok(known.includes(client), `${client} (default-tracked) must also be known`);
  }
});

test('default tracked clients are accepted by bundled tokscale', () => {
  const locallyParsedClients = new Set(['proma']);
  const result = spawnSync(process.execPath, [require.resolve('tokscale/bin.js'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const help = `${result.stdout || ''}\n${result.stderr || ''}`;
  const possibleValues = help.match(/\[possible values: ([^\]]+)\]/);
  assert.ok(possibleValues, 'tokscale --help should list --client possible values');
  const supported = new Set(possibleValues[1].split(',').map((client) => client.trim()).filter(Boolean));
  const unsupported = DEFAULT_CLIENTS.split(',').filter((client) => !supported.has(client) && !locallyParsedClients.has(client));
  assert.deepEqual(unsupported, []);
});

test('clientsCsvForSetting preserves explicit empty tracked-tool selection', () => {
  assert.equal(clientsCsvForSetting(''), '');
  assert.equal(clientsCsvForSetting('  '), '');
});

test('clientsCsvForSetting normalizes saved client csv values', () => {
  assert.equal(clientsCsvForSetting(' Claude , Codex,,hermes '), 'claude,codex,hermes');
});
