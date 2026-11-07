'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const test = require('node:test');
const { Client } = require('undici');

test('HTTP requests survive setTypeOfService EINVAL', { timeout: 5000 }, async (context) => {
  const server = http.createServer((request, response) => response.end('ok'));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  let markingAttempts = 0;
  const client = new Client(`http://127.0.0.1:${server.address().port}`, {
    connect(options, callback) {
      const socket = net.connect({ host: options.hostname, port: options.port });
      socket.setTypeOfService = () => {
        markingAttempts += 1;
        throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL' });
      };
      socket.once('connect', () => callback(null, socket));
      socket.once('error', callback);
      return socket;
    }
  });
  context.after(() => client.destroy());

  const response = await client.request({ path: '/', method: 'GET', typeOfService: 8 });
  assert.equal(response.statusCode, 200);
  assert.equal(await response.body.text(), 'ok');
  assert.equal(markingAttempts, 1);
});
