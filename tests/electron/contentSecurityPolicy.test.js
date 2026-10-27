'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CSP_HEADER, contentSecurityPolicyForRequest } = require('../../src/electron/contentSecurityPolicy');

const documentUrl = pathToFileURL(path.resolve(__dirname, '../../src/electron/renderer/edgeDock/index.html')).href;
const previewUrl = `${documentUrl}?surface=notch&settingsPreview=1`;

test('only local display preview subframes permit same-origin embedding', () => {
  for (const surface of ['notch', 'rail', 'peek']) {
    const policy = contentSecurityPolicyForRequest({ resourceType: 'subFrame', url: `${documentUrl}?surface=${surface}&settingsPreview=1` });
    assert.equal(policy, CSP_HEADER.replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    assert.match(policy, /script-src 'self'; style-src 'self'/);
  }
});

test('ordinary documents, remote URLs and lookalike preview requests stay unembeddable', () => {
  const urls = [`${documentUrl}?surface=bubble&settingsPreview=1`, documentUrl, `${documentUrl}?surface=notch`, `${previewUrl}&extra=1`,
    `${documentUrl}?surface=unknown&settingsPreview=1`, `${previewUrl}#fragment`,
    previewUrl.replace('file://', 'https://example.com'),
    previewUrl.replace('/edgeDock/index.html', '/index.html')];
  for (const url of urls) assert.equal(contentSecurityPolicyForRequest({ resourceType: 'subFrame', url }), CSP_HEADER, url);
  for (const resourceType of ['mainFrame', 'script', 'xhr', undefined]) {
    assert.equal(contentSecurityPolicyForRequest({ resourceType, url: previewUrl }), CSP_HEADER);
  }
});
