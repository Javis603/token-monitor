// @ts-check
'use strict';

const AF_INET = 2;
const AF_INET6 = 23;
const TCP_TABLE_OWNER_PID_LISTENER = 3;
const TCP_TABLE_OWNER_PID_CONNECTIONS = 4;
const MIB_TCP_STATE_LISTEN = 2;
const MIB_TCP_STATE_ESTAB = 5;
const IPV4_LOOPBACK_BE = 0x7f000001;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_DATA = 232;
const IPV4_ROW_BYTES = 24;
const IPV6_ROW_BYTES = 56;
const MAX_TABLE_ATTEMPTS = 6;

/** @typedef {(buffer: Buffer | null, size: number[], order: number, af: number, tableClass: number, reserved: number) => number} ExtendedTcpTableFn */

/** @type {ExtendedTcpTableFn | null | undefined} */
let api;

/**
 * Lazy-load Win32 GetExtendedTcpTable via koffi.
 * @returns {ExtendedTcpTableFn | null}
 */
function tcpTableApi() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const iphlpapi = koffi.load('iphlpapi.dll');
    api = /** @type {ExtendedTcpTableFn} */ (/** @type {unknown} */ (iphlpapi.func(
      'uint32_t __stdcall GetExtendedTcpTable(void *pTcpTable, _Inout_ uint32_t *pdwSize, int bOrder, uint32_t ulAf, int TableClass, uint32_t Reserved)'
    )));
  } catch (_) { /* No native binding: callers fall back to PowerShell. */ }
  return api;
}

/**
 * @param {number} value
 * @returns {boolean}
 */
function isValidPid(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

/**
 * @param {number} value
 * @returns {boolean}
 */
function isValidPort(value) {
  return Number.isInteger(value) && value > 0 && value < 65536;
}

/**
 * Query a Win32 extended TCP table, retrying when concurrent socket churn grows the table.
 * @param {number} af
 * @param {number} tableClass
 * @param {ExtendedTcpTableFn} getExtendedTcpTable
 * @returns {Buffer}
 */
function queryExtendedTcpTable(af, tableClass, getExtendedTcpTable) {
  const size = [0];
  let rc = getExtendedTcpTable(null, size, 0, af, tableClass, 0);
  if (rc === ERROR_NO_DATA) return Buffer.alloc(4);
  for (let attempt = 0; attempt < MAX_TABLE_ATTEMPTS && rc === ERROR_INSUFFICIENT_BUFFER; attempt += 1) {
    const requested = size[0];
    if (!Number.isInteger(requested) || requested < 0) {
      throw new Error(`GetExtendedTcpTable returned invalid buffer size: ${requested}`);
    }
    const buffer = Buffer.allocUnsafe(requested + 4096);
    size[0] = buffer.length;
    rc = getExtendedTcpTable(buffer, size, 0, af, tableClass, 0);
    if (rc === 0) return buffer.subarray(0, size[0]);
    if (rc === ERROR_NO_DATA) return Buffer.alloc(4);
  }
  if (rc === 0) return Buffer.alloc(4);
  throw new Error(`GetExtendedTcpTable failed with status ${rc}`);
}

/**
 * Parse listening ports owned by `pid` from an IPv4 MIB_TCPTABLE_OWNER_PID buffer.
 * @param {Buffer} buffer
 * @param {number} pid
 * @param {boolean} [ipv4LoopbackOnly=false]
 * @returns {number[]}
 */
function parseIpv4ListeningPorts(buffer, pid, ipv4LoopbackOnly = false) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || !isValidPid(pid)) return [];
  const count = Math.min(buffer.readUInt32LE(0), Math.floor((buffer.length - 4) / IPV4_ROW_BYTES));
  /** @type {Set<number>} */
  const ports = new Set();
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * IPV4_ROW_BYTES;
    const state = buffer.readUInt32LE(offset);
    if (state !== MIB_TCP_STATE_LISTEN) continue;
    const owningPid = buffer.readUInt32LE(offset + 20);
    if (owningPid !== pid) continue;
    if (ipv4LoopbackOnly && buffer.readUInt32BE(offset + 4) !== IPV4_LOOPBACK_BE) continue;
    // Per Win32 MIB_TCPROW_OWNER_PID, only the first two network-order bytes hold the port.
    const port = buffer.readUInt16BE(offset + 8);
    if (port > 0) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/**
 * Parse listening ports owned by `pid` from an IPv6 MIB_TCP6TABLE_OWNER_PID buffer.
 * @param {Buffer} buffer
 * @param {number} pid
 * @returns {number[]}
 */
function parseIpv6ListeningPorts(buffer, pid) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || !isValidPid(pid)) return [];
  const count = Math.min(buffer.readUInt32LE(0), Math.floor((buffer.length - 4) / IPV6_ROW_BYTES));
  /** @type {Set<number>} */
  const ports = new Set();
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * IPV6_ROW_BYTES;
    const state = buffer.readUInt32LE(offset + 48);
    if (state !== MIB_TCP_STATE_LISTEN) continue;
    const owningPid = buffer.readUInt32LE(offset + 52);
    if (owningPid !== pid) continue;
    const port = buffer.readUInt16BE(offset + 20);
    if (port > 0) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/**
 * Check whether an established IPv4 loopback connection in MIB_TCPTABLE_OWNER_PID belongs to `owningPid`.
 * @param {Buffer} buffer
 * @param {{ localPort: number, remotePort: number, owningPid: number }} target
 * @returns {boolean}
 */
function parseIpv4LoopbackSocketOwned(buffer, target) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || !target) return false;
  const { localPort, remotePort, owningPid } = target;
  if (!isValidPort(localPort) || !isValidPort(remotePort) || !isValidPid(owningPid)) return false;
  const count = Math.min(buffer.readUInt32LE(0), Math.floor((buffer.length - 4) / IPV4_ROW_BYTES));
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * IPV4_ROW_BYTES;
    if (buffer.readUInt32LE(offset) !== MIB_TCP_STATE_ESTAB) continue;
    if (buffer.readUInt32LE(offset + 20) !== owningPid) continue;
    if (buffer.readUInt32BE(offset + 4) !== IPV4_LOOPBACK_BE) continue;
    if (buffer.readUInt16BE(offset + 8) !== localPort) continue;
    if (buffer.readUInt32BE(offset + 12) !== IPV4_LOOPBACK_BE) continue;
    if (buffer.readUInt16BE(offset + 16) !== remotePort) continue;
    return true;
  }
  return false;
}

/**
 * Read TCP listening ports for `pid` on Windows via iphlpapi, or null if native access is unavailable.
 * @param {number} pid
 * @param {{ ipv4LoopbackOnly?: boolean, native?: ExtendedTcpTableFn | null }} [options]
 * @returns {number[] | null}
 */
function readWindowsListeningPorts(pid, options = {}) {
  const native = options.native !== undefined ? options.native : tcpTableApi();
  if (!native) return null;
  if (!isValidPid(pid)) return [];
  const ipv4LoopbackOnly = Boolean(options.ipv4LoopbackOnly);
  try {
    const v4 = queryExtendedTcpTable(AF_INET, TCP_TABLE_OWNER_PID_LISTENER, native);
    const ports = new Set(parseIpv4ListeningPorts(v4, pid, ipv4LoopbackOnly));
    if (!ipv4LoopbackOnly) {
      const v6 = queryExtendedTcpTable(AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, native);
      for (const port of parseIpv6ListeningPorts(v6, pid)) ports.add(port);
    }
    return [...ports].sort((left, right) => left - right);
  } catch (_) {
    return null;
  }
}

/**
 * Verify that an established 127.0.0.1 TCP connection is owned by `owningPid`, or null if native access is unavailable.
 * @param {{ localPort: number, remotePort: number, owningPid: number }} target
 * @param {ExtendedTcpTableFn | null} [native]
 * @returns {boolean | null}
 */
function isWindowsLoopbackTcpSocketOwned(target, native = tcpTableApi()) {
  if (!native) return null;
  if (!target || !isValidPort(target.localPort) || !isValidPort(target.remotePort) || !isValidPid(target.owningPid)) {
    return false;
  }
  try {
    const v4 = queryExtendedTcpTable(AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, native);
    return parseIpv4LoopbackSocketOwned(v4, target);
  } catch (_) {
    return null;
  }
}

module.exports = {
  AF_INET,
  AF_INET6,
  ERROR_INSUFFICIENT_BUFFER,
  ERROR_NO_DATA,
  IPV4_ROW_BYTES,
  IPV6_ROW_BYTES,
  MIB_TCP_STATE_ESTAB,
  MIB_TCP_STATE_LISTEN,
  TCP_TABLE_OWNER_PID_CONNECTIONS,
  TCP_TABLE_OWNER_PID_LISTENER,
  isWindowsLoopbackTcpSocketOwned,
  parseIpv4ListeningPorts,
  parseIpv4LoopbackSocketOwned,
  parseIpv6ListeningPorts,
  queryExtendedTcpTable,
  readWindowsListeningPorts
};
