'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createTokscaleCapabilityResolver,
  filterSupportedClients,
  parseSupportedClients
} = require('../../src/shared/tokscaleCapabilities');
const { tokscaleClientFilter } = require('../../src/shared/collector');

test('parseSupportedClients accepts wrapped possible values output', () => {
  const supported = parseSupportedClients(
    '  --client <CLIENTS> [possible values: claude,\n    antigravity-cli, dsh, synthetic]\n'
  );
  assert.deepEqual([...supported], ['claude', 'antigravity-cli', 'dsh', 'synthetic']);
});

test('parseSupportedClients ignores an unrelated flag\'s possible-values list that appears first', () => {
  const help =
    '  --format <FORMAT> [possible values: json, table]\n' +
    '  --client <CLIENTS> [possible values: claude, dsh]\n';
  const supported = parseSupportedClients(help);
  assert.deepEqual([...supported], ['claude', 'dsh']);
});

test('parseSupportedClients rejects help text that never mentions --client', () => {
  assert.throws(
    () => parseSupportedClients('  --format <FORMAT> [possible values: json, table]\n'),
    /did not mention --client/
  );
});

test('parseSupportedClients does not borrow a later flag\'s possible-values list', () => {
  const help =
    '  --client <CLIENTS>\n' +
    '  --format <FORMAT> [possible values: json, table]\n';
  assert.throws(
    () => parseSupportedClients(help),
    /did not list --client possible values/
  );
});

test('parseSupportedClients does not borrow a later short+long flag\'s possible-values list', () => {
  const help =
    '  --client <CLIENTS>\n' +
    '  -f, --format <FORMAT> [possible values: json, table]\n';
  assert.throws(
    () => parseSupportedClients(help),
    /did not list --client possible values/
  );
});

test('filterSupportedClients preserves order and removes unsupported ids', () => {
  assert.equal(
    filterSupportedClients('claude,dsh,claude,unknown', new Set(['claude', 'dsh'])),
    'claude,dsh,claude'
  );
});

test('capability filtering expands aliases before intersection', () => {
  const expanded = tokscaleClientFilter('antigravity,claude');
  assert.equal(
    filterSupportedClients(expanded, new Set(['antigravity-cli', 'claude'])),
    'antigravity-cli,claude'
  );
});

test('capability resolver probes once per binary identity and caches the result', async () => {
  let probes = 0;
  const resolver = createTokscaleCapabilityResolver({});
  const probeFn = async () => { probes += 1; return new Set(['claude', 'dsh']); };

  assert.equal(resolver.known('bundled|one'), undefined);
  const results = await Promise.all([
    resolver.probe('bundled|one', probeFn),
    resolver.probe('bundled|one', probeFn)
  ]);
  assert.deepEqual(results.map((set) => [...set]), [['claude', 'dsh'], ['claude', 'dsh']]);
  assert.equal(probes, 1);
  assert.deepEqual([...resolver.known('bundled|one')], ['claude', 'dsh']);

  await resolver.probe('bundled|two', probeFn);
  assert.equal(probes, 2);
});

test('capability probe failure is cached as null and warns exactly once', async () => {
  let warnings = 0;
  let attempts = 0;
  const resolver = createTokscaleCapabilityResolver({ warn: () => { warnings += 1; } });
  const probeFn = async () => { attempts += 1; throw new Error('offline'); };

  assert.equal(await resolver.probe('bundled|offline', probeFn), null);
  assert.equal(await resolver.probe('bundled|offline', probeFn), null);
  assert.equal(attempts, 1);
  assert.equal(warnings, 1);
  assert.equal(resolver.known('bundled|offline'), null);
});

test('resolver reset clears both the capability cache and the warned set', async () => {
  let attempts = 0;
  let warnings = 0;
  const resolver = createTokscaleCapabilityResolver({ warn: () => { warnings += 1; } });
  const probeFn = async () => { attempts += 1; throw new Error('offline'); };

  await resolver.probe('bundled|x', probeFn);
  resolver.reset();
  await resolver.probe('bundled|x', probeFn);
  assert.equal(attempts, 2);
  assert.equal(warnings, 2);
});
