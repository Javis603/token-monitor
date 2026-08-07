'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function projectRoot() {
  return path.resolve(__dirname, '..', '..');
}

function sharedDataDir(options = {}) {
  const env = options.env || process.env;
  if (env.TOKEN_MONITOR_SHARED_DIR) return env.TOKEN_MONITOR_SHARED_DIR;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const productName = 'Routed Monitoring';
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', productName);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), productName);
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), productName);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const stripped = token.slice(2);
    if (!stripped) continue;
    const eqIndex = stripped.indexOf('=');
    if (eqIndex !== -1) {
      args[stripped.slice(0, eqIndex)] = stripped.slice(eqIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[stripped] = true;
    else {
      args[stripped] = next;
      index += 1;
    }
  }
  return args;
}

function readJson(filePath, fallback = null) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not read ${filePath}: ${error.message}`);
    return fallback;
  }
  if (!content.trim()) return fallback;
  try {
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Could not parse JSON in ${filePath}: ${error.message}`);
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function loadDotEnv() {
  require('dotenv').config({ path: path.join(projectRoot(), '.env'), quiet: true });
}

function defaultDeviceId() {
  return os.hostname().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
}

function pidFilePath() {
  return path.join(sharedDataDir(), 'agent.pid');
}

// Heuristics adapted from CrossPaste's AbstractNetworkInterfaceService — Node's
// os.networkInterfaces() lacks Java's isVirtual()/isUp() flags, so we fall
// back to name patterns + MAC OUI prefixes to detect virtualization /
// tunnel / VPN interfaces that should not be advertised as LAN addresses.
// Mirror CrossPaste's blacklist: vmnet, docker, veth, wsl, utun, bridge.
// `feth` is intentionally NOT here — macOS uses it for legitimate bridges
// like ZeroTier (10.147.x.x) and Internet Sharing.
// Windows friendly names need extra patterns since Node can't read Java's
// isVirtual() flag.
const VIRTUAL_NAME_PATTERNS = [
  /^vmnet/i, /^docker/i, /^veth/i, /^wsl/i, /^utun/i, /^bridge/i,
  /^vboxnet/i, /^virbr/i, /^br-/i,
  /vEthernet/i, /VMware/i, /VirtualBox/i, /Hyper-V/i, /WSL/i, /Loopback Pseudo/i
];

const VIRTUAL_MAC_PREFIXES = [
  '00:50:56', '00:0c:29', '00:05:69', // VMware
  '00:1c:14', '00:1c:42',             // Parallels
  '08:00:27',                         // VirtualBox
  '52:54:00',                         // QEMU / KVM
  '00:15:5d',                         // Hyper-V / WSL
  '02:42'                             // Docker (prefix matches 02:42:xx:xx:xx:xx)
];

function isVirtualInterfaceName(name) {
  return VIRTUAL_NAME_PATTERNS.some((re) => re.test(name));
}

function isVirtualMac(mac) {
  const m = String(mac || '').toLowerCase();
  if (!m) return false;
  return VIRTUAL_MAC_PREFIXES.some((prefix) => m.startsWith(prefix));
}

function isReservedIpv4(address) {
  if (typeof address !== 'string') return false;
  const last = address.split('.').pop();
  // Reject network (.0) and broadcast (.255). Keep .1 — many self-hosted
  // setups legitimately use it (e.g., the device IS the router).
  return last === '0' || last === '255';
}

function lanIpv4Addresses() {
  const out = [];
  const seen = new Set();
  let nets;
  try { nets = os.networkInterfaces(); } catch (_) { return out; }
  for (const [name, addrs] of Object.entries(nets || {})) {
    if (isVirtualInterfaceName(name)) continue;
    for (const addr of addrs || []) {
      if (!addr || addr.family !== 'IPv4' || addr.internal) continue;
      if (isReservedIpv4(addr.address)) continue;
      if (isVirtualMac(addr.mac)) continue;
      if (seen.has(addr.address)) continue;
      seen.add(addr.address);
      out.push({ address: addr.address, interface: name });
    }
  }
  return out;
}

function generateHubSecret() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = {
  defaultDeviceId,
  generateHubSecret,
  lanIpv4Addresses,
  loadDotEnv,
  parseArgs,
  pidFilePath,
  projectRoot,
  readJson,
  sharedDataDir,
  writeJsonAtomic
};
