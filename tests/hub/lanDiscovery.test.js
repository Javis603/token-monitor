'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildQuery,
  buildServiceResponse,
  decodeDnsPacket,
  decodeName,
  encodeName,
  encodeMessage,
  parseDiscoveryPacket,
  questionsMatchHub,
  serviceRecords,
  serviceHost,
  serviceInstance,
  TYPE,
  SERVICE_FQDN
} = require('../../src/hub/lanDiscovery');

const HUB_ID = '0123456789abcdef';

function descriptor(overrides = {}) {
  return {
    hubId: HUB_ID,
    hubName: 'Desk & Study',
    port: 17321,
    addresses: ['192.168.1.5', '10.0.0.7'],
    ...overrides
  };
}

// A response an OS mDNS responder would send: later records point at the
// service name encoded in the first record instead of repeating it.
function compressedResponse() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(2, 6);
  const serviceName = encodeName(SERVICE_FQDN);
  const first = encodeMessage({
    answers: [{ name: SERVICE_FQDN, type: TYPE.PTR, ttl: 120, data: `${serviceInstance(HUB_ID)}.${SERVICE_FQDN}` }]
  }).subarray(12);
  const pointer = Buffer.from([0xc0, 0x0c]);
  const recordHead = Buffer.alloc(10);
  recordHead.writeUInt16BE(TYPE.TXT, 0);
  recordHead.writeUInt16BE(1, 2);
  recordHead.writeUInt32BE(120, 4);
  const txtValue = Buffer.from('id=' + HUB_ID, 'utf8');
  const txt = Buffer.concat([Buffer.from([txtValue.length]), txtValue]);
  recordHead.writeUInt16BE(txt.length, 8);
  return Buffer.concat([header, serviceName, first.subarray(serviceName.length), pointer, recordHead, txt]);
}

test('dns names round-trip and reject malformed input', () => {
  for (const name of ['_tokenmonitor._tcp.local', 'tm-abc.local', 'a.b.c']) {
    assert.equal(decodeName(encodeName(name), 0).name, name);
  }
  assert.deepEqual(encodeName(''), Buffer.from([0]));
  assert.throws(() => encodeName('x'.repeat(64)));
});

test('decodeName follows compression pointers', () => {
  const packet = compressedResponse();
  const decoded = decodeDnsPacket(packet);
  assert.equal(decoded.answers.length, 2);
  assert.equal(decoded.answers[1].name, SERVICE_FQDN);
  assert.deepEqual(decoded.answers[1].data, [`id=${HUB_ID}`]);
});

test('queries encode the service name and type', () => {
  const packet = buildQuery({ name: SERVICE_FQDN, type: TYPE.PTR });
  const decoded = decodeDnsPacket(packet);
  assert.equal(decoded.questions.length, 1);
  assert.equal(decoded.questions[0].name, SERVICE_FQDN);
  assert.equal(decoded.questions[0].type, TYPE.PTR);
  assert.equal(decoded.questions[0].unicastResponse, false);
  assert.equal(decoded.flags & 0x8000, 0);
});

test('service records advertise the stable id, display name, port and addresses', () => {
  const records = serviceRecords(descriptor());
  assert.equal(records.length, 5);
  assert.equal(records[0].type, TYPE.PTR);
  assert.equal(records[0].data, `${serviceInstance(HUB_ID)}.${SERVICE_FQDN}`);
  assert.equal(records[1].type, TYPE.SRV);
  assert.equal(records[1].data.port, 17321);
  assert.equal(records[1].data.target, serviceHost(HUB_ID));
  assert.deepEqual(records[2].data, [
    `id=${HUB_ID}`,
    'name=Desk%20%26%20Study',
    'v=1',
    'addrs=192.168.1.5:17321,10.0.0.7:17321'
  ]);
  assert.deepEqual(records.slice(3).map((record) => record.data), ['192.168.1.5', '10.0.0.7']);
});

test('a browser response packet yields one hub keyed by id', () => {
  const packet = buildServiceResponse(descriptor());
  const decoded = decodeDnsPacket(packet);
  assert.equal(decoded.questions.length, 0);
  const { hubs } = parseDiscoveryPacket(decoded);
  assert.equal(hubs.length, 1);
  assert.deepEqual(hubs[0], {
    hubId: HUB_ID,
    name: 'Desk & Study',
    port: 17321,
    addresses: ['192.168.1.5', '10.0.0.7']
  });
});

test('the TXT addrs list is a fallback when the A record is missing', () => {
  const packet = buildServiceResponse(descriptor());
  // Drop the A records so the only address source is the TXT addrs entry.
  const decoded = decodeDnsPacket(packet);
  decoded.answers = decoded.answers.filter((record) => record.type !== TYPE.A);
  const { hubs } = parseDiscoveryPacket(decoded);
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].port, 17321);
  assert.deepEqual(hubs[0].addresses, ['192.168.1.5', '10.0.0.7']);
});

test('records without a stable hub id are ignored', () => {
  const packet = decodeDnsPacket(buildServiceResponse(descriptor()));
  for (const record of packet.answers) {
    if (record.type === TYPE.TXT) record.data = record.data.filter((entry) => !entry.startsWith('id='));
  }
  assert.deepEqual(parseDiscoveryPacket(packet).hubs, []);
});

test('a packet missing the service port is ignored', () => {
  const packet = decodeDnsPacket(buildServiceResponse(descriptor()));
  for (const record of packet.answers) {
    if (record.type === TYPE.SRV) record.data.port = 0;
    if (record.type === TYPE.TXT) record.data = record.data.filter((entry) => !entry.startsWith('addrs='));
  }
  assert.deepEqual(parseDiscoveryPacket(packet).hubs, []);
});

test('only queries for this hub\'s service, instance or host get a response', () => {
  const instance = `${serviceInstance(HUB_ID)}.${SERVICE_FQDN}`;
  assert.equal(questionsMatchHub([{ name: SERVICE_FQDN, type: TYPE.PTR }], HUB_ID), true);
  assert.equal(questionsMatchHub([{ name: instance, type: TYPE.SRV }], HUB_ID), true);
  assert.equal(questionsMatchHub([{ name: instance, type: TYPE.TXT }], HUB_ID), true);
  assert.equal(questionsMatchHub([{ name: serviceHost(HUB_ID), type: TYPE.A }], HUB_ID), true);
  assert.equal(questionsMatchHub([{ name: SERVICE_FQDN, type: TYPE.ANY }], HUB_ID), true);
  assert.equal(questionsMatchHub([{ name: SERVICE_FQDN, type: TYPE.A }], HUB_ID), false);
  assert.equal(questionsMatchHub([{ name: instance, type: TYPE.PTR }], HUB_ID), false);
  assert.equal(questionsMatchHub([{ name: 'tm-ffffffffffffffff._tokenmonitor._tcp.local', type: TYPE.SRV }], HUB_ID), false);
  assert.deepEqual(questionsMatchHub([], HUB_ID), false);
});
