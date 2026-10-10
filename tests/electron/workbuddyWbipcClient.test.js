'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  computeProof,
  encodeTranscript,
  readDiscovery,
  ticketIdOf,
  wbipcProxyFetch
} = require('../../src/electron/providers/workbuddy/wbipcClient');

test('encodeTranscript length-prefixes each part with the client/server domain', () => {
  const buf = encodeTranscript('client', { protocol: 1, endpoint: '\\\\.\\pipe\\x', clientNonce: 'AAA', serverNonce: 'BB' });
  let offset = 0;
  const readPart = () => {
    const len = buf.readUInt32BE(offset);
    const part = buf.subarray(offset + 4, offset + 4 + len).toString('utf8');
    offset += 4 + len;
    return part;
  };
  assert.equal(readPart(), 'wbipc-c');
  assert.equal(readPart(), '1');
  assert.equal(readPart(), '\\\\.\\pipe\\x');
  assert.equal(readPart(), 'AAA');
  assert.equal(readPart(), 'BB');
  assert.equal(offset, buf.length);
  // server 转写与 client 只差 domain，其余逐字节一致。
  const server = encodeTranscript('server', { protocol: 1, endpoint: '\\\\.\\pipe\\x', clientNonce: 'AAA', serverNonce: 'BB' });
  assert.equal(server.subarray(4, 11).toString('utf8'), 'wbipc-s');
  assert.deepEqual(server.subarray(11), buf.subarray(11));
});

test('proof and ticket id follow the wire protocol', () => {
  const ticket = 'ticket-abc';
  const transcript = { protocol: 1, endpoint: 'ep', clientNonce: 'n1', serverNonce: 'n2' };
  const expected = crypto.createHmac('sha256', Buffer.from(ticket, 'utf8'))
    .update(encodeTranscript('client', transcript))
    .digest('base64url');
  assert.equal(computeProof(ticket, 'client', transcript), expected);
  assert.equal(ticketIdOf(ticket), crypto.createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16));
});

test('wbipcProxyFetch reports no channel when the discovery file is absent', async () => {
  const missing = path.join(os.tmpdir(), `wb-missing-${Date.now()}`);
  await assert.rejects(
    () => wbipcProxyFetch('https://copilot.tencent.com/v2/billing/meter/get-user-resource', {
      method: 'POST',
      body: '{}'
    }, { env: { WORKBUDDY_CONFIG_DIR: missing } }),
    (error) => error.code === 'E_NOT_WORKBUDDY'
  );
});

test('readDiscovery honors WORKBUDDY_CONFIG_DIR and rejects malformed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbipc-'));
  const env = { WORKBUDDY_CONFIG_DIR: dir };
  assert.equal(readDiscovery({ env }), null);
  fs.mkdirSync(path.join(dir, 'wbipc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wbipc', 'endpoint.json'), 'not-json');
  assert.equal(readDiscovery({ env }), null);
  fs.writeFileSync(path.join(dir, 'wbipc', 'endpoint.json'), JSON.stringify({ endpoint: '\\\\.\\pipe\\x', ticket: 't' }));
  assert.deepEqual(readDiscovery({ env }), { endpoint: '\\\\.\\pipe\\x', ticket: 't' });
  fs.rmSync(dir, { recursive: true, force: true });
});

// 本地假 daemon：完整握手（服务端先自证 + 客户端 prove）+ 一次 http.fetch，
// 验证客户端线协议实现与 wbipc/v1 一致。传输按平台选：Windows 是命名管道，
// 其他平台是临时目录里的 unix socket —— 线协议与传输无关，客户端只把
// endpoint 原样交给 net.connect。
test('client completes handshake and proxies a fetch against a local daemon', async () => {
  const ticket = 'probe-ticket';
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbipc-'));
  const endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\wbipc-test-' + crypto.randomBytes(6).toString('hex')
    : path.join(dumpDir, 'wbipc-test.sock');
  const rpcRequests = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 'hello';
    let clientNonce = '';
    let serverNonce = '';
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) return;
        const line = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        if (!line.length) continue;
        const frame = JSON.parse(line.toString('utf8'));
        if (stage === 'hello') {
          assert.equal(frame.type, 'session_hello');
          assert.equal(frame.ticket_id, ticketIdOf(ticket));
          clientNonce = frame.client_nonce;
          serverNonce = crypto.randomBytes(16).toString('base64url');
          const transcript = { protocol: 1, endpoint, clientNonce, serverNonce };
          socket.write(JSON.stringify({
            type: 'session_challenge',
            server_nonce: serverNonce,
            server_proof: computeProof(ticket, 'server', transcript)
          }) + '\n');
          stage = 'prove';
          continue;
        }
        if (stage === 'prove') {
          assert.equal(frame.type, 'session_prove');
          const transcript = { protocol: 1, endpoint, clientNonce, serverNonce };
          assert.equal(frame.client_proof, computeProof(ticket, 'client', transcript));
          socket.write(JSON.stringify({ type: 'session_hello_ack', pipes: ['wb.request'], connection_epoch: 'e1' }) + '\n');
          stage = 'rpc';
          continue;
        }
        rpcRequests.push(frame);
        socket.write(JSON.stringify({
          id: frame.id,
          result: frame.method.endsWith('GetPipe')
            ? { channel: 'c:wb.request', methods: ['http.fetch'] }
            : { status: 200, headers: {}, body_b64: Buffer.from(JSON.stringify({ code: 0 }), 'utf8').toString('base64') }
        }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(endpoint, resolve);
  });
  fs.mkdirSync(path.join(dumpDir, 'wbipc'), { recursive: true });
  fs.writeFileSync(path.join(dumpDir, 'wbipc', 'endpoint.json'), JSON.stringify({ endpoint, ticket }));
  try {
    const response = await wbipcProxyFetch('https://copilot.tencent.com/v2/billing/meter/get-user-resource', {
      method: 'POST',
      body: JSON.stringify({ PageNumber: 1 })
    }, { env: { WORKBUDDY_CONFIG_DIR: dumpDir } });
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { code: 0 });
    assert.equal(rpcRequests.length, 2);
    assert.equal(rpcRequests[0].method, 'broker/GetPipe');
    assert.equal(rpcRequests[1].method, 'c:wb.request/http.fetch');
    assert.equal(rpcRequests[1].params.path, '/v2/billing/meter/get-user-resource');
    assert.equal(rpcRequests[1].mode, 'call');
  } finally {
    server.close();
    fs.rmSync(dumpDir, { recursive: true, force: true });
  }
});
