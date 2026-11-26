'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const tcpTable = require('../../src/shared/windowsTcpTable');

function encodeIpv4Row({
  state,
  localAddr,
  localPort,
  localPortGarbage = 0,
  remoteAddr = '0.0.0.0',
  remotePort = 0,
  owningPid
}) {
  const row = Buffer.alloc(tcpTable.IPV4_ROW_BYTES);
  row.writeUInt32LE(state, 0);
  const writeIp = (ip, offset) => {
    const parts = ip.split('.').map(Number);
    row[offset] = parts[0];
    row[offset + 1] = parts[1];
    row[offset + 2] = parts[2];
    row[offset + 3] = parts[3];
  };
  writeIp(localAddr, 4);
  row.writeUInt16BE(localPort, 8);
  row.writeUInt16LE(localPortGarbage, 10);
  writeIp(remoteAddr, 12);
  row.writeUInt16BE(remotePort, 16);
  row.writeUInt32LE(owningPid, 20);
  return row;
}

function encodeIpv6Row({ state, localPort, localPortGarbage = 0, owningPid }) {
  const row = Buffer.alloc(tcpTable.IPV6_ROW_BYTES);
  row[15] = 1; // ::1
  row.writeUInt16BE(localPort, 20);
  row.writeUInt16LE(localPortGarbage, 22);
  row.writeUInt32LE(state, 48);
  row.writeUInt32LE(owningPid, 52);
  return row;
}

function encodeTable(rows) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(rows.length, 0);
  return Buffer.concat([header, ...rows]);
}

test('parseIpv4ListeningPorts filters by pid, state, loopback, ignores port upper bits, and sorts', () => {
  const buf = encodeTable([
    encodeIpv4Row({ state: tcpTable.MIB_TCP_STATE_LISTEN, localAddr: '127.0.0.1', localPort: 51153, localPortGarbage: 0xabcd, owningPid: 64252 }),
    encodeIpv4Row({ state: tcpTable.MIB_TCP_STATE_LISTEN, localAddr: '0.0.0.0', localPort: 49931, owningPid: 64252 }),
    encodeIpv4Row({ state: tcpTable.MIB_TCP_STATE_LISTEN, localAddr: '127.0.0.1', localPort: 51153, owningPid: 64252 }),
    encodeIpv4Row({ state: tcpTable.MIB_TCP_STATE_ESTAB, localAddr: '127.0.0.1', localPort: 55555, owningPid: 64252 }),
    encodeIpv4Row({ state: tcpTable.MIB_TCP_STATE_LISTEN, localAddr: '127.0.0.1', localPort: 40000, owningPid: 99999 })
  ]);

  assert.deepEqual(tcpTable.parseIpv4ListeningPorts(buf, 64252, false), [49931, 51153]);
  assert.deepEqual(tcpTable.parseIpv4ListeningPorts(buf, 64252, true), [51153]);
});

test('parseIpv6ListeningPorts filters by pid and state and ignores port upper bits', () => {
  const buf = encodeTable([
    encodeIpv6Row({ state: tcpTable.MIB_TCP_STATE_LISTEN, localPort: 54321, localPortGarbage: 0xbeef, owningPid: 64252 }),
    encodeIpv6Row({ state: tcpTable.MIB_TCP_STATE_ESTAB, localPort: 54322, owningPid: 64252 }),
    encodeIpv6Row({ state: tcpTable.MIB_TCP_STATE_LISTEN, localPort: 54323, owningPid: 11111 })
  ]);

  assert.deepEqual(tcpTable.parseIpv6ListeningPorts(buf, 64252), [54321]);
});

test('parseIpv4LoopbackSocketOwned matches exact established loopback tuple and pid', () => {
  const buf = encodeTable([
    encodeIpv4Row({
      state: tcpTable.MIB_TCP_STATE_LISTEN,
      localAddr: '127.0.0.1',
      localPort: 49931,
      remoteAddr: '127.0.0.1',
      remotePort: 60123,
      owningPid: 64252
    }),
    encodeIpv4Row({
      state: tcpTable.MIB_TCP_STATE_ESTAB,
      localAddr: '192.168.1.10',
      localPort: 49931,
      remoteAddr: '127.0.0.1',
      remotePort: 60123,
      owningPid: 64252
    }),
    encodeIpv4Row({
      state: tcpTable.MIB_TCP_STATE_ESTAB,
      localAddr: '127.0.0.1',
      localPort: 49931,
      remoteAddr: '127.0.0.1',
      remotePort: 60123,
      owningPid: 64252
    })
  ]);

  assert.equal(tcpTable.parseIpv4LoopbackSocketOwned(buf, { localPort: 49931, remotePort: 60123, owningPid: 64252 }), true);
  assert.equal(tcpTable.parseIpv4LoopbackSocketOwned(buf, { localPort: 49931, remotePort: 60124, owningPid: 64252 }), false);
  assert.equal(tcpTable.parseIpv4LoopbackSocketOwned(buf, { localPort: 49931, remotePort: 60123, owningPid: 12345 }), false);
});

test('readWindowsListeningPorts retries ERROR_INSUFFICIENT_BUFFER and handles ERROR_NO_DATA', () => {
  const v4Table = encodeTable([
    encodeIpv4Row({ state: tcpTable.MIB_TCP_STATE_LISTEN, localAddr: '127.0.0.1', localPort: 49931, owningPid: 777 })
  ]);
  const v6Table = encodeTable([
    encodeIpv6Row({ state: tcpTable.MIB_TCP_STATE_LISTEN, localPort: 49932, owningPid: 777 })
  ]);
  let calls = 0;
  const fakeNative = (buffer, size, _order, af) => {
    calls += 1;
    if (af === tcpTable.AF_INET6) return tcpTable.ERROR_NO_DATA;
    if (!buffer) {
      size[0] = 4; // intentionally smaller than v4Table.length to exercise second retry
      return tcpTable.ERROR_INSUFFICIENT_BUFFER;
    }
    if (buffer.length < v4Table.length + 4096) {
      size[0] = v4Table.length;
      return tcpTable.ERROR_INSUFFICIENT_BUFFER;
    }
    v4Table.copy(buffer);
    size[0] = v4Table.length;
    return 0;
  };

  const ports = tcpTable.readWindowsListeningPorts(777, { ipv4LoopbackOnly: false, native: fakeNative });
  assert.deepEqual(ports, [49931]);
  assert.equal(calls, 4);

  const bothCalls = tcpTable.readWindowsListeningPorts(777, {
    ipv4LoopbackOnly: false,
    native: (buffer, size, _order, af) => {
      const payload = af === tcpTable.AF_INET ? v4Table : v6Table;
      if (!buffer) {
        size[0] = payload.length;
        return tcpTable.ERROR_INSUFFICIENT_BUFFER;
      }
      payload.copy(buffer);
      size[0] = payload.length;
      return 0;
    }
  });
  assert.deepEqual(bothCalls, [49931, 49932]);
});

test('readWindowsListeningPorts and isWindowsLoopbackTcpSocketOwned return null when native is unavailable or errors', () => {
  assert.equal(tcpTable.readWindowsListeningPorts(123, { native: null }), null);
  assert.equal(tcpTable.isWindowsLoopbackTcpSocketOwned({ localPort: 80, remotePort: 90, owningPid: 123 }, null), null);

  const failingNative = () => 5; // ERROR_ACCESS_DENIED
  assert.equal(tcpTable.readWindowsListeningPorts(123, { native: failingNative }), null);
  assert.equal(tcpTable.isWindowsLoopbackTcpSocketOwned({ localPort: 80, remotePort: 90, owningPid: 123 }, failingNative), null);
});

test('live Win32 iphlpapi detects own loopback listener and established socket ownership quickly', { skip: process.platform !== 'win32' }, async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
  });
  let client = null;
  t.after(async () => {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const serverPort = server.address().port;

  client = net.createConnection({ host: '127.0.0.1', port: serverPort });
  await once(client, 'connect');

  const startedAt = performance.now();
  const ports = tcpTable.readWindowsListeningPorts(process.pid, { ipv4LoopbackOnly: true });
  const owned = tcpTable.isWindowsLoopbackTcpSocketOwned({
    localPort: serverPort,
    remotePort: client.localPort,
    owningPid: process.pid
  });
  const wrongPidOwned = tcpTable.isWindowsLoopbackTcpSocketOwned({
    localPort: serverPort,
    remotePort: client.localPort,
    owningPid: 2147483647
  });
  const elapsedMs = performance.now() - startedAt;

  assert.ok(Array.isArray(ports) && ports.includes(serverPort), `expected port ${serverPort} in ${JSON.stringify(ports)}`);
  assert.equal(owned, true);
  assert.equal(wrongPidOwned, false);
  assert.ok(elapsedMs < 200, `expected native Win32 TCP queries in <200ms, got ${elapsedMs.toFixed(1)}ms`);
});
