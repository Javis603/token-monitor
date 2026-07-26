'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createClaudeWebFetch } = require('../../src/electron/claudeWebFetch');

function fakeNet(responseFactory) {
  return {
    request(options) {
      const request = new EventEmitter();
      request.options = options;
      request.headers = {};
      request.setHeader = (name, value) => {
        request.headers[String(name).toLowerCase()] = value;
      };
      request.abort = () => request.emit('aborted');
      request.end = () => process.nextTick(() => {
        const response = responseFactory(request);
        request.emit('response', response);
        process.nextTick(() => {
          response.emit('data', Buffer.from('{"ok":true}'));
          response.emit('end');
        });
      });
      return request;
    }
  };
}

test('Claude Web Electron fetch preserves raw Set-Cookie headers', async () => {
  const net = fakeNet((request) => {
    assert.deepEqual(request.options, {
      method: 'GET',
      url: 'https://claude.ai/api/organizations'
    });
    assert.deepEqual(request.headers, {
      accept: 'application/json',
      cookie: 'sessionKey=sk-ant-test'
    });
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = {
      'content-type': 'application/json',
      'set-cookie': [
        'other=value; Path=/',
        'sessionKey=sk-ant-renewed; Path=/; Secure; HttpOnly'
      ]
    };
    return response;
  });
  const fetch = createClaudeWebFetch(net);
  const response = await fetch('https://claude.ai/api/organizations', {
    headers: {
      accept: 'application/json',
      cookie: 'sessionKey=sk-ant-test'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(response.headers.getSetCookie(), [
    'other=value; Path=/',
    'sessionKey=sk-ant-renewed; Path=/; Secure; HttpOnly'
  ]);
  assert.deepEqual(await response.json(), { ok: true });
});

test('Claude Web Electron fetch aborts the native request', async () => {
  let aborted = false;
  const net = {
    request() {
      const request = new EventEmitter();
      request.setHeader = () => {};
      request.end = () => {};
      request.abort = () => {
        aborted = true;
      };
      return request;
    }
  };
  const controller = new AbortController();
  const promise = createClaudeWebFetch(net)('https://claude.ai/api/organizations', {
    signal: controller.signal
  });
  controller.abort();

  await assert.rejects(promise, (error) => error?.name === 'AbortError');
  assert.equal(aborted, true);
});
