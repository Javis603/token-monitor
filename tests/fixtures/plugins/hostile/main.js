// Sandbox verification fixture: every probe below must fail. The harness
// substitutes the port of a local canary server; any request that reaches it
// is an escape. Results are published as one `report` object.

const CANARY = 'http://127.0.0.1:__PORT__';
const report = {};

function settle(name, promise) {
  return Promise.resolve()
    .then(() => promise())
    .then((value) => { report[name] = `allowed:${String(value).slice(0, 40)}`; })
    .catch((error) => { report[name] = `blocked:${String(error && (error.name || error.message) || error).slice(0, 40)}`; });
}

function attempt(name, fn) {
  try {
    const value = fn();
    report[name] = `allowed:${String(value).slice(0, 40)}`;
  } catch (error) {
    report[name] = `blocked:${String(error && (error.name || error.message) || error).slice(0, 40)}`;
  }
}

async function probe() {
  report.require = typeof require;
  report.process = typeof process;
  report.window = typeof window;
  report.document = typeof document;
  report.hostBridge = typeof self.tmPluginHost;
  report.sendBeacon = typeof navigator.sendBeacon;
  report.rtc = typeof self.RTCPeerConnection;

  await settle('fetchCanary', () => fetch(`${CANARY}/fetch`));
  await settle('fetchRemote', () => fetch('https://example.com/'));
  await settle('fetchFile', () => fetch('file:///etc/passwd'));
  await settle('fetchHost', () => fetch('tm-plugin://hostile/host.html'));
  await settle('fetchHub', () => fetch('http://127.0.0.1:17321/api/stats'));
  await settle('xhr', () => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.onload = () => resolve(request.status);
    request.onerror = () => reject(new Error('xhr error'));
    request.open('GET', `${CANARY}/xhr`);
    request.send();
  }));
  await settle('websocket', () => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${CANARY.replace('http', 'ws')}/ws`);
    socket.onopen = () => resolve('open');
    socket.onerror = () => reject(new Error('ws error'));
  }));
  await settle('eventSource', () => new Promise((resolve, reject) => {
    if (typeof EventSource !== 'function') { reject(new Error('unavailable')); return; }
    const source = new EventSource(`${CANARY}/sse`);
    source.onopen = () => resolve('open');
    source.onerror = () => reject(new Error('sse error'));
  }));
  attempt('importScripts', () => importScripts(`${CANARY}/import.js`));
  attempt('importBlob', () => importScripts(URL.createObjectURL(new Blob(['self.imported = 1'], { type: 'text/javascript' }))));
  attempt('eval', () => eval('1 + 1'));
  attempt('newFunction', () => new Function('return 1')());
  await settle('nestedWorkerNetwork', () => new Promise((resolve, reject) => {
    const source = `fetch('${CANARY}/nested').then(() => postMessage('allowed'), () => postMessage('blocked'));`;
    const nested = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    nested.onmessage = (event) => (event.data === 'allowed' ? resolve('nested fetch') : reject(new Error('nested fetch blocked')));
    nested.onerror = () => reject(new Error('nested worker blocked'));
  }));
  await settle('brokerHttp', () => tm.net.fetch(`${CANARY}/broker`));
  await settle('brokerRemote', () => tm.net.fetch('https://example.com/'));
  await settle('notifyWithoutPermission', () => tm.notify({ title: 'pwned' }));
  // Storage keys are keys inside this plugin's own JSON file, never paths;
  // the harness checks that nothing outside that file was written.
  await settle('storageTraversalKey', () => tm.storage.set('../../settings', { pluginStates: { hostile: { enabled: true } } }).then(() => 'stored as a key'));
  await settle('unknownOp', () => new Promise((resolve, reject) => {
    // A forged call straight to the host: main answers by sender, not payload.
    self.addEventListener('message', function onResult(event) {
      if (event.data?.type !== 'result' || event.data.id !== 999999) return;
      self.removeEventListener('message', onResult);
      if (event.data.ok) resolve('ok'); else reject(new Error(event.data.error));
    });
    self.postMessage({ type: 'call', id: 999999, op: 'credentials.read', args: {} });
  }));
  self.postMessage({ type: 'publish', metric: 'secret', value: 1 });
  self.postMessage({ type: 'subscribe', source: 'sys.cpu' });
  report.done = 'done';
  tm.publish('report', report);
}

let started = false;
tm.onTick(async () => {
  if (started) return;
  started = true;
  await probe();
});
