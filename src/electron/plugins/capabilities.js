'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { validJson } = require('./host/message');
const { normalizeQuery } = require('../../shared/plugins/businessData');

function capabilityError(error) {
  const fields = {};
  for (const [key, value] of Object.entries(error?.fields || {}).slice(0, 64)) {
    if (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) && typeof value === 'string') Object.defineProperty(fields, key, { value: value.slice(0, 80), enumerable: true });
  }
  return { message: String(error?.message || error || 'Request failed').slice(0, 300),
    code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'capability-failed', fields };
}

// Only bounded, recognized request envelopes enter the transport request lane.
// This is not cursor authorization: the service still validates the signed
// cursor, grants, source and privacy revision at the point of execution.
const CAPABILITY_OPS = new Set(['data.query', 'data.subscribe', 'data.unsubscribe', 'settings.get', 'settings.update', 'settings.reset']);
function isCapabilityRequest(op, args = {}) {
  if (!CAPABILITY_OPS.has(op) || !args || typeof args !== 'object' || Array.isArray(args) || !validJson(args)) return false;
  if (op === 'data.subscribe' || op === 'data.unsubscribe') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(args.id || '')) return false;
  }
  if (op === 'data.query' || op === 'data.subscribe') {
    try { normalizeQuery(args.query); } catch { return false; }
  }
  return true;
}

// Owned by each transport document / Worker generation, not by the author API.
// One running call + 31 queued calls bound retained inputs to 2 MiB and
// admit the existing 16-subscription startup burst plus settings/query calls.
// Requests and replies spend bytes (2 KiB/ms, 128 KiB burst); cheap calls have
// a 512-byte floor, writes/subscriptions a 16 KiB floor. Expensive data work
// additionally pays the business service's CPU/build/retention budget. The
// synchronous entry slice (including settings IO) spends 4x its elapsed time;
// async waits are not charged. This is a wall-time work surrogate, not thread CPU. Debt
// delays the NEXT query, never a DTO already checked against private authority.
function createCapabilityLane({ now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout, workNow = () => performance.now() } = {}) {
  const capacity = 128 * 1024, bytesPerMs = 2048;
  let tokens = capacity, at = now(), timer = null, active = null, closed = false;
  const queue = [], pending = new Set();
  const revoked = () => new Error('capability revoked');
  function pump() {
    if (closed || active || timer !== null || !queue.length) return;
    const time = now(); tokens = Math.min(capacity, tokens + Math.max(0, time - at) * bytesPerMs); at = time;
    const next = queue[0];
    if (tokens < next.cost) {
      timer = setTimer(() => { timer = null; pump(); }, Math.ceil((next.cost - tokens) / bytesPerMs));
      return;
    }
    queue.shift(); active = next; tokens -= next.cost;
    Promise.resolve().then(() => {
      if (closed) throw revoked();
      const started = workNow();
      try { return next.run(); }
      finally { tokens -= Math.max(0, workNow() - started) * bytesPerMs * 4; }
    }).then(value => {
      // Service DTOs are bounded separately; reject an oversized settings or
      // future capability reply before serializing it onto IPC.
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > 64 * 1024) throw new Error('capability reply quota exceeded');
      tokens -= bytes;
      if (closed) throw revoked();
      next.resolve(value);
    }).catch(next.reject).finally(() => { pending.delete(next); active = null; pump(); });
  }
  return {
    run(op, args, run, id) {
      if (closed) throw revoked();
      if (pending.size >= 32 || (id !== undefined && [...pending].some(entry => entry.id === id))) {
        throw Object.assign(new Error('capability request limit'), { code: 'request-limit' });
      }
      if (!isCapabilityRequest(op, args)) throw new Error('invalid capability request');
      const floor = ['settings.update', 'settings.reset', 'data.subscribe'].includes(op) ? 16384 : 512;
      return new Promise((resolve, reject) => {
        const entry = { run, resolve, reject, id, cost: Math.max(floor, Buffer.byteLength(JSON.stringify(args ?? {}))) };
        pending.add(entry); queue.push(entry); pump();
      });
    },
    close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      for (const entry of pending) entry.reject(revoked());
      pending.clear(); queue.length = 0;
    }
  };
}

// Transport-neutral author capabilities. Worker and web controllers retain
// authority/lifecycle ownership; this adapter only scopes subscriptions and
// fences async replies. It never selects a window, starts a collector or logs in.
function createPluginCapabilities({ businessData }) {
  const owners = new Map();
  function release(owner) {
    const state = owners.get(owner);
    if (state) {
      state.live = false;
      for (const pending of state.pending) pending.cancel();
    }
    owners.delete(owner);
    if (state) businessData.releaseOwner(state.serviceOwner);
  }
  async function call(owner, op, args = {}, context) {
    const initial = context.auth();
    if (!initial?.active) throw new Error('capability revoked');
    const identity = value => JSON.stringify([value.pluginId, value.revision, [...(value.permissions || [])].sort(), value.scope]);
    const stamp = identity(initial);
    let state = owners.get(owner);
    if (state && state.stamp !== stamp) { release(owner); state = null; }
    if (!state) { state = { live: true, stamp, serviceOwner: randomUUID(), subscriptions: new Map(), pending: new Set() }; owners.set(owner, state); }
    const auth = () => {
      const value = context.auth();
      return { ...value, active: state.live && value.active === true && identity(value) === stamp };
    };
    if (!auth().active) throw new Error('capability revoked');
    let result;
    if (op === 'data.query') {
      let reject;
      const cancelled = new Promise((_, fail) => { reject = fail; });
      const pending = { cancel() { reject(new Error('capability revoked')); } };
      state.pending.add(pending);
      try {
        result = await Promise.race([businessData.query(args.query, auth, { owner: state.serviceOwner }), cancelled]);
      } finally { state.pending.delete(pending); }
    }
    else if (op === 'data.subscribe') {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(args.id || '')) throw new Error('invalid subscription id');
      if (!state.subscriptions.has(args.id) && state.subscriptions.size >= 16) throw new Error('subscription limit');
      const previous = state.subscriptions.get(args.id);
      if (previous !== undefined) businessData.unsubscribe(state.serviceOwner, previous);
      const id = businessData.subscribe(state.serviceOwner, args.query, auth, value => {
        if (auth().active) context.send({ id: args.id, value });
      });
      state.subscriptions.set(args.id, id);
      result = true;
    } else if (op === 'data.unsubscribe') {
      const id = state.subscriptions.get(args.id);
      if (id !== undefined) businessData.unsubscribe(state.serviceOwner, id);
      state.subscriptions.delete(args.id);
      result = true;
    } else if (op === 'settings.get') result = await context.settings.get();
    else if (op === 'settings.update') result = await context.settings.update(args);
    else if (op === 'settings.reset') result = await context.settings.reset(args);
    else throw new Error('unsupported capability');
    if (!auth().active) throw new Error('capability revoked');
    return result;
  }
  return { call, release, async invoke(...args) {
    try { return { __tmCapability: 1, ok: true, value: await call(...args) }; }
    catch (error) { return { __tmCapability: 1, ok: false, error: capabilityError(error) }; }
  }, dispose() { for (const owner of owners.keys()) release(owner); } };
}
module.exports = { createPluginCapabilities, capabilityError, createCapabilityLane, isCapabilityRequest };
