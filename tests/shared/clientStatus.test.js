'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { statusFromSignals, deriveClientStatus, clientDataDirPresence } = require('../../src/shared/collector');
const { normalizeDeviceRecord, aggregateDevices } = require('../../src/shared/usage');

test('statusFromSignals maps the three states from existing signals', () => {
  const status = statusFromSignals(
    ['claude', 'codex', 'cursor'],
    { claude: true, codex: true, cursor: false },
    { claude: 1200, cursor: 0 }
  );
  assert.deepEqual(status, { claude: 'active', codex: 'waiting', cursor: 'missing' });
});

test('statusFromSignals prefers active even when the directory is gone', () => {
  // tokscale read usage from an archive even though the live dir vanished.
  const status = statusFromSignals(['claude'], { claude: false }, { claude: 50 });
  assert.deepEqual(status, { claude: 'active' });
});

test('clientDataDirPresence reflects whether a data directory exists', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'client-status-'));
  const present = path.join(base, 'hermes-home');
  fs.mkdirSync(present);
  const prevHome = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = present;
    assert.equal(clientDataDirPresence('hermes').hermes, true);
    process.env.HERMES_HOME = path.join(base, 'does-not-exist');
    assert.equal(clientDataDirPresence('hermes').hermes, false);
  } finally {
    if (prevHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prevHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('clientDataDirPresence detects Cline VS Code task storage', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'client-status-cline-'));
  const clineTasks = path.join(base, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
  const clineServerTasks = path.join(base, '.vscode-server', 'data', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
  const originalHome = os.homedir;
  try {
    os.homedir = () => base;
    assert.equal(clientDataDirPresence('cline').cline, false);
    fs.mkdirSync(clineTasks, { recursive: true });
    assert.equal(clientDataDirPresence('cline').cline, true);
    fs.rmSync(clineTasks, { recursive: true, force: true });
    fs.mkdirSync(clineServerTasks, { recursive: true });
    assert.equal(clientDataDirPresence('cline').cline, true);
  } finally {
    os.homedir = originalHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deriveClientStatus reads dir presence and usage together', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'client-status-'));
  const present = path.join(base, 'hermes-home');
  fs.mkdirSync(present);
  const prevHome = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = present;
    assert.deepEqual(deriveClientStatus('hermes', { clients: { hermes: 999 } }), { hermes: 'active' });
    assert.deepEqual(deriveClientStatus('hermes', { clients: {} }), { hermes: 'waiting' });
    process.env.HERMES_HOME = path.join(base, 'gone');
    assert.deepEqual(deriveClientStatus('hermes', { clients: {} }), { hermes: 'missing' });
  } finally {
    if (prevHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prevHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('clientDataDirPresence detects Antigravity via the CLI conversations dir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'client-status-agy-'));
  const cliDir = path.join(base, '.gemini', 'antigravity-cli', 'conversations');
  const originalHome = os.homedir;
  const prevGeminiHome = process.env.GEMINI_CLI_HOME;
  try {
    delete process.env.GEMINI_CLI_HOME;
    os.homedir = () => base;
    assert.equal(clientDataDirPresence('antigravity').antigravity, false);
    fs.mkdirSync(cliDir, { recursive: true });
    assert.equal(clientDataDirPresence('antigravity').antigravity, true);
    // CLI-only home, no countable usage yet: must read waiting, not missing.
    assert.deepEqual(deriveClientStatus('antigravity', { clients: {} }), { antigravity: 'waiting' });
  } finally {
    os.homedir = originalHome;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = prevGeminiHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('normalizeDeviceRecord keeps valid clientStatus and drops junk', () => {
  const normalized = normalizeDeviceRecord({
    deviceId: 'mac',
    clientStatus: { Claude: 'active', codex: 'waiting', cursor: 'bogus', '': 'missing' }
  });
  assert.deepEqual(normalized.clientStatus, { claude: 'active', codex: 'waiting' });
});

test('aggregateDevices exposes clientStatus on each device entry', () => {
  const stats = aggregateDevices([
    { deviceId: 'mac', clientStatus: { claude: 'active' } }
  ], 0);
  assert.deepEqual(stats.devices[0].clientStatus, { claude: 'active' });
});

test('aggregateDevices omits clientStatus when the record has none', () => {
  const stats = aggregateDevices([{ deviceId: 'mac' }], 0);
  assert.equal(Object.prototype.hasOwnProperty.call(stats.devices[0], 'clientStatus'), false);
});

test('normalizeDeviceRecord keeps valid wslStatus and normalizes ids', () => {
  const normalized = normalizeDeviceRecord({
    deviceId: 'win',
    wslStatus: { state: 'active', detected: ['Codex', 'hermes', ''], withData: ['codex'] }
  });
  assert.deepEqual(normalized.wslStatus, { state: 'active', detected: ['codex', 'hermes'], withData: ['codex'] });
});

test('normalizeDeviceRecord drops wslStatus with an unknown state', () => {
  const normalized = normalizeDeviceRecord({ deviceId: 'win', wslStatus: { state: 'bogus', detected: ['codex'] } });
  assert.equal(normalized.wslStatus, null);
});

test('aggregateDevices exposes wslStatus on each device entry', () => {
  const stats = aggregateDevices([
    { deviceId: 'win', wslStatus: { state: 'no-data', detected: ['hermes'], withData: [] } }
  ], 0);
  assert.deepEqual(stats.devices[0].wslStatus, { state: 'no-data', detected: ['hermes'], withData: [] });
});

test('aggregateDevices omits wslStatus when the record has none', () => {
  const stats = aggregateDevices([{ deviceId: 'win' }], 0);
  assert.equal(Object.prototype.hasOwnProperty.call(stats.devices[0], 'wslStatus'), false);
});
