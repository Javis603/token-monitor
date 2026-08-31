'use strict';

function normalizeClientId(value) {
  return String(value || '').trim().toLowerCase();
}

function valuesOf(value) {
  const resolved = typeof value === 'function' ? value() : value;
  if (typeof resolved === 'string') return resolved.split(',');
  if (resolved && typeof resolved[Symbol.iterator] === 'function') return [...resolved];
  return [];
}

function clientSet(value) {
  return new Set(valuesOf(value).map(normalizeClientId).filter(Boolean));
}

function createClientSourceIpcHandlers(options = {}) {
  const knownClients = () => clientSet(options.knownClients);
  const trackedClients = () => clientSet(options.trackedClients);
  const visibleDiagnosticRoots = options.visibleDiagnosticRoots || (() => ({}));
  const clientDiagnosticRoots = options.clientDiagnosticRoots || (() => ({}));
  const canRunRescan = options.canRunRescan || (() => true);
  const revealFile = options.showItemInFolder || (() => {});
  const revealSyncLock = options.revealClientSyncLock || (() => false);
  const revealDirectory = options.openPath || (async () => 'unavailable');
  const rescan = options.rescanClient || (async () => false);
  const repairSyncLock = options.repairClientSyncLock || (async () => ({ ok: false, code: 'unavailable' }));

  function canInspectClient(clientId) {
    return knownClients().has(normalizeClientId(clientId));
  }

  function canRescanClient(clientId) {
    const client = normalizeClientId(clientId);
    return Boolean(client) && canInspectClient(client) && trackedClients().has(client);
  }

  function clientSources(clientId) {
    const client = normalizeClientId(clientId);
    if (!canInspectClient(client)) return null;
    try {
      const seen = new Set();
      const all = (visibleDiagnosticRoots(client)[client] || [])
        .filter((root) => {
          const key = `${root.id}\0${root.dir}`;
          return !seen.has(key) && seen.add(key);
        })
        .map((root) => ({ id: root.id, dir: root.dir, exists: root.exists === true }));
      const sources = all.slice(0, 32);
      return { sources, omittedCount: all.length - sources.length };
    } catch (_) {
      return null;
    }
  }

  async function revealClientSource(clientId) {
    const client = normalizeClientId(clientId);
    if (!canInspectClient(client)) return false;
    try {
      const roots = clientDiagnosticRoots(client)[client] || [];
      const target = roots.find((root) => root.exists);
      if (!target) return false;
      // An exact-file source would otherwise be handed to openPath, which opens
      // the file in whatever app claims .db/.jsonl. Select it in its folder
      // instead — the user asked where the data lives, not to open it.
      if (target.sourcePath) {
        revealFile(target.sourcePath);
        return true;
      }
      return await revealDirectory(target.dir) === '';
    } catch (_) {
      return false;
    }
  }

  function revealClientSyncLock(clientId) {
    const client = normalizeClientId(clientId);
    if (client !== 'antigravity' || !canInspectClient(client)) return false;
    try {
      return revealSyncLock(client) === true;
    } catch (_) {
      return false;
    }
  }

  async function rescanClient(clientId) {
    const client = normalizeClientId(clientId);
    if (!canRescanClient(client) || !canRunRescan()) return false;
    try {
      return await rescan(client) === true;
    } catch (error) {
      options.onRescanError?.(error);
      return false;
    }
  }

  async function repairClientSyncLock(clientId) {
    const client = normalizeClientId(clientId);
    if (client !== 'antigravity' || !canRescanClient(client) || !canRunRescan()) {
      return { ok: false, code: 'unavailable' };
    }
    try {
      const repairResult = await repairSyncLock(client);
      if (repairResult?.ok !== true) {
        const allowed = new Set(['owner-active', 'unsafe-lock', 'repair-failed']);
        return {
          ok: false,
          code: allowed.has(repairResult?.code) ? repairResult.code : 'repair-failed'
        };
      }
      const rescanned = await rescan(client) === true;
      if (rescanned) {
        return {
          ok: true,
          code: repairResult.code === 'not-found' ? 'rescanned' : 'repaired'
        };
      }
      return {
        ok: false,
        code: repairResult.code === 'repaired' ? 'repaired-rescan-failed' : 'rescan-failed'
      };
    } catch (error) {
      options.onRescanError?.(error);
      return { ok: false, code: 'repair-failed' };
    }
  }

  return {
    canInspectClient,
    canRescanClient,
    clientSources,
    repairClientSyncLock,
    revealClientSyncLock,
    revealClientSource,
    rescanClient
  };
}

module.exports = { createClientSourceIpcHandlers, normalizeClientId };
