'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  codexLoginUrlFromOutput,
  isAllowedCodexLoginUrl
} = require('../../src/shared/codexLogin');

test('isAllowedCodexLoginUrl accepts only OpenAI OAuth login URLs', () => {
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com/oauth/authorize?client_id=app'), true);
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com/device'), true);
  assert.equal(isAllowedCodexLoginUrl('http://auth.openai.com/oauth/authorize'), false);
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com.evil.example/oauth/authorize'), false);
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com/account'), false);
});

test('codexLoginUrlFromOutput ignores the local callback and extracts the OAuth URL', () => {
  const output = [
    'Starting local login server on http://localhost:1455.',
    'If your browser did not open, navigate to this URL to authenticate:',
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app'
  ].join('\n');

  assert.equal(
    codexLoginUrlFromOutput(output),
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app'
  );
});

test('codexLoginUrlFromOutput rejects unrelated URLs and trailing prose', () => {
  assert.equal(codexLoginUrlFromOutput('Visit https://evil.example/oauth/authorize'), '');
  assert.equal(
    codexLoginUrlFromOutput('Open https://auth.openai.com/device.'),
    'https://auth.openai.com/device'
  );
});
