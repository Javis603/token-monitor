'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CredentialStore } = require('../shared/credentialStore');
const { createSessionTitleSyncNegotiator } = require('../shared/syncContent');

const disabled = () => ({ syncSessionTitles: false });
const same = (a, b) => a && b && a.hubUrl === b.hubUrl && a.deviceId === b.deviceId
  && a.headers.authorization === b.headers.authorization;
const sameTarget = (a, b) => a.hubUrl === b.hubUrl && a.deviceId === b.deviceId;

function destination({ hubUrl, deviceId, headers = {} }) {
  const url = new URL(hubUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || typeof deviceId !== 'string' || !deviceId) throw new Error('invalid_destination');
  if (headers.authorization !== undefined && typeof headers.authorization !== 'string') throw new Error('invalid_destination');
  return { hubUrl: url.href.replace(/\/$/, ''), deviceId,
    headers: headers.authorization ? { authorization: headers.authorization } : {} };
}

function validPolicy(value, enabled) {
  return value?.ok === true && value.enabled === enabled && Number.isSafeInteger(value.generation) && value.generation > 0;
}

// Unlike desktop preferences, CLI/env consent is a fresh declaration per launch.
// Persist only the private cleanup responsibility, before any remote admission.
function createAgentTitleSync({ dataDir, fetchFn, logger = console, timeoutMs = 5000,
  store = new CredentialStore(dataDir, { filePath: path.join(dataDir, 'agent-sync-credentials.json') }),
  fsApi = fs, isAlive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  }, now, refreshMs } = {}) {
  let lane = Promise.resolve();
  let epoch = 0;
  let requested = null;
  let requestedEnabled = false;
  let operation;
  let cachedAdmissionId;

  function acquire() {
    const directory = `${store.filePath}.locks`;
    fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ownPath = path.join(directory, `${process.pid}-${crypto.randomUUID()}.json`);
    let descriptor;
    try {
      descriptor = fsApi.openSync(ownPath, 'wx', 0o600);
      fsApi.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }), 'utf8');
      fsApi.fsyncSync(descriptor);
      fsApi.closeSync(descriptor);
      descriptor = undefined;
      // Publish our unique claim before scanning. Another process either sees
      // it and refuses, or already has a claim that we must respect. Stale claim
      // paths are never reused, avoiding two reclaimers unlinking a new lock.
      for (const name of fsApi.readdirSync(directory)) {
        const claim = path.join(directory, name);
        if (claim === ownPath) continue;
        const match = /^(\d+)-[a-f0-9-]{36}\.json$/.exec(name);
        if (!match) throw new Error('journal_busy');
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('journal_busy');
        if (isAlive(pid)) throw new Error('journal_busy');
        // No asynchronous enable can survive its owning process. Only remove
        // this dead process's unique claim; its private cleanup journal stays.
        const stat = fsApi.lstatSync(claim);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('journal_busy');
        try { fsApi.unlinkSync(claim); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return () => fsApi.unlinkSync(ownPath);
    } catch (error) {
      if (descriptor !== undefined) try { fsApi.closeSync(descriptor); } catch (_) {}
      try { fsApi.unlinkSync(ownPath); } catch (_) {}
      throw error;
    }
  }

  function read() {
    const document = store.readDocument();
    const state = document.credentials.hub?.titleSync;
    if (!state) return { document, state: { version: 1, active: null, pending: [] } };
    if (state.version !== 1 || !Array.isArray(state.pending) || state.pending.length > 1000) throw new Error('invalid_journal');
    const validate = row => {
      if (!row || typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id)) throw new Error('invalid_journal');
      const binding = destination(row);
      if (!same(binding, row)) throw new Error('invalid_journal');
    };
    if (state.active) validate(state.active);
    for (const row of state.pending) validate(row);
    if (new Set([state.active, ...state.pending].filter(Boolean).map(row => row.id)).size
      !== state.pending.length + (state.active ? 1 : 0)) throw new Error('invalid_journal');
    return { document, state };
  }

  function save(state) {
    const document = operation.document;
    document.credentials.hub ||= {};
    document.credentials.hub.titleSync = state;
    // A failed/ambiguous write never permits titles. Re-read on the next tick.
    store.writeDocument(document);
    operation.state = state;
  }

  function queueActive() {
    const state = operation.state;
    if (state.active) save({ ...state, active: null, pending: [...state.pending, state.active] });
  }

  async function revoke(row) {
    const response = await fetchFn(`${row.hubUrl}/api/sync/titles/${encodeURIComponent(row.deviceId)}`, {
      method: 'PUT', headers: { ...row.headers, 'content-type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify({ enabled: false })
    });
    return response.ok && validPolicy(await response.json(), false);
  }

  async function cleanup() {
    // Bound startup/tick work; failed rows rotate so old offline destinations
    // cannot indefinitely starve cleanup for later one-shot launches.
    for (const row of operation.state.pending.slice(0, 4)) {
      let acknowledged = false;
      try { acknowledged = await revoke(row); } catch (_) {}
      const remaining = operation.state.pending.filter(item => item.id !== row.id);
      // Keep the credential until acknowledged OFF and row removal are durable.
      save({ ...operation.state, pending: acknowledged ? remaining : [...remaining, row] });
    }
    if (operation.state.pending.length) logger.warn?.(`[title-sync] ${operation.state.pending.length} cleanup request(s) pending; retrying on later uploads.`);
  }

  const negotiator = createSessionTitleSyncNegotiator({ now, refreshMs, timeoutMs,
    fetchFn: async (url, options) => {
      if (!url.includes('/api/sync/titles/')) return fetchFn(url, options);
      const enabled = JSON.parse(options.body).enabled;
      if (enabled) {
        if (!same(operation.state.active, operation.context)) {
          if (operation.state.pending.length >= 1000) throw new Error('journal_full');
          const row = { ...operation.context, id: crypto.randomUUID() };
          save({ ...operation.state, pending: [...operation.state.pending, row] });
          operation.admission = row;
        }
      } else queueActive();
      const response = await fetchFn(url, options);
      if (!enabled && response.ok && validPolicy(await response.clone().json(), false)) {
        const pending = operation.state.pending.filter(row => !same(row, operation.context));
        if (pending.length !== operation.state.pending.length) save({ ...operation.state, pending });
      }
      return response;
    }
  });

  function negotiate(input) {
    let context = null;
    try { context = destination(input); } catch (_) { /* Invalid replacement still owes old-destination cleanup. */ }
    const enabled = context !== null && input.enabled === true;
    if (!same(context, requested) || enabled !== requestedEnabled) {
      epoch += 1;
      negotiator.invalidate();
      requested = context;
      requestedEnabled = enabled;
    }
    const version = epoch;
    const work = lane.then(async () => {
      if (version !== epoch) return disabled();
      let release;
      try {
        release = acquire();
        operation = { ...read(), context };
        // Another one-shot process may have revoked/replaced this admission
        // while our memory cache still holds its old generation.
        if ((operation.state.active?.id ?? null) !== cachedAdmissionId) negotiator.invalidate();
        if (!enabled || !same(operation.state.active, context)) {
          queueActive();
          if (enabled) negotiator.invalidate();
        }
        await cleanup();
        if (version !== epoch || !context) return disabled();
        // Retrying OFF for the same remote row must not revoke a new admission.
        // Credential changes cannot make an old unauthorized cleanup disappear.
        if (operation.state.pending.some(row => sameTarget(row, context))) return disabled();
        const result = await negotiator.negotiate({ ...context, enabled });
        if (version !== epoch) return disabled();
        if (result.syncSessionTitles && operation.admission) {
          save({ ...operation.state, active: operation.admission,
            pending: operation.state.pending.filter(row => row.id !== operation.admission.id) });
        }
        cachedAdmissionId = operation.state.active?.id ?? null;
        return result;
      } catch (_) {
        negotiator.invalidate();
        logger.warn?.('[title-sync] Private cleanup journal unavailable; title uploads disabled. Will retry.');
        return disabled();
      } finally {
        operation = null;
        try { release?.(); } catch (_) { logger.warn?.('[title-sync] Could not release cleanup journal lock; title uploads disabled until recovery.'); }
      }
    });
    lane = work.catch(() => {});
    return work;
  }
  return { negotiate, invalidate() { epoch += 1; negotiator.invalidate(); } };
}

module.exports = { createAgentTitleSync };
