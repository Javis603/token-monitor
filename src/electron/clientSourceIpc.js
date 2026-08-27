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
  const revealDirectory = options.openPath || (async () => 'unavailable');
  const rescan = options.rescanClient || (async () => false);

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

  // Which known-but-untracked tools have data on this machine. Without it the
  // settings list shows an unchecked row and nothing else, so a tool the user
  // has been running for months looks exactly like one they never installed —
  // its tokens are simply absent from every total, with nothing on screen
  // saying so.
  //
  // Answered for the whole untracked set in one sweep rather than per row: the
  // roots table is keyed by client and takes a list, so asking once costs one
  // traversal instead of one per client. Returns ids only — the absolute paths
  // stay in this process, like every other answer in this module.
  function untrackedClientsWithData() {
    const tracked = trackedClients();
    const untracked = [...knownClients()].filter((client) => !tracked.has(client));
    if (!untracked.length) return [];
    try {
      const roots = visibleDiagnosticRoots(untracked.join(','));
      return untracked.filter((client) => (roots[client] || []).some((root) => root.exists === true));
    } catch (_) {
      return [];
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

  return {
    canInspectClient,
    canRescanClient,
    clientSources,
    untrackedClientsWithData,
    revealClientSource,
    rescanClient
  };
}

module.exports = { createClientSourceIpcHandlers, normalizeClientId };
