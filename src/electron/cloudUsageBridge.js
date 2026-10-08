'use strict';

// A main-process bridge to the one existing cloud observer. Never merges its
// lifetime counters into Tokscale periods, device ingest, costs or public stats.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { normalizeUsage } = require('../shared/providers/codex/taskUsage');
const LABEL = 'local.chengong.tokenmonitor.cloudauto';
const MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['starting', 'listening', 'reconnecting', 'stopped', 'error', 'blocked', 'connecting']);
const id = (v) => typeof v === 'string' && UUID.test(v) ? v : null;
const number = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const stamp = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const enumValue = (v, allowed, fallback = 'unknown') => allowed.includes(v) ? v : fallback;
const millisStamp = (v) => Number.isSafeInteger(v) && v > 0 && v <= 8640000000000000 ? new Date(v).toISOString() : null;
function fault(code) { return Object.assign(new Error(code), { code }); }
function safeError(e) { return /^[A-Z_]{1,60}$/.test(e?.code || '') ? e.code : 'CLOUD_SERVICE_UNAVAILABLE'; }
function readJson(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw fault('INVALID_CLOUD_REPORT');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES || (process.getuid && before.uid !== process.getuid())) throw fault('INVALID_CLOUD_REPORT');
    const buffer = Buffer.alloc(Math.min(before.size + 1, MAX_BYTES + 1));
    let n = 0;
    while (n < buffer.length) { const size = fs.readSync(fd, buffer, n, buffer.length - n, null); if (!size) break; n += size; }
    const after = fs.fstatSync(fd);
    if (n !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fault('CLOUD_REPORT_CHANGED');
    return JSON.parse(buffer.subarray(0, n).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function unavailable(code, service = {}) {
  return { version: 1, state: 'unavailable', errorCode: code, service, observedAt: null, lastDiscoveryAt: null,
    ageSeconds: null, stale: true, knownThreads: null, listeningThreads: null, measuredThreads: null,
    waitingForSlot: null, threads: [], taskTotalTokens: null, canCombineWithLocal: false, accountCloudCoverage: 'unknown' };
}
function projectReport(raw, { scopeFingerprint, now = Date.now(), service = {}, previous = null } = {}) {
  if (!raw || raw.version !== 1 || raw.kind !== 'codex-cloud-auto-watch' || !Array.isArray(raw.threads) || raw.threads.length > 5000) return unavailable('INVALID_CLOUD_REPORT', service);
  if (!scopeFingerprint || raw.scopeFingerprint !== scopeFingerprint) return unavailable('CLOUD_ACCOUNT_MISMATCH', service);
  const observedAt = stamp(raw.observedAt), lastDiscoveryAt = stamp(raw.lastDiscoveryAt);
  if (!observedAt || Date.parse(observedAt) > now + 300000) return unavailable('INVALID_CLOUD_REPORT_TIME', service);
  const ageSeconds = Math.max(0, Math.floor((now - Date.parse(observedAt)) / 1000));
  const stale = ageSeconds > 30 || service.running !== true || raw.state !== 'listening';
  // Installation can restart the observer. Retain only exact-thread,
  // same-account measured snapshots from the explicitly backed-up prior run.
  // This is last-known display, never an additive cross-run ledger.
  const prior = new Map();
  if (previous?.version === 1 && previous.kind === raw.kind && previous.scopeFingerprint === scopeFingerprint
      && previous.runId && raw.runId && previous.runId !== raw.runId && Array.isArray(previous.threads)
      && previous.threads.length <= 5000 && stamp(previous.observedAt) && Date.parse(previous.observedAt) <= Date.parse(observedAt)) {
    for (const row of previous.threads) {
      if (id(row?.threadId) && row.status === 'observed' && !row.problem && normalizeUsage(row.total) && stamp(row.observedAt)) prior.set(row.threadId, row);
    }
  }
  const rows = [], seen = new Set();
  for (const t of raw.threads) {
    if (!t || !id(t.threadId) || seen.has(t.threadId)) return unavailable('INVALID_CLOUD_THREAD', service);
    seen.add(t.threadId);
    const retained = t.total == null && t.status === 'no-usage-notification' && !t.problem ? prior.get(t.threadId) : null;
    const total = retained ? normalizeUsage(retained.total) : t.total == null ? null : normalizeUsage(t.total);
    const invalid = t.total != null && !total;
    const ambiguous = t.status === 'ambiguous' || Boolean(t.problem);
    rows.push({ threadId: t.threadId,
      createdAt: millisStamp(t.createdMs), lastActivityAt: millisStamp(t.updatedMs),
      kind: enumValue(t.kind, ['user', 'aeon', 'aeon_child', 'subagent', 'dreaming', 'unknown']),
      engineParentId: id(t.engineParentId), delegationParentId: id(t.delegationParentId),
      parentUnknown: t.parentConflict === true || [t.engineParentId, t.delegationParentId].some((v) => v != null && v !== '' && !id(v)),
      runtimeStatus: enumValue(t.runtimeStatus, ['active', 'idle', 'notLoaded', 'systemError', 'unknown']),
      listening: !stale && t.listening === true,
      status: invalid || ambiguous ? 'ambiguous' : retained ? 'observed' : enumValue(t.status, ['observed', 'no-usage-notification', 'ambiguous']),
      total: invalid || ambiguous ? null : total, observedAt: stamp(retained?.observedAt || t.observedAt), retainedFromPriorRun: Boolean(retained),
      gapCount: number(t.gapCount), receivedEvents: number(t.receivedEvents), archived: t.archived === true });
  }
  return { version: 1, state: stale && raw.state === 'listening' ? 'stale' : STATES.has(raw.state) ? raw.state : 'unknown',
    service, stale, ageSeconds, observedAt, lastDiscoveryAt, errorCode: null,
    knownThreads: rows.length, listeningThreads: rows.filter((r) => r.listening).length,
    measuredThreads: rows.filter((r) => r.total !== null).length, waitingForSlot: number(raw.waitingForSlot),
    scans: number(raw.scans), connections: number(raw.connectionNumber),
    discoveryComplete: raw.discoveryComplete === true,
    threads: rows.sort((a, b) => Number(b.listening) - Number(a.listening) || Number(b.total !== null) - Number(a.total !== null) || (b.total?.totalTokens || 0) - (a.total?.totalTokens || 0) || a.threadId.localeCompare(b.threadId)),
    taskTotalTokens: null, canCombineWithLocal: false, accountCloudCoverage: 'unknown' };
}
function createCloudUsageBridge(options = {}) {
  const home = options.home || os.homedir(), platform = options.platform || process.platform;
  const data = path.join(home, 'Library/Application Support/Token Monitor Usage Test/auto-cloud');
  const plist = path.join(home, 'Library/LaunchAgents', LABEL + '.plist');
  const domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`;
  const execute = options.execute || promisify(execFile);
  const scope = options.getScope || (() => {
    const { loadCredential } = require('../shared/providers/codex/cloudTransport');
    return loadCredential(path.resolve(process.env.CODEX_HOME || path.join(home, '.codex'))).scopeFingerprint;
  });
  const read = options.readReport || (() => readJson(path.join(data, 'report.json')));
  const readPrevious = options.readPrevious || (() => { try { return readJson(path.join(data, 'native-previous-report.json')); } catch (_) { return null; } });
  let serviceCache = null, serviceAt = 0, statusPending = null, controlPending = false;
  async function inspectService(force = false) {
    if (platform !== 'darwin') return { installed: false, running: false, supported: false, canControl: false };
    if (!force && serviceCache && Date.now() - serviceAt < 5000) return serviceCache;
    if (statusPending) return statusPending;
    statusPending = (async () => {
      let installed = false;
      try { const s = fs.lstatSync(plist); installed = s.isFile() && !s.isSymbolicLink() && (!process.getuid || s.uid === process.getuid()); } catch (_) {}
      let running = false, pid = null;
      try {
        const result = await execute('/bin/launchctl', ['print', `${domain}/${LABEL}`], { timeout: 3000, maxBuffer: 65536 });
        running = /^\s*state = running\s*$/m.test(result.stdout);
        const m = /^\s*pid = (\d+)\s*$/m.exec(result.stdout); pid = m ? Number(m[1]) : null;
      } catch (_) { /* Unloaded service is distinct from a live report. */ }
      serviceAt = Date.now();
      serviceCache = { installed, running, supported: true, canControl: installed, pid };
      return serviceCache;
    })();
    try { return await statusPending; } finally { statusPending = null; }
  }
  async function get() {
    const service = await inspectService();
    try { const fingerprint = scope(); const raw = read(); if (fingerprint !== scope()) return unavailable('CLOUD_ACCOUNT_CHANGED', service);
      return projectReport(raw, { scopeFingerprint: fingerprint, service, previous: readPrevious() });
    } catch (e) { return unavailable(e.code === 'ENOENT' ? 'CLOUD_REPORT_NOT_READY' : safeError(e), service); }
  }
  async function control(action) {
    if (!['start', 'stop'].includes(action)) throw fault('INVALID_CLOUD_ACTION');
    if (controlPending) throw fault('CLOUD_CONTROL_BUSY');
    controlPending = true;
    try {
      const current = await inspectService(true);
      if (!current.canControl) throw fault('CLOUD_SERVICE_NOT_INSTALLED');
      const run = (args) => execute('/bin/launchctl', args, { timeout: 5000, maxBuffer: 65536 });
      if (action === 'stop') {
        await run(['disable', `${domain}/${LABEL}`]);
        try { await run(['bootout', `${domain}/${LABEL}`]); } catch (_) { if ((await inspectService(true)).running) throw fault('CLOUD_SERVICE_STOP_FAILED'); }
      } else {
        await run(['enable', `${domain}/${LABEL}`]);
        if (!current.running) {
          try { await run(['bootstrap', domain, plist]); } catch (_) { /* kickstart below supplies the definitive result. */ }
          await run(['kickstart', `${domain}/${LABEL}`]);
        }
      }
      await inspectService(true);
      return { ok: true, action, snapshot: await get() };
    } catch (e) { throw fault(safeError(e)); }
    finally { controlPending = false; serviceAt = 0; }
  }
  return { get, control };
}
function trustedSender(event, windows, rendererDir) {
  const owner = windows.find((w) => w && !w.isDestroyed() && w.webContents === event.sender);
  if (!owner || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url); if (url.protocol !== 'file:') return false;
    return ['index.html', 'dashboard.html'].some((name) => fileURLToPath(url) === path.join(rendererDir, name));
  } catch (_) { return false; }
}
function registerCloudUsageIpc({ ipcMain, getWindows, rendererDir, open, bridge = createCloudUsageBridge() }) {
  const allowed = (event) => { if (!trustedSender(event, getWindows(), rendererDir)) throw fault('UNTRUSTED_CLOUD_SENDER'); };
  ipcMain.handle('cloudUsage:get', (event) => { allowed(event); return bridge.get(); });
  ipcMain.handle('cloudUsage:control', (event, action) => { allowed(event); return bridge.control(action); });
  ipcMain.handle('cloudUsage:open', (event) => { allowed(event); open(); return { ok: true }; });
}
module.exports = { createCloudUsageBridge, projectReport, trustedSender, registerCloudUsageIpc, readJson, LABEL };
