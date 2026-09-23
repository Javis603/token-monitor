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

const RUNTIME_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const sampler = require(path.join(process.env.WORKBUDDY_APP_ASAR, 'main', 'process-cpu-sampler.js'));
sampler.init_dist();
const input = fs.readFileSync(0, 'utf8');
const wrapper = JSON.parse(input);
if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)
  || Object.keys(wrapper).length !== 2 || wrapper.$wbEncrypted !== 1
  || typeof wrapper.envelope !== 'string' || !wrapper.envelope) throw new Error('invalid wrapper');
const raw = process._linkedBinding('electron_browser_workbuddy_storage').loggerGet();
const capabilities = sampler.normalizeAtRestBuildKeyCapabilities(raw);
const keyValue = capabilities?.symmetric?.value;
if (!keyValue) throw new Error('key unavailable');
const envelope = sampler.parseSupportedEnvelope(Buffer.from(wrapper.envelope, 'base64'));
const crypto = new sampler.AtRestCrypto(keyValue);
let plain;
try {
  plain = crypto.open(envelope, { framing: 'field' });
  const token = Buffer.isBuffer(plain) ? plain.toString('utf8') : String(plain);
  if (!token || token.includes('\u0000') || token.includes('\r') || token.includes('\n')) throw new Error('invalid token');
  process.stdout.write(token);
} finally {
  try { crypto.dispose(); } catch (_) {}
  if (Buffer.isBuffer(plain)) plain.fill(0);
  if (Buffer.isBuffer(keyValue?.key)) keyValue.key.fill(0);
}
`;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
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
      encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore']
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
  return function decodeAccessToken(wrapper) {
    if (!isEncryptedAccessToken(wrapper)) return null;
    const input = JSON.stringify(wrapper);
    if (Buffer.byteLength(input, 'utf8') > (deps.maxInputBytes || MAX_INPUT_BYTES)) return null;
    const app = resolveWorkbuddyExecutable({ ...deps, fs: fsApi });
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
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', WORKBUDDY_APP_ASAR: app.asar }
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
