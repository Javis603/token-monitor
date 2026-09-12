'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CUSTOM_SCAN_CLIENT_IDS,
  normalizeCustomScanPaths,
  tokscaleExtraDirsEnv
} = require('../../src/shared/customScanPaths');

test('custom scan paths keep supported Tokscale clients in catalog order', () => {
  const normalized = normalizeCustomScanPaths({
    dsh: ['/var/data/dsh'],
    codex: ['/var/data/codex'],
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
  assert.equal(CUSTOM_SCAN_CLIENT_IDS.includes('proma'), false);
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

test('Tokscale extra directories append without replacing an existing environment value', () => {
  assert.equal(
    tokscaleExtraDirsEnv({ codex: ['/var/data/codex'], dsh: ['/var/data/dsh'] }, 'claude:/mnt/claude', { platform: 'linux' }),
    'claude:/mnt/claude,codex:/var/data/codex,dsh:/var/data/dsh'
  );
});

test('umbrella clients expand custom directories to every supported Tokscale source', () => {
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
      'omp:/var/data/pi',
      'kilocode:/var/data/kilo-tasks'
    ].join(',')
  );
});
