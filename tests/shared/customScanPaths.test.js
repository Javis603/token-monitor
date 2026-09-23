'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CUSTOM_SCAN_PATH_LIMIT_ERRORS,
  CUSTOM_SCAN_CLIENT_IDS,
  customScanPathLimitError,
  normalizeCustomScanPaths,
  tokscaleExtraDirsEnv
} = require('../../src/shared/customScanPaths');

function paths(prefix, count) {
  return Array.from({ length: count }, (_, index) => `/var/data/${prefix}-${index + 1}`);
}

test('custom scan paths keep supported Tokscale clients in catalog order', () => {
  const normalized = normalizeCustomScanPaths({
    dsh: ['/var/data/dsh'],
    codex: ['/var/data/codex'],
    opencode: ['/var/data/opencode'],
    cursor: ['/var/data/cursor'],
    proma: ['/var/data/proma'],
    kilo: ['/var/data/kilo'],
    unknown: ['/var/data/unknown']
  }, { platform: 'linux' });

  assert.deepEqual(normalized, {
    codex: ['/var/data/codex'],
    kilo: ['/var/data/kilo'],
    dsh: ['/var/data/dsh']
  });
  assert.equal(CUSTOM_SCAN_CLIENT_IDS.includes('codex'), true);
  assert.equal(CUSTOM_SCAN_CLIENT_IDS.includes('kilo'), true);
  assert.equal(CUSTOM_SCAN_CLIENT_IDS.includes('opencode'), false);
  assert.equal(CUSTOM_SCAN_CLIENT_IDS.includes('cursor'), false);
  assert.equal(CUSTOM_SCAN_CLIENT_IDS.includes('proma'), false);
});

test('custom scan paths saved under a renamed client id fold onto its current id', () => {
  // `micode` was MiMo's tracked-client id before it became `mimo`; a settings
  // file written by an older build must keep scanning the roots it names.
  assert.deepEqual(normalizeCustomScanPaths({
    micode: ['/var/data/mimo-old', '/var/data/mimo-shared']
  }, { platform: 'linux' }), {
    mimo: ['/var/data/mimo-old', '/var/data/mimo-shared']
  });
  // Both keys present: the current id's paths lead and the overlap is kept once.
  assert.deepEqual(normalizeCustomScanPaths({
    micode: ['/var/data/mimo-old', '/var/data/mimo-shared'],
    mimo: ['/var/data/mimo-shared', '/var/data/mimo-new']
  }, { platform: 'linux' }), {
    mimo: ['/var/data/mimo-shared', '/var/data/mimo-new', '/var/data/mimo-old']
  });
  assert.match(tokscaleExtraDirsEnv({ micode: ['/var/data/mimo-old'] }, '', { platform: 'linux' }), /^micode:\/var\/data\/mimo-old,micode-desktop:\/var\/data\/mimo-old$/);
});

test('custom scan paths reject values the Tokscale environment format cannot represent', () => {
  assert.deepEqual(normalizeCustomScanPaths({
    codex: [
      'relative/path',
      '/tmp/valid',
      '/tmp/valid',
      '/tmp/comma,path',
      '/tmp/new\nline',
      42
    ]
  }, { platform: 'linux' }), {
    codex: ['/tmp/valid']
  });
});

test('Windows paths deduplicate case-insensitively and remain absolute', () => {
  assert.deepEqual(normalizeCustomScanPaths({
    codex: ['C:\\Users\\Me\\Sessions', 'c:\\users\\me\\sessions', '\\relative']
  }, { platform: 'win32' }), {
    codex: ['C:\\Users\\Me\\Sessions']
  });
});

test('custom scan path limits reject a seventeenth path for one client', () => {
  assert.equal(customScanPathLimitError({ codex: paths('codex', 17) }, { platform: 'linux' }),
    CUSTOM_SCAN_PATH_LIMIT_ERRORS.PER_CLIENT);
});

test('custom scan path limits reject a sixty-fifth path without displacing later clients', () => {
  const existing = {
    claude: paths('claude', 16),
    codex: paths('codex', 15),
    hermes: paths('hermes', 16),
    openclaw: paths('openclaw', 1),
    dsh: paths('dsh', 16)
  };
  assert.equal(customScanPathLimitError(existing, { platform: 'linux' }), '');
  assert.equal(customScanPathLimitError({
    ...existing,
    codex: [...existing.codex, '/var/data/codex-16']
  }, { platform: 'linux' }), CUSTOM_SCAN_PATH_LIMIT_ERRORS.GLOBAL);
  assert.deepEqual(normalizeCustomScanPaths(existing, { platform: 'linux' }), existing);
});

test('normalization keeps the full global allowance across overflowing clients', () => {
  const normalized = normalizeCustomScanPaths({
    claude: paths('claude', 17),
    codex: paths('codex', 17),
    hermes: paths('hermes', 17),
    openclaw: paths('openclaw', 17)
  }, { platform: 'linux' });

  assert.deepEqual(Object.fromEntries(
    Object.entries(normalized).map(([client, entries]) => [client, entries.length])
  ), { claude: 16, codex: 16, hermes: 16, openclaw: 16 });
});

test('Tokscale extra directories append without replacing an existing environment value', () => {
  assert.equal(
    tokscaleExtraDirsEnv({ codex: ['/var/data/codex'], dsh: ['/var/data/dsh'] }, 'claude:/mnt/claude', { platform: 'linux' }),
    'claude:/mnt/claude,codex:/var/data/codex,dsh:/var/data/dsh'
  );
});

test('umbrella custom directories use each source without double-scanning shared formats', () => {
  assert.equal(
    tokscaleExtraDirsEnv({
      antigravity: ['/var/data/antigravity'],
      pi: ['/var/data/pi'],
      kilo: ['/var/data/kilo-tasks']
    }, '', { platform: 'linux' }),
    [
      'antigravity:/var/data/antigravity',
      'antigravity-cli:/var/data/antigravity',
      'pi:/var/data/pi',
      'kilocode:/var/data/kilo-tasks'
    ].join(',')
  );
});
