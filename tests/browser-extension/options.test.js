'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { hubOriginPattern, normalizedOptions, validHubUrl } = require('../../browser-extension/options');

test('normalizes device-local options and supported ChatGPT mappings', () => {
  assert.deepEqual(normalizedOptions({
    hubUrl: ' http://hub:17321/// ', secret: ' secret ', deviceId: ' pc ', deviceName: ' Edge ',
    accountIds: { chatgptCom: ' personal ', chatOpenaiCom: ' legacy ', claudeAi: ' ignored ' }
  }), {
    hubUrl: 'http://hub:17321', secret: 'secret', deviceId: 'pc', deviceName: 'Edge',
    accountIds: { chatgptCom: 'personal', chatOpenaiCom: 'legacy' }
  });
});

test('Hub permission requests are scoped to the configured origin', () => {
  assert.equal(hubOriginPattern('http://192.168.1.10:17321/path'), 'http://192.168.1.10:17321/*');
  assert.equal(hubOriginPattern('not a url'), '');
});

test('Hub URL validation allows only HTTP and HTTPS', () => {
  assert.equal(validHubUrl('http://127.0.0.1:17321'), true);
  assert.equal(validHubUrl('https://hub.example'), true);
  assert.equal(validHubUrl('file:///tmp/hub'), false);
  assert.equal(validHubUrl('bad url'), false);
});
