'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  codexLoginUrlFromOutput,
  isAllowedCodexLoginUrl
} = require('../../src/shared/codexLogin');

test('isAllowedCodexLoginUrl accepts only OpenAI OAuth login URLs', () => {
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com/oauth/authorize?client_id=app'), true);
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com/oauth/authorize/callback?client_id=app'), true);
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com/device'), true);
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com/device/session'), true);
  assert.equal(isAllowedCodexLoginUrl('http://auth.openai.com/oauth/authorize'), false);
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com.evil.example/oauth/authorize'), false);
  assert.equal(isAllowedCodexLoginUrl('https://auth.openai.com/device-claim'), false);
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

test('codexLoginUrlFromOutput stops before terminal control sequences', () => {
  const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app';

  assert.equal(codexLoginUrlFromOutput(`Open ${url}\x1b[0m`), url);
  assert.equal(codexLoginUrlFromOutput(`\x1b]8;;${url}\x07Open sign-in\x1b]8;;\x07`), url);
});
