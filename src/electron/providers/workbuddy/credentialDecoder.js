'use strict';

const fs = require('node:fs');
const physicalFs = (() => {
  try { return require('original-fs'); } catch (_) { return fs; }
})();
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const winPath = path.win32;

const WORKBUDDY_EXE_NAME = 'WorkBuddy.exe';
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REGISTRY_OUTPUT_BYTES = 4 * 1024 * 1024;
const EXECUTABLE_CACHE_MS = 60 * 1000;
const MISSING_EXECUTABLE_CACHE_MS = 30 * 1000;
const RUNTIME_ENV_KEYS = new Set([
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP'
]);

const RUNTIME_SCRIPT = String.raw`
const fs = require('node:fs');
const { createHash, createDecipheriv } = require('node:crypto');
// WorkBuddy's sym-v1/suite-1 field format is independent of its bundler's
// export names and lazy initializers (changed in 5.7.6). Use the original
// runtime's native key capability; support only the schema verified in its codec.
function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
function canonicalBase64(value, bytes) {
  if (typeof value !== 'string') throw new Error('unsupported encoding');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value || (bytes !== undefined && buffer.length !== bytes)) {
    buffer.fill(0);
    throw new Error('unsupported encoding');
  }
  return buffer;
}
function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}
function framedText(value) {
  const buffer = Buffer.from(value, 'utf8');
  return Buffer.concat([uint32(buffer.length), buffer]);
}
const input = fs.readFileSync(0, 'utf8');
if (Buffer.byteLength(input, 'utf8') > 16 * 1024) throw new Error('input too large');
const wrapper = JSON.parse(input);
if (!exactFields(wrapper, ['$wbEncrypted', 'envelope']) || wrapper.$wbEncrypted !== 1
  || typeof wrapper.envelope !== 'string' || !wrapper.envelope) throw new Error('invalid wrapper');
let secretBytes, key, plain;
try {
  const envelope = JSON.parse(canonicalBase64(wrapper.envelope).toString('utf8'));
  if (!exactFields(envelope, ['suite', 'keyId', 'nonce', 'authTag', 'ciphertext'])
    || envelope.suite !== 1 || typeof envelope.keyId !== 'string'
    || !/^[0-9a-f]{16}$/.test(envelope.keyId)) throw new Error('unsupported envelope');
  const nonce = canonicalBase64(envelope.nonce, 12);
  const authTag = canonicalBase64(envelope.authTag, 16);
  const ciphertext = canonicalBase64(envelope.ciphertext);
  const payload = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.version !== 1
    || Object.keys(payload).some(key => !['version', 'atRestSecretKey', 'atRestDeveloperPublicKey'].includes(key))) {
    throw new Error('unsupported key capability');
  }
  secretBytes = canonicalBase64(payload.atRestSecretKey, 32);
  if (secretBytes.every(byte => byte === 0)) throw new Error('key unavailable');
  // The original codec hashes the canonical base64 TEXT, not the decoded bytes.
  key = createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  if (keyId !== envelope.keyId) throw new Error('key mismatch');
  const aad = Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
    framedText('WBEV1'), framedText('sym-v1'), uint32(1), framedText(keyId),
    Buffer.from([2, 0, 0]) // field framing, absent sequence, absent final flag
  ]);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  const pending = decipher.update(ciphertext);
  try {
    plain = Buffer.concat([pending, decipher.final()]);
  } finally {
    pending.fill(0);
  }
  const token = plain.toString('utf8');
  if (!token || !Buffer.from(token, 'utf8').equals(plain) || /[\u0000\r\n]/.test(token)) throw new Error('invalid token');
  process.stdout.write(token);
} finally {
  if (Buffer.isBuffer(plain)) plain.fill(0);
  if (Buffer.isBuffer(key)) key.fill(0);
  if (Buffer.isBuffer(secretBytes)) secretBytes.fill(0);
}
`;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function runtimeEnvironment() {
  // The native storage capability needs the Windows/user profile paths, but
  // the short-lived decoder must not inherit unrelated provider credentials.
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (RUNTIME_ENV_KEYS.has(name.toUpperCase())) env[name] = value;
  }
  return { ...env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' };
}

function isEncryptedAccessToken(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.$wbEncrypted === 1
    && typeof value.envelope === 'string'
    && Object.keys(value).length === 2;
}

function safeCandidate(candidate, fsApi) {
  const exe = cleanText(candidate);
  if (!exe || winPath.basename(exe).toLowerCase() !== WORKBUDDY_EXE_NAME.toLowerCase()) return null;
  let exeStat;
  try { exeStat = fsApi.lstatSync(exe); } catch (_) { return null; }
  if (!exeStat.isFile() || exeStat.isSymbolicLink()) return null;
  const asar = winPath.join(winPath.dirname(exe), 'resources', 'app.asar');
  let asarStat;
  try { asarStat = fsApi.lstatSync(asar); } catch (_) { return null; }
  if (!asarStat.isFile() || asarStat.isSymbolicLink()) return null;
  return { exe, asar };
}

function resolveWorkbuddyExecutable(deps = {}) {
  const fsApi = deps.fs || physicalFs;
  if ((deps.platform || process.platform) !== 'win32') return null;
  if (typeof deps.resolveExecutable === 'function') return deps.resolveExecutable() || null;
  const candidates = [];
  if (cleanText(process.env.LOCALAPPDATA)) {
    candidates.push(winPath.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy', WORKBUDDY_EXE_NAME));
    candidates.push(winPath.join(process.env.LOCALAPPDATA, 'WorkBuddy', WORKBUDDY_EXE_NAME));
  }
  for (const candidate of candidates) {
    const found = safeCandidate(candidate, fsApi);
    if (found) return found;
  }
  const reg = deps.regExecFileSync || execFileSync;
  const roots = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  for (const root of roots) {
    try {
      const output = String(reg('reg.exe', ['query', root, '/s'], {
      encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: MAX_REGISTRY_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'ignore']
      }) || '');
      let record = {};
      const flush = () => {
        if (!/^WorkBuddy(?:\s|$)/i.test(record.DisplayName || '')) return null;
        const icon = cleanText(record.DisplayIcon)
          .replace(/,\s*\d+\s*$/, '')
          .replace(/^"(.*)"$/, '$1')
          .replace(/,\s*\d+\s*$/, '');
        const uninstall = cleanText(record.UninstallString).replace(/^"([^"]+)".*$/, '$1');
        const paths = [icon, record.InstallLocation && winPath.join(record.InstallLocation, WORKBUDDY_EXE_NAME),
          uninstall && winPath.join(winPath.dirname(uninstall), WORKBUDDY_EXE_NAME)];
        return paths.map((candidate) => safeCandidate(candidate, fsApi)).find(Boolean) || null;
      };
      for (const line of output.split(/\r?\n/)) {
        if (/^HKEY_/i.test(line.trim())) {
          const found = flush();
          if (found) return found;
          record = {};
          continue;
        }
        const match = line.match(/^\s+(DisplayName|DisplayIcon|InstallLocation|UninstallString)\s+REG_SZ\s+(.*)$/i);
        if (match) record[match[1]] = match[2].trim();
      }
      const found = flush();
      if (found) return found;
    } catch (_) {}
  }
  return null;
}

function createWorkbuddyCredentialDecoder(deps = {}) {
  const fsApi = deps.fs || physicalFs;
  const exec = deps.execFileSync || execFileSync;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(250, deps.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const now = deps.now || Date.now;
  // Cache installation discovery only, never a token or native key. Even a
  // cached installation must still consist of safe regular files on each use.
  let cachedApp = null;
  let discoveryExpiresAt = 0;
  function resolveApp() {
    if (typeof deps.resolveExecutable === 'function') return resolveWorkbuddyExecutable(deps);
    const at = now();
    if (at < discoveryExpiresAt) {
      if (!cachedApp) return null;
      const current = safeCandidate(cachedApp.exe, fsApi);
      if (current) return current;
    }
    cachedApp = resolveWorkbuddyExecutable({ ...deps, fs: fsApi });
    discoveryExpiresAt = at + (cachedApp ? EXECUTABLE_CACHE_MS : MISSING_EXECUTABLE_CACHE_MS);
    return cachedApp;
  }
  return function decodeAccessToken(wrapper) {
    if (!isEncryptedAccessToken(wrapper)) return null;
    const input = JSON.stringify(wrapper);
    if (Buffer.byteLength(input, 'utf8') > (deps.maxInputBytes || MAX_INPUT_BYTES)) return null;
    const app = resolveApp();
    if (!app) return null;
    try {
      const output = exec(app.exe, ['-e', RUNTIME_SCRIPT], {
        input,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: runtimeEnvironment()
      });
      const rawOutput = typeof output === 'string' ? output : String(output || '');
      if (rawOutput.includes('\r') || rawOutput.includes('\n') || rawOutput.includes('\0')) return null;
      const token = cleanText(rawOutput);
      return token && token.length <= MAX_OUTPUT_BYTES ? token : null;
    } catch (_) {
      return null;
    }
  };
}

module.exports = {
  MAX_INPUT_BYTES,
  RUNTIME_SCRIPT,
  createWorkbuddyCredentialDecoder,
  isEncryptedAccessToken,
  resolveWorkbuddyExecutable
};
