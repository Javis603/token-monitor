'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createBuilderConfig,
  parseCodesigningIdentities,
  resolveMacSigningIdentity
} = require('../../scripts/macos-packaging');

const emptyKeychain = `
Policy: Code Signing
  Matching identities
     0 identities found

     Valid identities only
     0 valid identities found
`;

const mixedKeychain = `
Policy: Code Signing
  Matching identities
  1) AABBCCDDEEFF00112233445566778899AABBCCDD "Apple Development: Example (TEAMID)"
  2) 11223344556677889900AABBCCDDEEFF00112233 "Developer ID Application: Example (TEAMID)"
     2 identities found

     Valid identities only
  1) AABBCCDDEEFF00112233445566778899AABBCCDD "Apple Development: Example (TEAMID)"
  2) 11223344556677889900AABBCCDDEEFF00112233 "Developer ID Application: Example (TEAMID)"
     2 valid identities found
`;

test('parseCodesigningIdentities reads the valid-identities section', () => {
  assert.deepEqual(parseCodesigningIdentities(emptyKeychain), []);
  assert.deepEqual(parseCodesigningIdentities(mixedKeychain), [
    'Apple Development: Example (TEAMID)',
    'Developer ID Application: Example (TEAMID)'
  ]);
});

test('local dist:mac falls back to ad-hoc signing when this Mac has no Developer ID', () => {
  const local = createBuilderConfig({
    baseConfig: { mac: { forceCodeSigning: true } },
    env: {},
    platform: 'darwin',
    listCodesigningIdentities: () => []
  }).mac;
  assert.equal(local.identity, '-');
  assert.equal(local.forceCodeSigning, true);

  const withDevId = createBuilderConfig({
    baseConfig: { mac: { forceCodeSigning: true } },
    env: {},
    platform: 'darwin',
    listCodesigningIdentities: () => ['Developer ID Application: Example (TEAMID)']
  }).mac;
  assert.equal(withDevId.identity, undefined);

  const developmentOnly = resolveMacSigningIdentity({}, {}, {
    platform: 'darwin',
    listCodesigningIdentities: () => ['Apple Development: Example (TEAMID)']
  });
  assert.equal(developmentOnly, '-');
});

test('CI and imported certificates stay fail-closed instead of ad-hoc', () => {
  assert.equal(resolveMacSigningIdentity({}, { CI: 'true' }, {
    platform: 'darwin',
    listCodesigningIdentities: () => []
  }), undefined);
  assert.equal(resolveMacSigningIdentity({}, { CSC_LINK: 'cert.p12' }, {
    platform: 'darwin',
    listCodesigningIdentities: () => []
  }), undefined);
  assert.equal(resolveMacSigningIdentity({}, { CSC_NAME: 'Developer ID Application: Example' }, {
    platform: 'darwin',
    listCodesigningIdentities: () => []
  }), undefined);
  assert.equal(resolveMacSigningIdentity(
    { identity: 'Developer ID Application: Kept' },
    {},
    { platform: 'darwin', listCodesigningIdentities: () => [] }
  ), 'Developer ID Application: Kept');
  assert.equal(resolveMacSigningIdentity({}, { TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING: '1' }, {
    platform: 'linux',
    listCodesigningIdentities: () => ['Developer ID Application: Example (TEAMID)']
  }), '-');
});
