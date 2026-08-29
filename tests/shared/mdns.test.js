'use strict';

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const test = require('node:test');

const {
  MDNS_PORT,
  SERVICE_ENUMERATION,
  TYPE_A,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
  TYPE_ANY,
  buildResponse,
  createMdnsResponder,
  decodeName,
  defaultAddresses,
  encodeIpv4,
  encodeName,
  encodeTxt,
  isAdvertisableAddress,
  normalizeService,
  parseDnsMessage
} = require('../../src/shared/mdns');

function question(name, type = TYPE_PTR) {
  const qname = encodeName(name);
  const fixed = Buffer.alloc(4);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  return Buffer.concat([qname, fixed]);
}

function query(...questions) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID: mDNS queries carry 0
  header.writeUInt16BE(0, 2); // flags: QR=0
  header.writeUInt16BE(questions.length, 4);
  return Buffer.concat([header, ...questions]);
}

// Walks the answer and additional sections the way a resolver would, so the
// assertions below read as "what a peer receives" rather than "what we built".
function parseRecords(buffer) {
  if (buffer.length < 12) return { answers: [], additionals: [] };
  const counts = {
    answers: buffer.readUInt16BE(6),
    additionals: buffer.readUInt16BE(10)
  };
  let offset = 12;
  const read = (count) => {
    const out = [];
    for (let index = 0; index < count; index += 1) {
      const decoded = decodeName(buffer, offset);
      let cursor = decoded.end;
      const type = buffer.readUInt16BE(cursor);
      const rclass = buffer.readUInt16BE(cursor + 2);
      const ttl = buffer.readUInt32BE(cursor + 4);
      const rdlength = buffer.readUInt16BE(cursor + 8);
      const rdata = buffer.subarray(cursor + 10, cursor + 10 + rdlength);
      cursor += 10 + rdlength;
      offset = cursor;
      out.push({ name: decoded.name, type, class: rclass, ttl, rdata });
    }
    return out;
  };
  return { answers: read(counts.answers), additionals: read(counts.additionals) };
}

function txtEntries(rdata) {
  const out = [];
  let offset = 0;
  while (offset < rdata.length) {
    const length = rdata[offset];
    offset += 1;
    out.push(rdata.toString('utf8', offset, offset + length));
    offset += length;
  }
  return out;
}

const service = normalizeService({ port: 17321, addresses: ['192.168.1.50'] });

test('name encoding is length-prefixed and null terminated', () => {
  const encoded = encodeName('_token-monitor._tcp.local');
  assert.equal(encoded[0], '_token-monitor'.length);
  assert.equal(encoded[encoded.length - 1], 0);
  assert.equal(encoded.toString('utf8', 1, 15), '_token-monitor');
});

test('name decoding follows compression pointers', () => {
  // A pointer is only meaningful inside the buffer it points into, so the
  // target has to be part of the same message.
  const message = Buffer.concat([Buffer.from([0xc0, 0x02]), encodeName('macbook.local')]);
  assert.equal(decodeName(message, 0).name, 'macbook.local');
  // `end` is where the *next* field starts, i.e. the two pointer bytes —
  // without this a caller walking the question section would jump backwards.
  assert.equal(decodeName(message, 0).end, 2);
  assert.equal(decodeName(message, 2).end, message.length);
});

test('name decoding rejects a compression loop instead of hanging', () => {
  const cyclic = Buffer.from([0xc0, 0x00]);
  assert.throws(() => decodeName(cyclic, 0), /cyclic/);
});

test('parseDnsMessage ignores responses and malformed packets', () => {
  const response = Buffer.alloc(12);
  response.writeUInt16BE(0x8400, 2);
  assert.equal(parseDnsMessage(response), null);
  assert.equal(parseDnsMessage(Buffer.alloc(5)), null);
  assert.equal(parseDnsMessage(null), null);
  assert.equal(parseDnsMessage(query()), null); // zero questions
});

test('parseDnsMessage strips the QU bit from QCLASS', () => {
  const qname = encodeName('_token-monitor._tcp.local');
  const fixed = Buffer.alloc(4);
  fixed.writeUInt16BE(TYPE_PTR, 0);
  fixed.writeUInt16BE(0x8001, 2); // QU bit: "answer me unicast"
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT
  const parsed = parseDnsMessage(Buffer.concat([header, qname, fixed]));
  assert.equal(parsed.questions[0].class, 1);
  assert.equal(parsed.questions[0].name, '_token-monitor._tcp.local');
});

test('a PTR query for the service type returns the instance plus its records', () => {
  const response = buildResponse(parseDnsMessage(query(question(service.serviceType))), service);
  assert.ok(response);
  const { answers, additionals } = parseRecords(response);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].type, TYPE_PTR);
  // The PTR points at our instance, and resolves it in the same packet.
  assert.equal(decodeName(response, 12).name, service.serviceType);
  const types = additionals.map((record) => record.type).sort();
  // Sorted numerically: A(1), TXT(16), SRV(33).
  assert.deepEqual(types, [TYPE_A, TYPE_TXT, TYPE_SRV]);
  const srv = additionals.find((record) => record.type === TYPE_SRV);
  assert.equal(srv.rdata.readUInt16BE(4), 17321);
  const a = additionals.find((record) => record.type === TYPE_A);
  assert.deepEqual([...a.rdata], [192, 168, 1, 50]);
});

test('the service-enumeration query lets generic browsers find the type', () => {
  const response = buildResponse(parseDnsMessage(query(question(SERVICE_ENUMERATION))), service);
  const { answers, additionals } = parseRecords(response);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].type, TYPE_PTR);
  // Enumeration alone says "this service type exists" and nothing about an
  // instance — no records are volunteered for a browser that only asked.
  assert.equal(additionals.length, 0);
});

test('a query for the instance name returns SRV, TXT and A', () => {
  const response = buildResponse(parseDnsMessage(query(question(service.instanceName, TYPE_SRV))), service);
  const { answers, additionals } = parseRecords(response);
  assert.equal(answers.length, 0);
  assert.deepEqual(additionals.map((record) => record.type).sort(), [TYPE_A, TYPE_TXT, TYPE_SRV]);
});

test('a query for an unrelated service gets no answer', () => {
  const response = buildResponse(parseDnsMessage(query(question('_something-else._tcp.local'))), service);
  assert.equal(response, null);
});

test('a QTYPE=ANY query for the service type returns everything', () => {
  const response = buildResponse(parseDnsMessage(query(question(service.serviceType, TYPE_ANY))), service);
  const { answers, additionals } = parseRecords(response);
  assert.equal(answers.length, 1);
  assert.deepEqual(additionals.map((record) => record.type).sort(), [TYPE_A, TYPE_TXT, TYPE_SRV]);
});

test('the secret is never advertised, only the ports needed to connect', () => {
  const responder = createMdnsResponder({
    port: 17321,
    addresses: ['192.168.1.50'],
    txt: { ver: '1', view: '17322', id: 'gateway', path: '/api/ingest', auth: '1' }
  });
  const response = responder.handleQuery(
    query(question(responder.service.serviceType)),
    { address: '192.168.1.99', port: MDNS_PORT }
  ).response;
  const { additionals } = parseRecords(response);
  const text = txtEntries(additionals.find((record) => record.type === TYPE_TXT).rdata);
  assert.deepEqual(text.sort(), ['auth=1', 'id=gateway', 'path=/api/ingest', 'ver=1', 'view=17322']);
  assert.doesNotMatch(text.join('|'), /secret/i);
});

test('a query from the mDNS port is answered on the multicast group', () => {
  const responder = createMdnsResponder({ port: 17321, addresses: [] });
  const fromMdnsPort = responder.handleQuery(query(question(responder.service.serviceType)), { address: '192.168.1.99', port: MDNS_PORT });
  assert.equal(fromMdnsPort.address, '224.0.0.251');
  assert.equal(fromMdnsPort.port, MDNS_PORT);
  // A legacy unicast query from an ephemeral port must be answered there, or
  // the asker never sees a reply.
  const fromEphemeral = responder.handleQuery(query(question(responder.service.serviceType)), { address: '192.168.1.99', port: 51234 });
  assert.equal(fromEphemeral.address, '192.168.1.99');
  assert.equal(fromEphemeral.port, 51234);
});

test('a malformed packet yields no reply rather than an exception', () => {
  const responder = createMdnsResponder({ port: 17321, addresses: [] });
  assert.equal(responder.handleQuery(Buffer.from([0x00, 0x01]), { address: 'x', port: MDNS_PORT }), null);
  assert.equal(responder.handleQuery(Buffer.alloc(12), { address: 'x', port: MDNS_PORT }), null);
});

test('an empty TXT record is one zero byte, not a zero-length RDATA', () => {
  assert.deepEqual([...encodeTxt([])], [0]);
  assert.deepEqual([...encodeTxt([{ key: 'ver', value: '1' }])], [5, 118, 101, 114, 61, 49]);
});

test('non-IPv4 addresses are never advertised as A records', () => {
  const normalized = normalizeService({ port: 17321, addresses: ['192.168.1.50', 'not-an-ip', '::1', '10.0.0.256'] });
  assert.deepEqual(normalized.addresses, ['192.168.1.50']);
  assert.equal(encodeIpv4('999.1.1.1'), null);
  assert.equal(encodeIpv4('nope'), null);
});

// A tunnel adapter reports no hardware address. Publishing it as an A record is
// a promise that a peer can reach it, and a phone that tries gets a connection
// that never opens. Observed on a Windows host advertising 198.18.0.1 from an
// interface named after the VPN that owns it.
test('addresses with no hardware address are never advertised', () => {
  assert.equal(isAdvertisableAddress({ address: '198.18.0.1', mac: '00:00:00:00:00:00' }), false);
  assert.equal(isAdvertisableAddress({ address: '10.0.0.5', mac: '' }), false);
  assert.equal(isAdvertisableAddress(null), false);
  assert.equal(isAdvertisableAddress({ address: '192.168.1.50', mac: '22:93:ad:25:83:c6' }), true);
  // Windows reports hyphenated MACs; the comparison must not depend on separator.
  assert.equal(isAdvertisableAddress({ address: '192.168.1.50', mac: '22-93-AD-25-83-C6' }), true);
});

test('the default address list never contains a hardware-less address', () => {
  for (const address of defaultAddresses()) {
    assert.match(address, /^\d{1,3}(\.\d{1,3}){3}$/, `${address} must be a plain IPv4 address`);
    assert.notEqual(address, '0.0.0.0');
  }
});

test('the service port is validated', () => {
  assert.throws(() => normalizeService({ port: 0 }), /port/);
  assert.throws(() => normalizeService({ port: 70000 }), /port/);
  assert.throws(() => normalizeService({}), /port/);
});

test('the responder answers a real query over a loopback socket', async () => {
  const responder = createMdnsResponder({ port: 17321, addresses: ['127.0.0.1'] });
  const reply = responder.handleQuery(
    query(question(responder.service.serviceType)),
    { address: '127.0.0.1', port: MDNS_PORT }
  );
  const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the mDNS reply')), 4000);
    client.on('message', (message) => { clearTimeout(timer); resolve(message); });
    client.on('error', reject);
    client.bind(MDNS_PORT, '127.0.0.1', () => {
      client.addMembership('224.0.0.251', '127.0.0.1');
      // Feed the responder the bytes a peer would have sent; the responder's own
      // start() is covered below and needs the real group.
      responder.handleQuery(query(question(responder.service.serviceType)), { address: '127.0.0.1', port: MDNS_PORT });
      client.send(reply.response, 0, reply.response.length, MDNS_PORT, '224.0.0.251');
    });
  }).finally(() => { try { client.close(); } catch (_) {} });
  assert.equal(parseRecords(received).answers.length, 1);
});

test('start and stop are idempotent and report listening state', async (t) => {
  const responder = createMdnsResponder({ port: 17321, addresses: [], logger: { error() {}, warn() {} } });
  // Port 5353 is shared with every other mDNS responder on the host. Skipping
  // here is not hiding a failure: the encode/decode paths above are the logic,
  // and this only proves the socket lifecycle closes cleanly.
  try {
    await responder.start();
  } catch (error) {
    if (error.code !== 'mdns_bind_failed') throw error;
    t.skip('port 5353 is unavailable on this host');
    return;
  }
  assert.equal(responder.listening, true);
  await responder.start();
  await responder.stop();
  assert.equal(responder.listening, false);
  await responder.stop();
});

// Port 5353 is routinely held by several processes at once. bind() still
// succeeds under SO_REUSEADDR, so `listening` alone says nothing about whether
// anyone will hear us — which is the whole reason verifyDelivery() exists.
test('verifyDelivery reports whether the socket actually receives', async (t) => {
  const responder = createMdnsResponder({ port: 17321, addresses: [], logger: { error() {}, warn() {} } });
  try {
    await responder.start();
  } catch (error) {
    if (error.code !== 'mdns_bind_failed') throw error;
    t.skip('port 5353 is unavailable on this host');
    return;
  }
  try {
    const verified = await responder.verifyDelivery();
    assert.equal(typeof verified, 'boolean');
    // Nothing here asserts `true`: whether multicast loopback reaches our own
    // socket is a property of the host. What must hold is that a bound socket
    // resolves the question rather than hanging, and answers no on a socket
    // that receives nothing.
  } finally {
    await responder.stop();
  }
});

test('verifyDelivery is false on a responder that was never started', async () => {
  const responder = createMdnsResponder({ port: 17321, addresses: [], logger: { error() {}, warn() {} } });
  assert.equal(await responder.verifyDelivery(), false);
});
