'use strict';

// LAN discovery for Token Monitor hubs: a small, dependency-free mDNS/DNS-SD
// responder and browser. The Node Hub advertises `_tokenmonitor._tcp.local` on
// every non-internal IPv4 interface; clients browse for it by stable hubId.
//
// This module is Node-only (dgram/os) and is deliberately kept out of
// src/shared so the Worker build never sees it. The wire-format helpers are
// exported so tests can round-trip packets without opening sockets.

const dgram = require('node:dgram');
const { lanIpv4Addresses } = require('../shared/config');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_NAME = '_tokenmonitor';
const SERVICE_PROTOCOL = '_tcp';
const SERVICE_TYPE = `${SERVICE_NAME}.${SERVICE_PROTOCOL}`;
const SERVICE_FQDN = `${SERVICE_TYPE}.local`;
const DOMAIN = 'local';
const RECORD_TTL = 120;
const TXT_VERSION = 1;

const TYPE = Object.freeze({ A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 });
const CLASS_IN = 1;
const CLASS_MASK = 0x7fff;
const CACHE_FLUSH = 0x8000;
const FLAG_RESPONSE = 0x8000;
const FLAG_AUTHORITATIVE = 0x0400;

function isIpv4(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function ipv4ToBuffer(address) {
  return Buffer.from(String(address).split('.').map((part) => Number(part)));
}

function bufferToIpv4(buffer) {
  return Array.from(buffer).join('.');
}

// The hub advertises unique names derived from its stable id, never the
// machine's own `<hostname>.local`: that name belongs to the OS mDNS responder
// and must not be claimed by another process.
function serviceInstance(hubId) {
  return `tm-${String(hubId || '').toLowerCase()}`;
}

function serviceHost(hubId) {
  return `${serviceInstance(hubId)}.${DOMAIN}`;
}

function instanceFqdn(hubId) {
  return `${serviceInstance(hubId)}.${SERVICE_FQDN}`;
}

function normalizeName(name) {
  return String(name || '').trim().replace(/\.+$/, '').toLowerCase();
}

function equalName(a, b) {
  return normalizeName(a) === normalizeName(b);
}

function encodeName(name) {
  const normalized = String(name || '').trim().replace(/\.+$/, '');
  if (!normalized) return Buffer.from([0]);
  const chunks = [];
  for (const part of normalized.split('.')) {
    const label = Buffer.from(part, 'utf8');
    if (label.length === 0 || label.length > 63) throw new Error('invalid dns label');
    chunks.push(Buffer.from([label.length]), label);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function decodeName(buffer, offset) {
  const labels = [];
  let cursor = offset;
  let endOffset = offset;
  let jumped = false;
  let guard = 0;
  for (;;) {
    if (++guard > 128) throw new Error('dns name pointer loop');
    if (cursor >= buffer.length) throw new Error('truncated dns name');
    const length = buffer[cursor];
    if (length === 0) {
      cursor += 1;
      if (!jumped) endOffset = cursor;
      return { name: labels.join('.'), offset: endOffset };
    }
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= buffer.length) throw new Error('truncated dns name pointer');
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1];
      if (!jumped) endOffset = cursor + 2;
      jumped = true;
      cursor = pointer;
      continue;
    }
    if ((length & 0xc0) !== 0) throw new Error('unsupported dns label type');
    if (cursor + 1 + length > buffer.length) throw new Error('truncated dns label');
    labels.push(buffer.toString('utf8', cursor + 1, cursor + 1 + length));
    cursor += 1 + length;
    if (!jumped) endOffset = cursor;
  }
}

function encodeTxt(entries) {
  const parts = [];
  for (const entry of entries) {
    const bytes = Buffer.from(String(entry), 'utf8');
    if (bytes.length === 0) continue;
    if (bytes.length > 255) throw new Error('txt entry too long');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  if (parts.length === 0) parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeTxt(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length) {
    const length = buffer[offset];
    if (length === 0) break;
    if (offset + 1 + length > buffer.length) break;
    entries.push(buffer.toString('utf8', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  return entries;
}

function decodeTxtName(value) {
  const raw = String(value || '');
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

function txtToMap(entries) {
  const map = Object.create(null);
  for (const entry of entries) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    map[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return map;
}

function encodeRecordData(record) {
  switch (record.type) {
    case TYPE.A:
      return ipv4ToBuffer(record.data);
    case TYPE.PTR:
      return encodeName(record.data);
    case TYPE.SRV: {
      const head = Buffer.alloc(6);
      head.writeUInt16BE(record.data.priority || 0, 0);
      head.writeUInt16BE(record.data.weight || 0, 2);
      head.writeUInt16BE(record.data.port, 4);
      return Buffer.concat([head, encodeName(record.data.target)]);
    }
    case TYPE.TXT:
      return encodeTxt(record.data);
    default:
      throw new Error(`unsupported dns record type ${record.type}`);
  }
}

function encodeRecord(record) {
  const rdata = encodeRecordData(record);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(record.type, 0);
  head.writeUInt16BE(CLASS_IN, 2);
  head.writeUInt32BE(Number.isFinite(record.ttl) ? record.ttl : RECORD_TTL, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(record.name), head, rdata]);
}

function encodeQuestion(question) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(question.type, 0);
  head.writeUInt16BE(CLASS_IN | (question.unicastResponse ? 0x8000 : 0), 2);
  return Buffer.concat([encodeName(question.name), head]);
}

function encodeMessage({ id = 0, flags = 0, questions = [], answers = [], additionals = [] }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(flags & 0xffff, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([
    header,
    ...questions.map(encodeQuestion),
    ...answers.map(encodeRecord),
    ...additionals.map(encodeRecord)
  ]);
}

function buildQuery({ name, type = TYPE.PTR, id = 0, unicastResponse = false }) {
  return encodeMessage({
    id,
    flags: 0,
    questions: [{ name, type, unicastResponse }]
  });
}

function decodeRecord(buffer, offset) {
  const decoded = decodeName(buffer, offset);
  let cursor = decoded.offset;
  if (cursor + 10 > buffer.length) throw new Error('truncated dns record');
  const type = buffer.readUInt16BE(cursor);
  const klass = buffer.readUInt16BE(cursor + 2);
  const ttl = buffer.readUInt32BE(cursor + 4);
  const rdlength = buffer.readUInt16BE(cursor + 8);
  cursor += 10;
  if (cursor + rdlength > buffer.length) throw new Error('truncated dns record data');
  const rdata = buffer.subarray(cursor, cursor + rdlength);
  let data;
  switch (type) {
    case TYPE.A:
      data = rdlength === 4 ? bufferToIpv4(rdata) : null;
      break;
    case TYPE.PTR:
      data = decodeName(buffer, cursor).name;
      break;
    case TYPE.SRV:
      if (rdlength < 7) throw new Error('truncated srv record');
      data = {
        priority: rdata.readUInt16BE(0),
        weight: rdata.readUInt16BE(2),
        port: rdata.readUInt16BE(4),
        target: decodeName(buffer, cursor + 6).name
      };
      break;
    case TYPE.TXT:
      data = decodeTxt(rdata);
      break;
    default:
      data = Buffer.from(rdata);
      break;
  }
  return {
    record: { name: decoded.name, type, class: klass & CLASS_MASK, cacheFlush: Boolean(klass & CACHE_FLUSH), ttl, data },
    offset: cursor + rdlength
  };
}

function decodeDnsPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('truncated dns packet');
  const id = buffer.readUInt16BE(0);
  const flags = buffer.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((offset) => buffer.readUInt16BE(offset));
  let offset = 12;
  const sections = { questions: [], answers: [], authorities: [], additionals: [] };

  for (let index = 0; index < counts[0]; index += 1) {
    const decoded = decodeName(buffer, offset);
    offset = decoded.offset;
    if (offset + 4 > buffer.length) throw new Error('truncated dns question');
    const type = buffer.readUInt16BE(offset);
    const klass = buffer.readUInt16BE(offset + 2);
    offset += 4;
    sections.questions.push({ name: decoded.name, type, class: klass & CLASS_MASK, unicastResponse: Boolean(klass & 0x8000) });
  }
  for (const [section, count] of [['answers', counts[1]], ['authorities', counts[2]], ['additionals', counts[3]]]) {
    for (let index = 0; index < count; index += 1) {
      const decoded = decodeRecord(buffer, offset);
      sections[section].push(decoded.record);
      offset = decoded.offset;
    }
  }
  return { id, flags, ...sections };
}

function txtEntries({ hubId, hubName, port, addresses }) {
  const list = [
    `id=${hubId}`,
    `name=${encodeURIComponent(String(hubName || ''))}`,
    `v=${TXT_VERSION}`
  ];
  const usable = (addresses || []).filter(isIpv4).slice(0, 4);
  if (usable.length > 0 && port) list.push(`addrs=${usable.map((address) => `${address}:${port}`).join(',')}`);
  return list;
}

// Records a hub puts on the wire. `instance` is the DNS-SD instance label
// (`tm-<hubId>`); the display name travels in TXT because DNS labels must stay
// ASCII and easy to escape.
function serviceRecords({ hubId, hubName, port, addresses }) {
  const target = serviceHost(hubId);
  return [
    { name: SERVICE_FQDN, type: TYPE.PTR, ttl: RECORD_TTL, data: instanceFqdn(hubId) },
    {
      name: instanceFqdn(hubId),
      type: TYPE.SRV,
      ttl: RECORD_TTL,
      data: { priority: 0, weight: 0, port, target }
    },
    { name: instanceFqdn(hubId), type: TYPE.TXT, ttl: RECORD_TTL, data: txtEntries({ hubId, hubName, port, addresses }) },
    ...(addresses || []).filter(isIpv4).slice(0, 4).map((address) => ({
      name: target,
      type: TYPE.A,
      ttl: RECORD_TTL,
      data: address
    }))
  ];
}

function questionsMatchHub(questions, hubId) {
  const service = normalizeName(SERVICE_FQDN);
  const instance = normalizeName(instanceFqdn(hubId));
  const host = normalizeName(serviceHost(hubId));
  return (questions || []).some((question) => {
    const name = normalizeName(question.name);
    if (question.type === TYPE.PTR || question.type === TYPE.ANY) {
      if (name === service) return true;
    }
    if (question.type === TYPE.SRV || question.type === TYPE.TXT || question.type === TYPE.ANY) {
      if (name === instance) return true;
    }
    if (question.type === TYPE.A || question.type === TYPE.ANY) {
      if (name === host) return true;
    }
    return false;
  });
}

function buildServiceResponse({ hubId, hubName, port, addresses, id = 0 }) {
  const records = serviceRecords({ hubId, hubName, port, addresses });
  return encodeMessage({
    id,
    flags: FLAG_RESPONSE | FLAG_AUTHORITATIVE,
    answers: records
  });
}

// Parse one response packet into hub descriptors. Clients merge these across
// packets because SRV/TXT/A may arrive separately from the PTR that names the
// service.
function parseDiscoveryPacket(packet) {
  const services = new Map();
  const hostAddresses = new Map();
  const records = [...(packet.answers || []), ...(packet.additionals || [])];

  const serviceFor = (instance) => {
    if (!services.has(instance)) services.set(instance, { instance, name: '', port: null, target: null, txt: Object.create(null), addresses: [] });
    return services.get(instance);
  };

  for (const record of records) {
    if (record.type === TYPE.PTR && equalName(record.name, SERVICE_FQDN)) {
      const suffix = `.${SERVICE_FQDN}`;
      const instance = normalizeName(record.data).endsWith(normalizeName(suffix))
        ? record.data.slice(0, record.data.length - suffix.length)
        : null;
      if (instance) serviceFor(instance);
      continue;
    }
    if ((record.type === TYPE.SRV || record.type === TYPE.TXT) && normalizeName(record.name).endsWith(`.${normalizeName(SERVICE_FQDN)}`)) {
      const suffix = `.${SERVICE_FQDN}`;
      const instance = record.name.slice(0, record.name.length - suffix.length);
      const service = serviceFor(instance);
      if (record.type === TYPE.SRV) {
        service.port = record.data.port;
        service.target = record.data.target;
      } else {
        service.txt = txtToMap(record.data);
      }
      continue;
    }
    if (record.type === TYPE.A && record.data) {
      const key = normalizeName(record.name);
      if (!hostAddresses.has(key)) hostAddresses.set(key, []);
      hostAddresses.get(key).push(record.data);
    }
  }

  const hubs = [];
  for (const service of services.values()) {
    const hubId = String(service.txt.id || '').trim().toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(hubId)) continue;
    const name = decodeTxtName(service.txt.name);
    const fallbackAddrs = String(service.txt.addrs || '').split(',').map((entry) => entry.trim()).filter(Boolean);
    const fallbackAddresses = [];
    for (const entry of fallbackAddrs) {
      const index = entry.lastIndexOf(':');
      if (index <= 0) continue;
      const address = entry.slice(0, index);
      if (!isIpv4(address)) continue;
      fallbackAddresses.push(address);
      if (service.port == null) {
        const parsed = Number(entry.slice(index + 1));
        if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) service.port = parsed;
      }
    }
    const targetAddresses = service.target
      ? hostAddresses.get(normalizeName(service.target)) || []
      : [];
    const addresses = Array.from(new Set([...targetAddresses, ...fallbackAddresses]));
    if (!Number.isInteger(service.port) || service.port <= 0 || service.port > 65535) continue;
    if (addresses.length === 0) continue;
    hubs.push({ hubId, name: name || `Token Monitor ${hubId.slice(0, 6)}`, port: service.port, addresses });
  }
  return { hubs, hostAddresses };
}

function hubAddressSet(addresses) {
  return (addresses || []).map(String).sort().join(',');
}

function interfaceSignature(addresses) {
  return (addresses || []).map((entry) => entry.address).sort().join(',');
}

function createLanAdvertiser({ hubId, hubName, port, getAddresses, logger = console } = {}) {
  if (!hubId) throw new Error('hubId is required');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('valid port is required');

  let socket = null;
  let running = false;
  let refreshTimer = null;
  let announceTimers = [];
  const joined = new Set();
  let lastSignature = '';

  const addresses = () => {
    const raw = typeof getAddresses === 'function' ? getAddresses() : lanIpv4Addresses().map((entry) => entry.address);
    return Array.from(new Set((Array.isArray(raw) ? raw : []).map(String).filter(isIpv4))).slice(0, 4);
  };

  function joinInterfaces(entries) {
    if (!socket) return;
    for (const entry of entries) {
      if (!joined.has(entry.address)) {
        try {
          socket.addMembership(MDNS_ADDRESS, entry.address);
          joined.add(entry.address);
        } catch (error) {
          (logger.warn || console.warn)(`[lan] unable to join ${MDNS_ADDRESS} on ${entry.address}: ${error.message}`);
        }
      }
    }
    for (const address of Array.from(joined)) {
      if (!entries.some((entry) => entry.address === address)) {
        try { socket.dropMembership(MDNS_ADDRESS, address); } catch (_) {}
        joined.delete(address);
      }
    }
  }

  // dgram sends are asynchronous, so setMulticastInterface followed by send()
  // in a tight loop can put every copy on the last interface selected. Serialize
  // the copies: the packet payload is small and this runs at most a few times a
  // minute.
  function sendMulticast(payload) {
    const current = socket;
    if (!current || !running) return;
    (async () => {
      for (const entry of lanIpv4Addresses()) {
        await new Promise((resolve) => {
          try {
            current.setMulticastInterface(entry.address);
            current.send(payload, 0, payload.length, MDNS_PORT, MDNS_ADDRESS, () => resolve());
          } catch (error) {
            (logger.warn || console.warn)(`[lan] unable to send on ${entry.address}: ${error.message}`);
            resolve();
          }
        });
      }
    })().catch(() => {});
  }

  function sendUnicast(payload, address, port = MDNS_PORT) {
    const current = socket;
    if (!current || !running) return;
    try {
      current.send(payload, 0, payload.length, port, address, () => {});
    } catch (error) {
      (logger.warn || console.warn)(`[lan] unable to send response: ${error.message}`);
    }
  }

  function announce() {
    if (!running || !socket) return;
    const payload = buildServiceResponse({ hubId, hubName, port, addresses: addresses() });
    sendMulticast(payload);
    // RFC 6762 asks for at least two announcements; the second covers a lost
    // first packet and a browser that started a moment later.
    const timer = setTimeout(() => sendMulticast(payload), 1000);
    timer.unref?.();
    announceTimers.push(timer);
  }

  function handleMessage(message, rinfo) {
    let packet;
    try {
      packet = decodeDnsPacket(message);
    } catch (_) {
      return;
    }
    if (packet.flags & FLAG_RESPONSE) return;
    if (!questionsMatchHub(packet.questions, hubId)) return;
    const unicast = packet.questions.some((question) => question.unicastResponse);
    const payload = buildServiceResponse({
      hubId,
      hubName,
      port,
      addresses: addresses(),
      id: unicast ? packet.id : 0
    });
    if (unicast) {
      sendUnicast(payload, rinfo.address, rinfo.port && rinfo.port !== MDNS_PORT ? rinfo.port : MDNS_PORT);
    } else {
      sendMulticast(payload);
    }
  }

  function refresh() {
    if (!running) return;
    const entries = lanIpv4Addresses();
    joinInterfaces(entries);
    const signature = interfaceSignature(entries);
    if (signature === lastSignature) return;
    lastSignature = signature;
    announce();
  }

  function start() {
    if (socket) return;
    lastSignature = interfaceSignature(lanIpv4Addresses());
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (error) => {
      (logger.warn || console.warn)(`[lan] discovery socket error: ${error.message}`);
      stop();
    });
    socket.on('message', handleMessage);
    socket.on('listening', () => {
      running = true;
      joinInterfaces(lanIpv4Addresses());
      announce();
      refreshTimer = setInterval(refresh, 3000);
      refreshTimer.unref?.();
    });
    try {
      socket.bind(MDNS_PORT, '0.0.0.0');
    } catch (error) {
      (logger.warn || console.warn)(`[lan] discovery unavailable: ${error.message}`);
      stop();
    }
  }

  function stop() {
    running = false;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    for (const timer of announceTimers) clearTimeout(timer);
    announceTimers = [];
    const current = socket;
    socket = null;
    joined.clear();
    if (current) {
      try { current.close(); } catch (_) {}
    }
  }

  return { start, stop, refresh, get running() { return running; }, get addresses() { return addresses(); } };
}

function createLanBrowser({ onHub, onExpire, logger = console, queryIntervalMs = 10000, ttlMs = 120000 } = {}) {
  let socket = null;
  let running = false;
  let queryTimer = null;
  let expireTimer = null;
  let secondQueryTimer = null;
  const joined = new Set();
  const hubs = new Map();

  function joinInterfaces(entries) {
    if (!socket) return;
    for (const entry of entries) {
      if (joined.has(entry.address)) continue;
      try {
        socket.addMembership(MDNS_ADDRESS, entry.address);
        joined.add(entry.address);
      } catch (error) {
        (logger.warn || console.warn)(`[lan] unable to listen on ${entry.address}: ${error.message}`);
      }
    }
    for (const address of Array.from(joined)) {
      if (entries.some((entry) => entry.address === address)) continue;
      try { socket.dropMembership(MDNS_ADDRESS, address); } catch (_) {}
      joined.delete(address);
    }
  }

  function sendQuery() {
    const current = socket;
    if (!running || !current) return;
    const payload = buildQuery({ name: SERVICE_FQDN, type: TYPE.PTR });
    (async () => {
      for (const entry of lanIpv4Addresses()) {
        await new Promise((resolve) => {
          try {
            current.setMulticastInterface(entry.address);
            current.send(payload, 0, payload.length, MDNS_PORT, MDNS_ADDRESS, () => resolve());
          } catch (error) {
            (logger.warn || console.warn)(`[lan] unable to query on ${entry.address}: ${error.message}`);
            resolve();
          }
        });
      }
    })().catch(() => {});
  }

  function handleMessage(message) {
    let packet;
    try {
      packet = decodeDnsPacket(message);
    } catch (_) {
      return;
    }
    if (!(packet.flags & FLAG_RESPONSE)) return;
    let parsed;
    try {
      parsed = parseDiscoveryPacket(packet);
    } catch (_) {
      return;
    }
    const now = Date.now();
    for (const hub of parsed.hubs) {
      const previous = hubs.get(hub.hubId);
      const changed = !previous
        || previous.name !== hub.name
        || previous.port !== hub.port
        || hubAddressSet(previous.addresses) !== hubAddressSet(hub.addresses);
      const next = {
        hubId: hub.hubId,
        name: hub.name,
        port: hub.port,
        addresses: hub.addresses,
        lastSeenAt: new Date(now).toISOString()
      };
      hubs.set(hub.hubId, next);
      if (changed && typeof onHub === 'function') {
        try { onHub({ ...next }); } catch (_) {}
      }
    }
  }

  function expire() {
    const cutoff = Date.now() - ttlMs;
    for (const [hubId, hub] of Array.from(hubs)) {
      if (Date.parse(hub.lastSeenAt) >= cutoff) continue;
      hubs.delete(hubId);
      if (typeof onExpire === 'function') {
        try { onExpire(hubId); } catch (_) {}
      }
    }
  }

  function refresh() {
    if (!running) return;
    joinInterfaces(lanIpv4Addresses());
    sendQuery();
  }

  function start() {
    if (socket) return;
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', handleMessage);
    socket.on('error', (error) => {
      (logger.warn || console.warn)(`[lan] discovery browser error: ${error.message}`);
      stop();
    });
    socket.on('listening', () => {
      running = true;
      joinInterfaces(lanIpv4Addresses());
      sendQuery();
      secondQueryTimer = setTimeout(sendQuery, 1000);
      secondQueryTimer.unref?.();
      queryTimer = setInterval(refresh, Math.max(2000, Number(queryIntervalMs) || 10000));
      queryTimer.unref?.();
      expireTimer = setInterval(expire, Math.max(2000, Math.min(15000, Math.floor(ttlMs / 4) || 10000)));
      expireTimer.unref?.();
    });
    try {
      socket.bind(MDNS_PORT, '0.0.0.0');
    } catch (error) {
      (logger.warn || console.warn)(`[lan] discovery browser unavailable: ${error.message}`);
      stop();
    }
  }

  function stop() {
    running = false;
    for (const timer of [queryTimer, expireTimer, secondQueryTimer]) if (timer) clearInterval(timer);
    queryTimer = null;
    expireTimer = null;
    secondQueryTimer = null;
    const current = socket;
    socket = null;
    joined.clear();
    if (current) {
      try { current.close(); } catch (_) {}
    }
  }

  return {
    start,
    stop,
    refresh,
    list: () => Array.from(hubs.values()).map((hub) => ({ ...hub, addresses: [...hub.addresses] })),
    get running() { return running; }
  };
}

module.exports = {
  MDNS_ADDRESS,
  MDNS_PORT,
  SERVICE_TYPE,
  SERVICE_FQDN,
  RECORD_TTL,
  TYPE,
  lanIpv4Addresses,
  serviceInstance,
  serviceHost,
  encodeName,
  decodeName,
  encodeMessage,
  buildQuery,
  decodeDnsPacket,
  serviceRecords,
  txtEntries,
  buildServiceResponse,
  questionsMatchHub,
  parseDiscoveryPacket,
  createLanAdvertiser,
  createLanBrowser
};
