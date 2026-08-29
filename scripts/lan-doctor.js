#!/usr/bin/env node
'use strict';

// Answers "why does the Android app show no devices?".
//
// The two causes look identical on a phone — an empty list — and need
// completely different fixes, so this asks the gateway directly and tells them
// apart:
//
//   1. the phone cannot reach the gateway (network / firewall / wrong port)
//   2. the gateway is reachable and simply has nothing to show (no device has
//      been pointed at it yet)
//
// Cause 2 is the common one and is not a fault: a gateway aggregates, it does
// not measure its own machine.
//
//   node scripts/lan-doctor.js [viewPlaneUrl]
//   node scripts/lan-doctor.js http://192.168.1.5:17322 --data-secret=<secret>
//
// The second form also checks the DATA plane, which is the one a PC must be
// configured with. Worth doing before blaming the phone: a PC pointed at the
// view plane fails to post forever, so the device list stays empty and the
// gateway looks broken when only the URL is wrong.

const { defaultAddresses } = require('../src/shared/mdns');
const { DEFAULT_DATA_PORT, DEFAULT_VIEW_PORT } = require('../src/gateway/server');

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const url = String(positional[0] || 'http://127.0.0.1:17322').replace(/\/$/, '');

function flag(name) {
  const match = argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : '';
}
const dataSecret = flag('data-secret');
const dataPort = Number(flag('data-port') || 17321);

function hostOf(value) {
  try { return new URL(value).hostname; } catch (_) { return ''; }
}

async function getJson(path, options) {
  const response = await fetch(url + path, options);
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, status: response.status, body: await response.json() };
}

async function main() {
  console.log(`Gateway view plane: ${url}\n`);

  let health;
  let stats;
  try {
    health = await getJson('/api/health');
    stats = await getJson('/api/view/stats');
  } catch (error) {
    console.log(`UNREACHABLE: ${error.message}\n`);
    console.log('  The gateway is not answering at all from this machine.');
    console.log('  Check, in order:');
    console.log('    1. Is it running?      npm run gateway -- --secret <secret>');
    console.log('    2. Right port?         the VIEW plane is 17322, the DATA plane 17321');
    console.log('    3. Same network?       the phone must be on the same Wi-Fi');
    console.log('    4. Windows Firewall    blocks inbound by default; see docs/lan-gateway.md');
    process.exit(1);
  }

  if (health.status === 401 || stats.status === 401) {
    console.log('WRONG PORT: this answered 401 (needs a secret).');
    console.log('  That is the DATA plane. The Android app must use the VIEW');
    console.log('  plane (17322 by default), which needs no secret.');
    process.exit(1);
  }

  if (!stats.ok) {
    console.log(`BAD RESPONSE: HTTP ${stats.status}`);
    process.exit(1);
  }

  const devices = stats.body.devices || [];
  const count = stats.body.deviceCount ?? devices.length;

  console.log('Gateway reachable : yes');
  console.log(`Devices reporting : ${count}`);

  if (count === 0) {
    console.log('\n  The gateway is working. Nothing has reported to it yet.\n');
    console.log('  A gateway does NOT measure the machine it runs on. It only');
    console.log('  aggregates whatever connects to it. An empty list means no');
    console.log('  device has been pointed at it yet — not a fault.\n');
    console.log('  To add this PC, in the Token Monitor widget:\n');
    console.log('    Settings -> Multi-device Sync -> Connect to a hub');
    const lan = defaultAddresses();
    const host = lan[0] || '<this-machine-ip>';
    console.log(`    URL    : http://${host}:17321      <- DATA plane, not 17322`);
    console.log('    Secret : the one the gateway was started with\n');
    console.log('  Note the 17321. Pointing the widget at 17322 fails twice:');
    console.log('  POST /api/ingest answers 404 there, and the snapshot it does');
    console.log('  serve is scrubbed of the diagnostics the widget needs.\n');
    console.log('  For a machine with no widget:');
    console.log('    TOKEN_MONITOR_HUB_URL=http://<gateway-ip>:17321 \\');
    console.log('    TOKEN_MONITOR_SECRET=<secret> npm run agent');
    // Checked on the empty case too — in fact especially there. "No devices"
    // is the symptom that brings someone here, and the whole point of the
    // data-plane check is to say whether the PC configuration would fix it.
    await checkDataPlane();
    process.exit(0);
  }

  console.log('\n  Devices:');
  for (const device of devices) {
    const today = device.periods?.today?.totalTokens ?? 0;
    console.log(`    - ${device.displayName ?? device.hostname ?? device.deviceId}` +
      `  (${device.platform ?? 'unknown'})  today: ${today} tokens  ${device.stale ? 'STALE' : 'live'}`);
  }
  console.log('\n  The gateway has data. If the phone still shows nothing, the');
  console.log('  problem is between the phone and the gateway — network or port.');
  await checkDataPlane();
}

// Optional, and the check that matters when a PC is being pointed at the
// gateway: the view plane answering says nothing about whether the URL and
// secret a PC was given actually work, because ingest lives on the other port.
async function checkDataPlane() {
  if (!dataSecret) return;
  const host = hostOf(url);
  if (!host) return;
  const base = `http://${host}:${dataPort}`;
  console.log(`\n  Data plane check (${base}):`);
  try {
    const response = await fetch(`${base}/api/stats`, {
      headers: { authorization: `Bearer ${dataSecret}` }
    });
    if (response.status === 401) {
      console.log('    401 — the port is right but the SECRET IS WRONG.');
      return;
    }
    if (response.status === 404) {
      // Not a port that is down but one that is up and refusing this route —
      // which is precisely what the view plane does to every data-plane path.
      // This is the exact state a PC lands in when its URL ends in 17322: it
      // posts forever and the device list stays empty, with only a 404 to show.
      // Quotes the gateway's own default rather than the `--data-port` that was
      // passed in: when that flag is what pointed at the view plane, echoing it
      // back as the fix would tell the user to change nothing.
      console.log(`    404 — that port is up but has no /api/stats: it is the VIEW plane.`);
      console.log(`    A PC must use the DATA plane instead (default ${DEFAULT_DATA_PORT}, not ${DEFAULT_VIEW_PORT}).`);
      console.log('    Change the URL in Settings -> Multi-device Sync and it will reconnect.');
      return;
    }
    if (!response.ok) {
      console.log(`    HTTP ${response.status} — is this the data plane?`);
      return;
    }
    const payload = await response.json();
    const diagnostics = payload.devices?.some((device) => device.clientHealth);
    console.log(`    200 — URL and secret are correct. Devices: ${payload.devices?.length ?? 0}`);
    console.log(`    clientHealth present: ${diagnostics ? 'yes' : 'no'}` +
      '  (must be yes: the view plane strips it, so a PC reading it from there is misconfigured)');
  } catch (error) {
    console.log(`    UNREACHABLE — ${error.message}`);
    console.log(`    ECONNREFUSED means nothing is listening on ${dataPort}: the gateway is not running.`);
    console.log('    ETIMEDOUT would mean the firewall is dropping the connection instead.');
  }
}

main().catch((error) => {
  console.error(`doctor failed: ${error.message}`);
  process.exit(1);
});
