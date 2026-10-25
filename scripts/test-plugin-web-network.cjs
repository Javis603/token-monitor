'use strict';
// Real Rich controller/preload and Chromium networking; every listener is
// loopback-only and every payload is synthetic. No collector or user profile.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dgram = require('node:dgram'), net = require('node:net'), http = require('node:http');
const electron = require('electron');
const { app, BrowserWindow, ipcMain, session } = electron;
const { registerPluginScheme } = require('../src/electron/plugins/runtime');
const { parsePackage } = require('../src/electron/plugins/package');
const modulePath = path.resolve(__dirname, '../src/electron/plugins/webUi.js');
let implementation = require(modulePath);
// A saved pre-fix controller proves that the same assertions detect the hole.
if (process.env.TM_NETWORK_BASELINE) {
  const Module = require('node:module'), baseline = new Module(modulePath, module);
  baseline.filename = modulePath; baseline.paths = Module._nodeModulePaths(path.dirname(modulePath));
  baseline._compile(fs.readFileSync(process.env.TM_NETWORK_BASELINE, 'utf8'), modulePath);
  implementation = baseline.exports;
}
const { createWebUi, CSP } = implementation;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-web-network-'));
app.setPath('userData', path.join(scratch, 'profile'));
registerPluginScheme(electron.protocol);
app.on('window-all-closed', () => {});
const report = { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, checks: [], phases: {} };
const listeners = [], sockets = new Set();
let owner, control, controller, phase = 'control';
const captures = { control: { udp: [], tcp: [], http: [], tcpConnections: [] }, rich: { udp: [], tcp: [], http: [], tcpConnections: [] } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, ok) { report.checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
function attribute(type, value) {
  const bytes = Buffer.from(value), result = Buffer.alloc(4 + Math.ceil(bytes.length / 4) * 4);
  result.writeUInt16BE(type); result.writeUInt16BE(bytes.length, 2); bytes.copy(result, 4); return result;
}
function turnPacket(transport, packet, reply) {
  if (packet.length < 20 || packet.readUInt32BE(4) !== 0x2112a442) return;
  const entry = { type: packet.readUInt16BE(0), bytes: packet.length, username: null };
  for (let at = 20; at + 4 <= packet.length;) {
    const type = packet.readUInt16BE(at), length = packet.readUInt16BE(at + 2);
    if (at + 4 + length > packet.length) return;
    if (type === 6) entry.username = packet.subarray(at + 4, at + 4 + length).toString();
    at += 4 + Math.ceil(length / 4) * 4;
  }
  captures[phase][transport].push(entry);
  if (entry.type !== 3 || entry.username) return;
  // A minimal 401 challenge makes the next Allocate carry the synthetic
  // username. No relay is allocated and no packet is forwarded anywhere.
  const body = Buffer.concat([attribute(9, Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from('Unauthorized')])),
    attribute(20, 'local-fixture'), attribute(21, 'local-nonce')]);
  const header = Buffer.alloc(20); header.writeUInt16BE(0x0113); header.writeUInt16BE(body.length, 2); packet.copy(header, 4, 4, 20);
  reply(Buffer.concat([header, body]));
}
async function endpoints() {
  const udp = dgram.createSocket('udp4'); listeners.push(udp);
  udp.on('message', (packet, remote) => turnPacket('udp', packet, reply => udp.send(reply, remote.port, remote.address)));
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  const tcp = net.createServer(socket => {
    captures[phase].tcpConnections.push({ address: socket.remoteAddress, port: socket.remotePort });
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 20) {
        const size = 20 + pending.readUInt16BE(2);
        if (pending.length < size) break;
        const packet = pending.subarray(0, size); pending = pending.subarray(size);
        turnPacket('tcp', packet, reply => socket.write(reply));
      }
    });
  }); listeners.push(tcp); await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const web = http.createServer((request, response) => { captures[phase].http.push(request.url); response.end('synthetic'); });
  listeners.push(web); await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  return { udp: udp.address().port, tcp: tcp.address().port, http: web.address().port };
}
// This function runs as an ordinary packaged author script, not injected JS.
function authorProgram(ports, variants) {
  const result = window.result = { attempts: [], pcs: [], done: false, fetchBlocked: false };
  const pending = [];
  async function attempt(label, realm, key) {
    for (const transport of ['udp', 'tcp']) {
      const row = { label, key, transport, blocked: false }; result.attempts.push(row);
      try {
        const pc = new realm[key]({ iceServers: [{ urls: `turn:127.0.0.1:${ports[transport]}?transport=${transport}`,
          username: `synthetic-${transport}`, credential: 'synthetic-password' }], iceTransportPolicy: 'relay' });
        result.pcs.push(pc); pc.createDataChannel('synthetic');
        await pc.setLocalDescription(await pc.createOffer());
      } catch (error) { row.blocked = error.name === 'NotAllowedError' || label !== 'main' && label !== 'alias' && error.name === 'SecurityError'; row.error = String(error); }
    }
  }
  pending.push(fetch(`http://127.0.0.1:${ports.http}/synthetic`).then(() => {}, () => { result.fetchBlocked = true; }));
  pending.push(attempt('main', window, 'RTCPeerConnection'));
  if (variants) {
    pending.push(attempt('alias', window, 'webkitRTCPeerConnection'));
    // A synchronous initial about:blank realm exists even when frame-src
    // prevents navigation. Native policy must survive this constructor path.
    const frame = window.document.createElement('iframe'); window.document.body.append(frame);
    const child = frame.contentWindow;
    pending.push(attempt('initial-blank', child, 'RTCPeerConnection'));
    pending.push(attempt('initial-blank-alias', child, 'webkitRTCPeerConnection'));
    frame.remove();
    pending.push(attempt('detached-realm', child, 'RTCPeerConnection'));
    pending.push(window.tm.context().then(context => { result.bridge = context.snapshot.target; }));
  }
  Promise.all(pending).then(() => { result.done = true; });
}
function assets(ports, variants) {
  return {
    'index.html': Buffer.from('<!doctype html><link rel="stylesheet" href="style.css"><body><p id="content">Local fixture</p><img id="art" src="art.svg"><script src="probe.js"></script></body>'),
    'style.css': Buffer.from('#content { color: rgb(12, 34, 56); }'),
    'art.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>'),
    'probe.js': Buffer.from(`(${authorProgram.toString()})(${JSON.stringify(ports)},${variants});`)
  };
}
async function collect(wc) {
  for (let i = 0; i < 100; i++) {
    if (await wc.executeJavaScript('Boolean(window.result?.done)')) break;
    await wait(30);
  }
  await wait(3500);
  const result = await wc.executeJavaScript(`({done: result.done, attempts: result.attempts, fetchBlocked: result.fetchBlocked, bridge: result.bridge,
    styled: getComputedStyle(document.getElementById('content')).color === 'rgb(12, 34, 56)', image: document.getElementById('art').naturalWidth === 10})`);
  await wc.executeJavaScript('result.pcs.forEach(pc => pc.close()); true');
  return result;
}
async function run() {
  const ports = await endpoints(); report.ports = ports;
  // Positive endpoint control: same scheme/CSP/permission denial without the
  // new header. This detects an environment which cannot send loopback RTC.
  const ses = session.fromPartition('tm-network-control', { cache: false }), bytes = assets(ports, false);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('tm-plugin-ui://control/') }));
  ses.protocol.handle('tm-plugin-ui', request => {
    const name = new URL(request.url).pathname.slice(1), types = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' };
    return new Response(bytes[name], { headers: { 'Content-Type': types[name.split('.').at(-1)], 'Content-Security-Policy': CSP } });
  });
  control = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await control.loadURL('tm-plugin-ui://control/index.html'); report.phases.control = await collect(control.webContents);
  check('positive control sends the synthetic TURN username over UDP', captures.control.udp.some(p => p.username === 'synthetic-udp'));
  check('positive control sends the synthetic TURN username over TCP', captures.control.tcp.some(p => p.username === 'synthetic-tcp'));
  control.destroy(); control = null; for (const socket of sockets) socket.destroy(); await wait(100);
  phase = 'rich';
  const raw = { id: 'network-fixture', name: 'Network fixture', version: '1.0.0', tmApi: 1, permissions: ['ui.web', 'tm.pages'],
    webUi: { version: 1, assets: Object.keys(bytes), documents: [{ id: 'models', entry: 'index.html', target: 'model', slot: 'replace' }] } };
  const pkg = parsePackage(JSON.stringify({ format: 1, manifest: raw, assets: Object.fromEntries(Object.entries(assets(ports, true)).map(([k, v]) => [k, v.toString('base64')])) }));
  const info = { pluginId: raw.id, ref: `${raw.id}/models`, revision: pkg.hash, manifest: pkg.manifest, document: pkg.manifest.webUi.documents[0], assets: pkg.assets };
  const handlers = new Map();
  const ipc = { handle(name, fn) { handlers.set(name, fn); ipcMain.handle(name, fn); }, removeHandler: name => ipcMain.removeHandler(name) };
  owner = new BrowserWindow({ show: true, width: 640, height: 480, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,<body>Local network test owner</body>');
  controller = createWebUi({ electron: { ...electron, ipcMain: ipc }, manager: { webDocument: () => info, onChanged: () => () => {}, setWebVisible() {} },
    bus: { subscribe: () => () => {}, clearDemand() {} }, isMainSender: event => event.sender === owner.webContents, file: path.join(scratch, 'selection.json') });
  const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
  handlers.get('plugins:web:select')(event, 'model', info.ref);
  const mounted = handlers.get('plugins:web:sync')(event, { visible: true, snapshot: { target: 'model', period: 'today', rows: [] }, rect: { x: 0, y: 0, width: 500, height: 400 } });
  const item = controller.current(); if (!item) throw Error(`Rich child not mounted: ${JSON.stringify(mounted)}`);
  const value = report.phases.rich = await collect(item.view.webContents);
  check('production Rich script and fixed bridge load', value.done && value.bridge === 'model' && item.ready);
  check('local CSS and SVG still load under the network policy', value.styled && value.image);
  check('ordinary fetch remains blocked without reaching HTTP listener', value.fetchBlocked && captures.rich.http.length === 0);
  for (const label of ['main', 'alias', 'initial-blank', 'initial-blank-alias', 'detached-realm']) {
    const rows = value.attempts.filter(row => row.label === label);
    check(`${label}: UDP and TCP WebRTC access denied`, rows.length === 2 && rows.every(row => row.blocked));
  }
  check('production Rich page sends no UDP STUN/TURN packets', captures.rich.udp.length === 0);
  check('production Rich page makes no TCP connection or TURN request', captures.rich.tcpConnections.length === 0 && captures.rich.tcp.length === 0);
}
function finish(error) {
  if (error) { report.error = error.stack || String(error); console.error(report.error); }
  controller?.dispose(); owner?.destroy(); control?.destroy();
  for (const socket of sockets) socket.destroy(); for (const listener of listeners) listener.close();
  report.captures = captures; fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(report, null, 2));
  console.log(`REPORT ${path.join(scratch, 'results.json')}`);
  app.exit(error || report.checks.some(row => !row.ok) ? 1 : 0);
}
const deadline = setTimeout(() => finish(Error('network fixture deadline')), 25000);
app.whenReady().then(run).then(() => { clearTimeout(deadline); finish(); }, error => { clearTimeout(deadline); finish(error); });
