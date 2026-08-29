'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const { lanIpv4Addresses } = require('./config');

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;

const CLASS_IN = 1;
// RFC 6762 §10.2: the top bit of CLASS in a response marks a unique record and
// tells every cache to drop what it holds for that name/type rather than
// merging. Our SRV/TXT/A records are unique per instance.
const CACHE_FLUSH = 0x8000;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_SRV = 33;
const TYPE_ANY = 255;

// RFC 6762 §10: 120s for the shared service-type PTR, 4500s for the unique
// records belonging to one instance.
const TTL_PTR = 120;
const TTL_UNIQUE = 4500;

const FLAG_RESPONSE = 0x8400; // QR=1, AA=1

const SERVICE_ENUMERATION = '_services._dns-sd._udp.local';

const DEFAULT_SERVICE_TYPE = '_token-monitor._tcp.local';

// Long enough for a loopback round trip even on a loaded machine, short enough
// that gateway startup is not held up waiting on it.
const SELF_PROBE_TIMEOUT_MS = 1500;

function encodeName(name) {
  const labels = String(name || '').split('.').filter(Boolean);
  const parts = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new Error(`DNS label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// Follows compression pointers (RFC 1035 §4.1.4) because every real resolver
// emits them; the loop guard is what stops a hostile packet from spinning here.
// Returns `end` as the offset just past the name in the *original* buffer, so a
// caller walking the question section keeps advancing even when we jumped.
function decodeName(buffer, offset) {
  const labels = [];
  const seen = new Set();
  let cursor = offset;
  let end = offset;
  let jumped = false;
  for (;;) {
    if (cursor >= buffer.length) throw new Error('truncated DNS name');
    const length = buffer[cursor];
    if (length === 0) {
      cursor += 1;
      if (!jumped) end = cursor;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= buffer.length) throw new Error('truncated DNS compression pointer');
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1];
      if (seen.has(pointer)) throw new Error('cyclic DNS compression pointer');
      seen.add(pointer);
      if (!jumped) { end = cursor + 2; jumped = true; }
      cursor = pointer;
      continue;
    }
    if ((length & 0xc0) !== 0) throw new Error('unsupported DNS label length');
    cursor += 1;
    if (cursor + length > buffer.length) throw new Error('truncated DNS label');
    labels.push(buffer.toString('utf8', cursor, cursor + length));
    cursor += length;
    if (!jumped) end = cursor;
  }
  return { name: labels.join('.'), end };
}

// Returns null for anything this responder must ignore rather than a thrown
// error: a malformed packet on a multicast group is routine background noise,
// and one bad packet must not take the gateway's discovery down.
function parseDnsMessage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const flags = buffer.readUInt16BE(2);
  if (flags & 0x8000) return null; // QR=1, this is a response
  const questionCount = buffer.readUInt16BE(4);
  if (questionCount === 0) return null;
  const questions = [];
  let offset = 12;
  for (let index = 0; index < questionCount; index += 1) {
    const decoded = decodeName(buffer, offset);
    if (decoded.end + 4 > buffer.length) return null;
    questions.push({
      name: decoded.name,
      type: buffer.readUInt16BE(decoded.end),
      class: buffer.readUInt16BE(decoded.end + 2) & 0x7fff // strip the QU bit
    });
    offset = decoded.end + 4;
  }
  return { id: buffer.readUInt16BE(0), questions };
}

/** TXT is a sequence of length-prefixed strings; `key` or `key=value` per entry. */
function decodeTxt(rdata) {
  const out = {};
  let offset = 0;
  while (offset < rdata.length) {
    const length = rdata[offset];
    offset += 1;
    if (length === 0) continue;
    if (offset + length > rdata.length) break;
    const text = rdata.toString('utf8', offset, offset + length);
    offset += length;
    const eq = text.indexOf('=');
    if (eq === -1) out[text] = '';
    else out[text.slice(0, eq)] = text.slice(eq + 1);
  }
  return out;
}

/** SRV: priority(2) weight(2) port(2) then a (possibly compressed) target name. */
function decodeSrv(rdata) {
  if (rdata.length < 7) return null;
  return { priority: rdata.readUInt16BE(0), port: rdata.readUInt16BE(4), target: decodeName(rdata, 6).name };
}

function decodeARecord(rdata) {
  if (rdata.length !== 4) return null;
  return `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
}

/**
 * Parses the resource records of an mDNS response.
 *
 * The question section is skipped rather than interpreted: a respondent echoes
 * back whatever was asked, and for a browser those bytes carry no information
 * the records do not already carry.
 *
 * Answers, authority and additional records are read as one run because that is
 * what they are on the wire — a PTR answer arrives in the answer section while
 * its SRV/TXT/A companions arrive in the additional section, and a browser has
 * to see all three to know anything.
 */
function parseDnsResponse(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const flags = buffer.readUInt16BE(2);
  if (!(flags & 0x8000)) return null; // QR=0: a query, not a response
  const questionCount = buffer.readUInt16BE(4);
  const recordCount = buffer.readUInt16BE(6) + buffer.readUInt16BE(8) + buffer.readUInt16BE(10);
  let offset = 12;
  for (let index = 0; index < questionCount; index += 1) {
    const decoded = decodeName(buffer, offset);
    if (decoded.end + 4 > buffer.length) return null;
    offset = decoded.end + 4;
  }
  const records = [];
  for (let index = 0; index < recordCount; index += 1) {
    const decoded = decodeName(buffer, offset);
    let cursor = decoded.end;
    if (cursor + 10 > buffer.length) break;
    const type = buffer.readUInt16BE(cursor);
    const recordClass = buffer.readUInt16BE(cursor + 2) & 0x7fff; // strip cache-flush
    const ttl = buffer.readUInt32BE(cursor + 4);
    const rdlength = buffer.readUInt16BE(cursor + 8);
    if (cursor + 10 + rdlength > buffer.length) break;
    const rdata = buffer.subarray(cursor + 10, cursor + 10 + rdlength);
    cursor += 10 + rdlength;
    offset = cursor;
    records.push({ name: decoded.name, type, class: recordClass, ttl, rdata });
  }
  return { id: buffer.readUInt16BE(0), flags, records };
}

function encodeRecord(name, type, recordClass, ttl, rdata) {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(recordClass, 2);
  fixed.writeUInt32BE(ttl, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), fixed, rdata]);
}

function encodeTxt(entries) {
  const chunks = entries.map(({ key, value }) => {
    const text = value === undefined || value === null || value === '' ? key : `${key}=${value}`;
    const bytes = Buffer.from(String(text), 'utf8');
    if (bytes.length > 255) throw new Error(`TXT entry too long: ${key}`);
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  // An empty TXT record is one zero byte, not zero bytes — a zero-length RDATA
  // is indistinguishable from a truncated one to some parsers.
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.from([0]);
}

function encodeSrv(priority, weight, port, target) {
  const fixed = Buffer.alloc(6);
  fixed.writeUInt16BE(priority, 0);
  fixed.writeUInt16BE(weight, 2);
  fixed.writeUInt16BE(port, 4);
  return Buffer.concat([fixed, encodeName(target)]);
}

function encodeIpv4(address) {
  const octets = String(address || '').trim().split('.');
  if (octets.length !== 4) return null;
  const bytes = Buffer.alloc(4);
  for (let index = 0; index < 4; index += 1) {
    const value = Number(octets[index]);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

function safeHostname() {
  return os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'token-monitor';
}

// An all-zero MAC is how a tunnel or virtual adapter presents itself: no
// hardware address because there is no hardware. `lanIpv4Addresses()` filters by
// interface name and OUI prefix, which catches Docker/WSL/Hyper-V, but not the
// long tail of VPN and tunnel adapters with ordinary names.
//
// Filtering here rather than in lanIpv4Addresses() because the two have
// different bars: listing an address in a UI is information, while publishing it
// as an A record is a promise that a peer can reach it. A phone that picks a
// tunnel address gets a connection that never opens.
function isAdvertisableAddress(entry) {
  if (!entry) return false;
  const mac = String(entry.mac || '').trim().toLowerCase().replace(/-/g, ':');
  return mac !== '' && mac !== '00:00:00:00:00:00';
}

function defaultAddresses() {
  return lanIpv4Addresses().filter(isAdvertisableAddress).map((entry) => entry.address);
}

function normalizeService(options = {}) {
  const serviceType = String(options.serviceType || DEFAULT_SERVICE_TYPE).replace(/\.$/, '');
  const host = safeHostname();
  const instanceName = String(options.instanceName || `${host} Token Monitor`);
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('mdns service port must be an integer between 1 and 65535');
  }
  const txt = options.txt && typeof options.txt === 'object' ? options.txt : {};
  const addresses = Array.isArray(options.addresses)
    ? options.addresses.map((entry) => String(entry).trim()).filter(Boolean)
    : defaultAddresses();
  // The instance FQDN is the bare label plus the service type, exactly as it
  // travels on the wire. SRV/TXT/A and the PTR rdata all name the instance by
  // this full form; a resolver that follows a PTR to its instance name and then
  // queries SRV/TXT by that name only works because the names match here.
  const instanceFqdn = `${instanceName}.${serviceType}`;
  return {
    serviceType,
    instanceName,
    instanceFqdn,
    // A resolvable SRV target. mDNS names are link-local and not registered in
    // any global zone, so this is a claim about what to ask for next rather than
    // something that resolves on the wider internet.
    target: String(options.target || `${host}.local`),
    port,
    txtEntries: Object.entries(txt).map(([key, value]) => ({ key, value })),
    addresses: addresses.filter((address) => encodeIpv4(address) !== null),
    // Interfaces to join the multicast group on. Empty means "let the OS pick
    // the default interface", which is the only mode that reliably receives on
    // Windows — see the comment on the membership loop in start().
    interfaces: Array.isArray(options.interfaces) ? options.interfaces : []
  };
}

function buildResponse(query, service) {
  const serviceType = service.serviceType.toLowerCase();
  const instanceName = service.instanceName.toLowerCase();
  const enumeration = SERVICE_ENUMERATION.toLowerCase();

  let servicePointer = false;
  let enumerationPointer = false;
  let instanceRecords = false;

  for (const question of query.questions) {
    const name = String(question.name || '').toLowerCase();
    const any = question.type === TYPE_ANY;
    if (name === enumeration && (any || question.type === TYPE_PTR)) {
      enumerationPointer = true;
    } else if (name === serviceType) {
      if (any || question.type === TYPE_PTR) servicePointer = true;
      // QTYPE=ANY against the service type asks for everything we know about it.
      if (any) instanceRecords = true;
    } else if (name === instanceName
      && (any || question.type === TYPE_SRV || question.type === TYPE_TXT || question.type === TYPE_A)) {
      instanceRecords = true;
    }
  }

  // RFC 6763 §12.1: a PTR answer is accompanied by the SRV/TXT/A records it
  // points at, so a resolver learns everything in one round trip instead of
  // issuing a second query. Android's NsdManager resolves in a follow-up step
  // and works either way, but this keeps discovery a single exchange.
  if (servicePointer) instanceRecords = true;
  if (!servicePointer && !enumerationPointer && !instanceRecords) return null;

  const answers = [];
  const additionals = [];

  if (enumerationPointer) {
    answers.push(encodeRecord(SERVICE_ENUMERATION, TYPE_PTR, CLASS_IN, TTL_PTR, encodeName(service.serviceType)));
  }
  if (servicePointer) {
    answers.push(encodeRecord(service.serviceType, TYPE_PTR, CLASS_IN, TTL_PTR, encodeName(service.instanceFqdn)));
  }
  if (instanceRecords) {
    additionals.push(encodeRecord(
      service.instanceFqdn, TYPE_SRV, CLASS_IN | CACHE_FLUSH, TTL_UNIQUE,
      encodeSrv(0, 0, service.port, service.target)
    ));
    additionals.push(encodeRecord(
      service.instanceFqdn, TYPE_TXT, CLASS_IN | CACHE_FLUSH, TTL_UNIQUE,
      encodeTxt(service.txtEntries)
    ));
    // An A record is named for the SRV target, NOT the instance. That is the
    // only name a resolver can use to tie the address back to the host the SRV
    // points at: it reads `target` out of the SRV, then looks for A records
    // under exactly that name. Keying them on the instance name instead makes
    // the address unreachable by any conforming resolver — which is how this
    // shipped and went unnoticed until our own browser tried to read it back.
    for (const address of service.addresses) {
      const rdata = encodeIpv4(address);
      if (rdata) {
        additionals.push(encodeRecord(service.target, TYPE_A, CLASS_IN | CACHE_FLUSH, TTL_UNIQUE, rdata));
      }
    }
  }

  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(FLAG_RESPONSE, 2);
  header.writeUInt16BE(0, 4); // mDNS responses carry no question section
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([header, ...answers, ...additionals]);
}

// A minimal responder, not a full mDNS implementation. Deliberately absent, and
// each omission is safe because of what this process is:
//   - known-answer suppression: we are the only advertiser of this service type
//     on the subnet, so suppressing costs bandwidth and nothing else;
//   - hostname conflict detection / probing: the gateway advertises addresses it
//     already owns rather than claiming a new unique name (RFC 6762 §8);
//   - goodbye packets (TTL=0) and cache maintenance: the responder's lifetime is
//     the process's lifetime, and every record it sent carries a TTL of at most
//     4500s, so a crash expires out of peer caches on its own;
//   - AAAA records: the gateway publishes IPv4 LAN addresses only.
// Adding any of these would be a real implementation, which is a dependency,
// and this module exists so the gateway does not need one.
function createMdnsResponder(options = {}) {
  const service = normalizeService(options);
  const logger = options.logger || { error() {}, warn() {}, log() {} };
  let socket = null;
  // Filled only while verifyDelivery() is waiting; see its comment for why
  // "the socket bound" is not the same as "the socket receives".
  const deliveryObservers = new Set();

  function handleQuery(message, rinfo) {
    try {
      const query = parseDnsMessage(message);
      if (!query) return null;
      const response = buildResponse(query, service);
      if (!response) return null;
      return {
        response,
        // RFC 6762 §6.7 / §5.4: a query from the mDNS port wants a multicast
        // answer so every peer on the link learns it; anything else is a
        // one-off legacy unicast query and must be answered at its source port,
        // or the asker never sees a reply.
        address: rinfo && rinfo.port === MDNS_PORT ? MDNS_GROUP : rinfo?.address,
        port: rinfo && rinfo.port === MDNS_PORT ? MDNS_PORT : rinfo?.port
      };
    } catch (_) {
      // One unparseable packet on a multicast group is routine noise; it must
      // not become an unhandled rejection on a socket nobody is awaiting.
      return null;
    }
  }

  function replyTo(message, rinfo) {
    try {
      return handleQuery(message, rinfo);
    } catch (error) {
      (logger.error || (() => {}))(`mDNS response failed: ${error?.message || error}`);
      return null;
    }
  }

  function start() {
    if (socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const next = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        try { next.close(); } catch (_) { /* already gone */ }
        const error = new Error(message);
        error.code = 'mdns_bind_failed';
        reject(error);
      };
      next.on('error', (error) => {
        if (!settled) fail(`mDNS responder could not bind port ${MDNS_PORT}: ${error?.message || error}`);
        else (logger.error || (() => {}))(`mDNS socket error: ${error?.message || error}`);
      });
      next.on('message', (message, rinfo) => {
        // Delivery observers are notified first and are not allowed to change
        // how the query is answered — they exist only to report that a packet
        // arrived at all.
        for (const observer of deliveryObservers) {
          try { observer(); } catch (_) { /* observation must not affect answering */ }
        }
        const reply = replyTo(message, rinfo);
        if (!reply || !reply.address || !reply.port) return;
        next.send(reply.response, 0, reply.response.length, reply.port, reply.address, (error) => {
          if (error) (logger.error || (() => {}))(`mDNS send failed: ${error.message}`);
        });
      });
      next.bind(MDNS_PORT, () => {
        try {
          // Joined on the OS default interface, not once per LAN address.
          //
          // Per-interface membership is the textually obvious thing for a
          // multi-homed host and measurably does not work on Windows: joining
          // `224.0.0.251` on a specific adapter address silently stops that
          // socket receiving anything at all, while the no-argument join
          // receives fine. Verified on Windows 11 with Bonjour resident. So the
          // default stays with the OS, which also matches what a single-link
          // LAN — the case this responder exists for — actually needs. Pass
          // `interfaces` explicitly to opt into per-link joins.
          if (service.interfaces.length === 0) next.addMembership(MDNS_GROUP);
          else for (const address of service.interfaces) next.addMembership(MDNS_GROUP, address);
          next.setMulticastTTL(255);
          // So a resolver on this same host — a test, or another process —
          // sees us. Also what makes the self-verification below possible.
          next.setMulticastLoopback(true);
        } catch (error) {
          fail(`mDNS responder could not join ${MDNS_GROUP}: ${error?.message || error}`);
          return;
        }
        settled = true;
        socket = next;
        resolve();
      });
    });
  }

  /**
   * Proves the socket actually receives, rather than merely having bound.
   *
   * `bind()` on port 5353 succeeds even when several other processes hold it —
   * on Windows it is routine to find Bonjour and half a dozen others there, and
   * `SO_REUSEADDR` makes each new bind look fine while the kernel delivers
   * unicast/multicast to one socket only. The responder would then sit there
   * reporting success and answering nobody, which is the worst possible
   * outcome for a discovery feature: the gateway log says "advertising" and no
   * device ever finds it.
   *
   * So: multicast one query for our own service and see whether it comes back.
   * Reception may be our own packet looping back or a different responder on
   * the link answering; either proves this socket is on the group.
   */
  function ownServiceQuery() {
    const question = encodeName(service.serviceType);
    const fixed = Buffer.alloc(4);
    fixed.writeUInt16BE(TYPE_PTR, 0);
    fixed.writeUInt16BE(CLASS_IN, 2);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4); // QDCOUNT
    return Buffer.concat([header, question, fixed]);
  }

  async function verifyDelivery(timeoutMs = SELF_PROBE_TIMEOUT_MS) {
    if (!socket) return false;
    const current = socket;
    return new Promise((resolve) => {
      let done = false;
      const finish = (verified) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        deliveryObservers.delete(observe);
        resolve(verified);
      };
      const observe = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      deliveryObservers.add(observe);
      current.send(ownServiceQuery(), 0, ownServiceQuery().length, MDNS_PORT, MDNS_GROUP, (error) => {
        if (error) finish(false);
      });
    });
  }

  function stop() {
    if (!socket) return Promise.resolve();
    const current = socket;
    socket = null;
    return new Promise((resolve) => {
      current.once('close', () => resolve());
      try { current.close(); } catch (_) { resolve(); }
    });
  }

  return {
    start, stop, handleQuery, service, verifyDelivery,
    get listening() { return Boolean(socket); }
  };
}

function serviceTypeQuery(serviceType, qtype = TYPE_PTR) {
  const fixed = Buffer.alloc(4);
  fixed.writeUInt16BE(qtype, 0);
  fixed.writeUInt16BE(CLASS_IN, 2);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT
  return Buffer.concat([header, encodeName(serviceType), fixed]);
}

/**
 * Finds services of a type on the local network by asking and listening — the
 * counterpart to createMdnsResponder().
 *
 * Bound to an ephemeral port rather than 5353 on purpose. 5353 is exactly the
 * port this process may already be *answering* on when it also hosts a gateway,
 * and on Windows two sockets bound there under SO_REUSEADDR do not both receive
 * — one wins and the other silently hears nothing. An ephemeral source port is
 * answered by every conforming responder and cannot collide with our own.
 *
 * Records arrive a few at a time and sometimes split across packets: a PTR
 * names the instance, while its port, TXT and address ride along in the same or
 * a later response. Entries are therefore merged by instance name and published
 * only once an address is known, so a caller never sees a half-built service.
 */
function createMdnsBrowser(options = {}) {
  const serviceType = String(options.serviceType || DEFAULT_SERVICE_TYPE).replace(/\.$/, '');
  const logger = options.logger || { error() {}, warn() {}, log() {} };
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
  const entries = new Map(); // instance name -> service
  let socket = null;

  function publish() {
    if (onUpdate) {
      try { onUpdate(services()); } catch (_) { /* a listener must not break discovery */ }
    }
  }

  function services() {
    return [...entries.values()]
      .filter((service) => service.addresses.length > 0 || service.host)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function ingest(message) {
    let response;
    try {
      response = parseDnsResponse(message);
    } catch (_) {
      return;
    }
    if (!response) return;

    // The instance name is the map key, kept lowercase for case-insensitive
    // merge — mDNS names are case-insensitive but arrive in mixed case across
    // PTR (original) and SRV/TXT (often the same, but never rely on it).
    function keyFor(value) {
      return String(value || '').toLowerCase();
    }
    // A PTR answer carries the instance name; SRV/TXT/A records are named for
    // the instance, the SRV target, or that target respectively. An instance
    // record name ends with the service type but is not the service type.
    function isInstanceName(value) {
      const lower = keyFor(value);
      return lower.endsWith(serviceType.toLowerCase()) && lower !== serviceType.toLowerCase();
    }

    // Pass 1: instances and their own records.
    for (const record of response.records) {
      const recordName = keyFor(record.name);

      if (record.type === TYPE_PTR) {
        const instance = decodeName(record.rdata, 0).name;
        if (!instance) continue;
        const key = keyFor(instance);
        if (record.ttl === 0) { entries.delete(key); continue; }
        if (!entries.has(key)) entries.set(key, { name: instance, host: '', port: 0, txt: {}, addresses: [] });
        continue;
      }
      if (record.type === TYPE_SRV) {
        const key = keyFor(recordName);
        if (record.ttl === 0) { entries.delete(key); continue; }
        const decoded = decodeSrv(record.rdata);
        if (!decoded) continue;
        const entry = entries.get(key) || { name: record.name, host: '', port: 0, txt: {}, addresses: [] };
        // The SRV target is a name, which is not usable as an address; the
        // address itself arrives as an A record keyed by that target.
        entry.srvTarget = decoded.target;
        entry.port = decoded.port;
        entries.set(key, entry);
        continue;
      }
      if (record.type === TYPE_TXT && isInstanceName(record.name)) {
        const key = keyFor(record.name);
        const entry = entries.get(key);
        if (entry) entry.txt = { ...entry.txt, ...decodeTxt(record.rdata) };
        continue;
      }
    }

    // Pass 2: A records name the SRV target, so they can only be attached once
    // every SRV has been read.
    for (const record of response.records) {
      if (record.type !== TYPE_A) continue;
      const address = decodeARecord(record.rdata);
      if (!address) continue;
      const owner = String(record.name || '').toLowerCase();
      for (const entry of entries.values()) {
        if (String(entry.srvTarget || '').toLowerCase() !== owner) continue;
        if (record.ttl === 0) entry.addresses = entry.addresses.filter((value) => value !== address);
        else if (!entry.addresses.includes(address)) entry.addresses.push(address);
        entry.host = entry.addresses[0] || entry.host;
      }
    }

    publish();
  }

  function start() {
    if (socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      // reuseAddr so a browser can coexist with another process on this host
      // that is listening for mDNS; the port itself is chosen by the OS.
      const next = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        try { next.close(); } catch (_) { /* already gone */ }
        const error = new Error(message);
        error.code = 'mdns_bind_failed';
        reject(error);
      };
      next.on('error', (error) => {
        if (!settled) fail(`mDNS browser failed: ${error?.message || error}`);
        else (logger.error || (() => {}))(`mDNS browser error: ${error?.message || error}`);
      });
      next.on('message', (message) => {
        try { ingest(message); }
        catch (error) { (logger.error || (() => {}))(`mDNS browser parse failed: ${error?.message || error}`); }
      });
      next.bind(0, () => {
        try {
          // Default interface, matching the responder: per-interface joins do
          // not receive on Windows.
          next.addMembership(MDNS_GROUP);
          next.setMulticastTTL(255);
          next.setMulticastLoopback(true);
        } catch (error) {
          fail(`mDNS browser could not join ${MDNS_GROUP}: ${error?.message || error}`);
          return;
        }
        settled = true;
        socket = next;
        resolve();
      });
    });
  }

  function stop() {
    if (!socket) return Promise.resolve();
    const current = socket;
    socket = null;
    return new Promise((resolve) => {
      current.once('close', () => resolve());
      try { current.close(); } catch (_) { resolve(); }
    });
  }

  /** One query. Repeated calls refresh; cached responders answer immediately. */
  function query() {
    if (!socket) return false;
    const packet = serviceTypeQuery(serviceType);
    return new Promise((resolve) => {
      socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_GROUP, (error) => {
        if (error) {
          (logger.error || (() => {}))(`mDNS browser send failed: ${error.message}`);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  return {
    start, stop, query, ingest, services,
    serviceType,
    get listening() { return Boolean(socket); }
  };
}

/**
 * One-shot discovery: ask, wait, report.
 *
 * Enough for a settings screen that lists what is on the network, and it avoids
 * leaving a socket open for the lifetime of the app just to answer a question
 * the user asks once.
 */
async function discoverServices(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 3000;
  const browser = createMdnsBrowser(options);
  try {
    await browser.start();
    // Asked twice, a few hundred ms apart. One mDNS query is cheap to drop and
    // a single lost packet otherwise costs the whole discovery.
    await browser.query();
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, timeoutMs / 2)));
    await browser.query();
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return browser.services();
  } finally {
    await browser.stop();
  }
}

module.exports = {
  CLASS_IN,
  DEFAULT_SERVICE_TYPE,
  MDNS_GROUP,
  MDNS_PORT,
  SERVICE_ENUMERATION,
  TYPE_A,
  TYPE_AAAA,
  TYPE_ANY,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
  buildResponse,
  createMdnsBrowser,
  createMdnsResponder,
  decodeARecord,
  decodeName,
  decodeSrv,
  decodeTxt,
  defaultAddresses,
  discoverServices,
  encodeIpv4,
  encodeName,
  encodeRecord,
  encodeSrv,
  encodeTxt,
  isAdvertisableAddress,
  normalizeService,
  parseDnsMessage,
  parseDnsResponse,
  serviceTypeQuery
};
