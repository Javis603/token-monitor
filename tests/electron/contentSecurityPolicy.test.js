'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CSP_HEADER, contentSecurityPolicyForRequest } = require('../../src/electron/contentSecurityPolicy');

const documentUrl = pathToFileURL(path.resolve(__dirname, '../../src/electron/renderer/edgeDock/index.html')).href;

test('all documents and subframes forbid embedding via frame-ancestors none', () => {
  const urls = [
    documentUrl,
    `${documentUrl}?surface=notch`,
    `${documentUrl}?surface=notch&settingsPreview=1`,
    `${documentUrl}?surface=rail&settingsPreview=1`,
    documentUrl.replace('/edgeDock/index.html', '/index.html'),
    'https://example.com/'
  ];
  assert.match(CSP_HEADER, /frame-ancestors 'none'/);
  assert.match(CSP_HEADER, /script-src 'self' tm-plugin:; style-src 'self'/);
  for (const url of urls) {
    for (const resourceType of ['mainFrame', 'subFrame', 'script', 'xhr', undefined]) {
      assert.equal(contentSecurityPolicyForRequest({ resourceType, url }), CSP_HEADER, `${resourceType}:${url}`);
    }
  }
});
