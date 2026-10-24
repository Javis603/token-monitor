'use strict';

// Owns every plugin from discovery to teardown: manifests and consent, which
// Data Bus sources run and at what cadence, when a plugin's sandboxed process
// exists, background alerts, and the resolved view payloads each surface
// draws. Surfaces never see manifests, code, paths or raw readings.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeManifest } = require('../../shared/plugins/manifest');
const permissionsApi = require('../../shared/plugins/permissions');
const { createResolver, formatValue } = require('../../shared/plugins/bindings');
const { layoutFor, sanitizeDisplayList, normalizeRows } = require('../../shared/plugins/viewSpec');
const { localize } = require('../../shared/plugins/localized');
const { evaluateAlert, alertMessage } = require('../../shared/plugins/alerts');
const placements = require('../../shared/plugins/placements');
const { createSupervisor, createRateLimiter } = require('./supervisor');
const broker = require('./broker');
const { packageDirectory } = require('./package');
const { publicSettings } = require('./settings');
const { capabilityError, createCapabilityLane, isCapabilityRequest } = require('./capabilities');
const { validMessage } = require('./host/message');
const { findAction, validateInteraction } = require('../../shared/plugins/interactions');

const MAX_PLUGINS = 64;
const { MAX_MANIFEST_BYTES, assertHostCompatibility } = require('./contracts');
const ALERT_INTERVAL_MS = 15_000;
const IDLE_GRACE_MS = 30_000;
const BOOT_TIMEOUT_MS = 10_000;
const TICK_TIMEOUT_MS = 30_000;
const METRICS_INTERVAL_MS = 5_000;
const PUSH_THROTTLE_MS = 250;
const LOG_LIMIT = 100;
const SURFACES = Object.freeze(['home', 'tray', 'edgeDock', 'notch', 'page']);
const MESSAGE_RATE = Object.freeze({ capacity: 200, perSecond: 100 });
const FLOOD_DROPS = 400;

function normalizePluginStates(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, raw] of Object.entries(value).slice(0, MAX_PLUGINS * 2)) {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id) || !raw || typeof raw !== 'object') continue;
    out[id] = {
      enabled: raw.enabled === true,
      background: raw.background === true,
      grant: permissionsApi.normalizeGrant(raw.grant)
    };
  }
  return out;
}

function realpathInside(root, target) {
  try {
    const rootReal = fs.realpathSync(root);
    const targetReal = fs.realpathSync(target);
    return targetReal === rootReal || targetReal.startsWith(`${rootReal}${path.sep}`) ? targetReal : null;
  } catch {
    return null;
  }
}

function readManifestFile(dir) {
  const file = path.join(dir, 'manifest.json');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('manifest.json must be a file under 256 KB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createPluginManager({
  builtinDir,
  userDir,
  dataDir,
  bus,
  sandbox = null,
  notify = () => {},
  netFetch = null,
  capabilities = null,
  authorSettings = null,
  getSettings,
  saveStates,
  getLocale = () => 'en',
  getAppearance = () => ({}),
  safeMode = false,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {}
}) {
  const plugins = new Map();
  const surfaceDemand = new Map(SURFACES.map((surface) => [surface, new Set()]));
  const webVisible = new Map();
  const dataOwners = new Map();
  const viewListeners = new Set();
  const changeListeners = new Set();
  const supervisor = createSupervisor({ now });
  const appliedDemands = new Map();
  const pushTimers = new Map();
  let metricsTimer = null;
  let disposed = false;
  let mutating = false;
  let interactionRevision = 0;

  function settings() {
    return getSettings() || {};
  }

  function states() {
    return normalizePluginStates(settings().pluginStates);
  }

  function masterEnabled() {
    return !safeMode && settings().pluginsEnabled !== false;
  }

  function busId(pluginId, source) {
    return source.startsWith('@') ? `plugin.${pluginId}.${source.slice(1)}` : source;
  }

  function addLog(plugin, level, text) {
    plugin.logs.push({ at: now(), level, text: String(text || '').slice(0, 1000) });
    if (plugin.logs.length > LOG_LIMIT) plugin.logs.splice(0, plugin.logs.length - LOG_LIMIT);
  }

  // What a settings patch can change for an idle catalog: availability and labels.
  let changeSignature = '';
  const currentChangeSignature = () => JSON.stringify([masterEnabled(), getLocale(), [...plugins.values()].map(plugin => [plugin.id, pluginStatus(plugin)])]);

  function emitChanged() {
    changeSignature = currentChangeSignature();
    for (const listener of [...changeListeners]) {
      try { listener(); } catch (error) { log(`[plugins] change listener failed: ${error.message}`); }
    }
  }

  // ---- Discovery ---------------------------------------------------------

  function discover(root, source) {
    const found = [];
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const dir = path.join(root, entry.name);
      const record = { id: entry.name, dir, source, manifest: null, errors: [], codeFile: null };
      try {
        const rawManifest = readManifestFile(dir);
        const identityStats = [fs.statSync(dir), fs.statSync(path.join(dir, 'manifest.json'))]
          .map(stat => [stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs]);
        record.settingsIdentity = createHash('sha256').update(JSON.stringify([identityStats, rawManifest])).digest('hex');
        assertHostCompatibility(rawManifest);
        const result = normalizeManifest(rawManifest, { source });
        record.errors = result.errors;
        record.manifest = result.manifest;
        if (result.manifest) {
          record.id = result.manifest.id;
          if (result.manifest.main) {
            record.codeFile = realpathInside(dir, path.join(dir, result.manifest.main));
            if (!record.codeFile) {
              record.manifest = null;
              record.errors = [...record.errors, `main file ${result.manifest.main} is missing or outside the plugin folder`];
            }
          }
        }
        if (record.manifest?.webUi) {
          // Host-owned bytes survive source edits until the next discovery.
          record.assets = Object.freeze(packageDirectory(dir).assets);
        }
      } catch (error) {
        record.manifest = null;
        record.assets = null;
        record.errors = [`manifest.json/package: ${error.message}`];
      }
      found.push(record);
    }
    return found;
  }

  function freshRuntime() {
    return {
      webRevision: ++interactionRevision, state: 'stopped', mode: null, seq: 0, revision: ++interactionRevision, interactionSeq: 0, pendingInteractions: new Map(), interactionLimit: createRateLimiter({ capacity: 40, perSecond: 30, now }), inTick: false, tickDeadline: null, tickTimer: null, idleTimer: null,
      bootTimer: null, restartTimer: null, subscriptions: new Set(), metrics: null,
      limiter: createRateLimiter({ ...MESSAGE_RATE, now }), notifyLimiter: createRateLimiter({ capacity: 3, perSecond: 1 / 60, now }),
      capabilityLane: null, netLimiter: createRateLimiter({ capacity: 10, perSecond: 0.5, now }), requests: new Set(), generation: 0, dropped: 0, lastError: ''
    };
  }

  function reload() {
    // Do not discard the sole in-memory copy if persistence fails.
    for (const plugin of plugins.values()) plugin.storage?.flush();
    for (const plugin of plugins.values()) stopWorker(plugin, { immediate: true });
    plugins.clear();
    bus.clearSourcesWithPrefix('plugin.');
    const records = [...discover(builtinDir, 'builtin'), ...discover(userDir, 'user')];
    for (const record of records.slice(0, MAX_PLUGINS)) {
      const existing = plugins.get(record.id);
      if (existing) {
        existing.errors.push(`a second plugin with id "${record.id}" at ${record.source} was ignored`);
        continue;
      }
      plugins.set(record.id, {
        ...record,
        logs: [],
        alertStates: new Map(),
        storage: (record.manifest?.main || record.manifest?.webUi) ? broker.createPluginStorage({ dir: dataDir, pluginId: record.id, onError: error => {
          const owner = plugins.get(record.id);
          if (owner) addLog(owner, 'error', `storage write failed: ${error.message}`);
          emitChanged();
        } }) : null,
        runtime: freshRuntime()
      });
    }
    reconcile();
    pushAll();
    emitChanged();
  }

  // ---- Activation ----------------------------------------------------------

  function pluginStatus(plugin) {
    if (!plugin.manifest) return 'invalid';
    if (!masterEnabled()) return safeMode ? 'safeMode' : 'pluginsOff';
    const state = states()[plugin.id];
    if (!state?.enabled) return 'disabled';
    if (!permissionsApi.grantSatisfied(plugin.manifest, state.grant)) return 'needsApproval';
    if (supervisor.isOpen(plugin.id)) return 'crashed';
    return 'active';
  }

  function isActive(plugin) {
    return pluginStatus(plugin) === 'active';
  }

  function grantOf(plugin) {
    const held = states()[plugin.id]?.grant || { permissions: [], hosts: [] };
    return {
      permissions: held.permissions.filter((permission) => plugin.manifest.permissions.includes(permission)),
      hosts: held.hosts.filter((host) => plugin.manifest.network.hosts.includes(host))
    };
  }

  function backgroundAllowed(plugin) {
    return states()[plugin.id]?.background === true;
  }

  function resolveRef(ref) {
    const parsed = placements.parseRef(ref);
    if (!parsed) return null;
    const plugin = plugins.get(parsed.pluginId);
    const view = plugin?.manifest?.views.find((entry) => entry.id === parsed.viewId);
    return plugin && view ? { plugin, view } : { plugin: plugin || null, view: null };
  }

  function reconcile() {
    if (disposed || mutating) return;
    const wanted = new Map();
    const modes = new Map();
    for (const [surface, refs] of surfaceDemand) {
      for (const ref of refs) {
        const resolved = resolveRef(ref);
        if (!resolved?.view || !isActive(resolved.plugin) || !resolved.view.surfaces.includes(surface)) continue;
        const { plugin, view } = resolved;
        const sources = view.sources.map((source) => busId(plugin.id, source));
        if (sources.length) wanted.set(`view:${surface}:${ref}`, { sources, lifecycle: 'visible', intervalMs: plugin.manifest.visible.intervalMs });
        if (plugin.manifest.main) modes.set(plugin.id, 'visible');
      }
    }
    for (const ref of webVisible.values()) {
      const [pluginId, documentId] = ref.split('/'); const plugin = plugins.get(pluginId);
      if (plugin && isActive(plugin) && plugin.manifest.main && plugin.manifest.webUi?.documents.some(doc => doc.id === documentId)) modes.set(plugin.id, 'visible');
    }
    for (const plugin of plugins.values()) {
      if (!isActive(plugin) || !backgroundAllowed(plugin)) continue;
      for (const alert of plugin.manifest.alerts) {
        wanted.set(`alert:${plugin.id}:${alert.id}`, {
          sources: alert.sources.map((source) => busId(plugin.id, source)),
          lifecycle: 'background',
          intervalMs: ALERT_INTERVAL_MS
        });
      }
      const producesAlerts = plugin.manifest.alerts.some(alert => alert.sources.some(source => source.startsWith('@')));
      if (plugin.manifest.main && (plugin.manifest.background || producesAlerts) && !modes.has(plugin.id)) modes.set(plugin.id, 'background');
    }
    for (const [pluginId, mode] of modes) {
      const plugin = plugins.get(pluginId);
      const intervalMs = mode === 'visible' ? plugin.manifest.visible.intervalMs : (plugin.manifest.background?.intervalMs || ALERT_INTERVAL_MS);
      for (const source of plugin.runtime.subscriptions) {
        wanted.set(`worker:${pluginId}:${source}`, { sources: [source], lifecycle: mode, intervalMs });
      }
    }
    for (const consumer of [...appliedDemands.keys()]) {
      if (!wanted.has(consumer)) {
        bus.clearDemand(consumer);
        appliedDemands.delete(consumer);
      }
    }
    for (const [consumer, demand] of wanted) {
      const key = JSON.stringify(demand);
      if (appliedDemands.get(consumer) === key) continue;
      appliedDemands.set(consumer, key);
      bus.setDemand(consumer, demand);
    }
    for (const plugin of plugins.values()) {
      if (!plugin.manifest?.main) continue;
      if (!isActive(plugin)) stopWorker(plugin, { immediate: true });
      else setWorkerMode(plugin, modes.get(plugin.id) || null);
    }
  }

  // ---- Sandboxed workers ---------------------------------------------------

  function clearRuntimeTimers(runtime) {
    for (const name of ['tickTimer', 'tickDeadline', 'idleTimer', 'bootTimer']) {
      if (runtime[name]) clearTimer(runtime[name]);
      runtime[name] = null;
    }
  }

  function scheduleTick(plugin) {
    const runtime = plugin.runtime;
    if (runtime.tickTimer) clearTimer(runtime.tickTimer);
    runtime.tickTimer = null;
    if (runtime.state !== 'running' || !runtime.mode) return;
    const intervalMs = runtime.mode === 'visible' ? plugin.manifest.visible.intervalMs : (plugin.manifest.background?.intervalMs || ALERT_INTERVAL_MS);
    runtime.tickTimer = setTimer(() => {
      runtime.tickTimer = null;
      sendTick(plugin);
      scheduleTick(plugin);
    }, intervalMs);
    runtime.tickTimer?.unref?.();
  }

  function sendTick(plugin) {
    const runtime = plugin.runtime;
    // A tick still in flight is not stacked: slow plugins tick less often.
    if (runtime.inTick || runtime.state !== 'running') return;
    runtime.seq += 1;
    runtime.inTick = true;
    if (!sandbox?.send(plugin.id, { type: 'tick', seq: runtime.seq, mode: runtime.mode, now: now() })) {
      runtime.inTick = false;
      return;
    }
    const generation = runtime.generation, seq = runtime.seq;
    runtime.tickDeadline = setTimer(() => {
      if (runtime.generation !== generation || runtime.seq !== seq || !runtime.inTick) return;
      runtime.tickDeadline = null;
      sandbox.kill(plugin.id, 'tick-timeout');
    }, TICK_TIMEOUT_MS);
    runtime.tickDeadline?.unref?.();
  }

  function startWorker(plugin) {
    const runtime = plugin.runtime;
    if (!sandbox || runtime.restartTimer || !plugin.codeFile) return;
    try {
      runtime.generation += 1;
      runtime.revision = ++interactionRevision;
      runtime.pendingInteractions.clear();
      sandbox.start(plugin.id, { codeFile: plugin.codeFile });
    } catch (error) {
      runtime.state = 'error';
      runtime.lastError = error.message;
      addLog(plugin, 'error', `start failed: ${error.message}`);
      return;
    }
    runtime.capabilityLane?.close();
    runtime.capabilityLane = createCapabilityLane({ now, setTimer, clearTimer });
    runtime.limiter = createRateLimiter({ ...MESSAGE_RATE, now });
    runtime.dropped = 0;
    runtime.state = 'starting';
    runtime.inTick = false;
    supervisor.started(plugin.id);
    runtime.bootTimer = setTimer(() => {
      runtime.bootTimer = null;
      if (runtime.state === 'starting') sandbox.kill(plugin.id, 'boot-timeout');
    }, BOOT_TIMEOUT_MS);
    runtime.bootTimer?.unref?.();
    ensureMetricsTimer();
  }

  function cancelRequests(runtime) {
    for (const controller of runtime.requests) controller.abort();
    runtime.requests.clear();
  }

  function releaseWorkerData(plugin) {
    plugin.runtime.capabilityLane?.close();
    plugin.runtime.capabilityLane = null;
    const owner = dataOwners.get(plugin.id);
    if (owner) capabilities?.release(owner);
    dataOwners.delete(plugin.id);
  }

  function dataAuth(plugin) {
    return { pluginId: plugin.id, permissions: grantOf(plugin).permissions,
      active: isActive(plugin) && !mutating && !disposed };
  }

  function stopWorker(plugin, { immediate = false } = {}) {
    releaseWorkerData(plugin);
    const runtime = plugin.runtime;
    runtime.generation += 1;
    runtime.pendingInteractions.clear();
    cancelRequests(runtime);
    clearRuntimeTimers(runtime);
    if (runtime.restartTimer) clearTimer(runtime.restartTimer);
    runtime.restartTimer = null;
    runtime.mode = null;
    if (!sandbox?.isRunning(plugin.id)) {
      if (runtime.state !== 'error') runtime.state = 'stopped';
      return;
    }
    if (immediate) {
      sandbox.stop(plugin.id);
      runtime.state = 'stopped';
      runtime.subscriptions.clear();
    }
  }

  function setWorkerMode(plugin, mode) {
    const runtime = plugin.runtime;
    if (!mode) {
      releaseWorkerData(plugin);
      if (runtime.mode === null && runtime.state === 'stopped') return;
      if (runtime.tickTimer) clearTimer(runtime.tickTimer);
      runtime.tickTimer = null;
      if (runtime.mode) {
        sandbox?.send(plugin.id, { type: 'mode', mode: 'idle' });
        cancelRequests(runtime);
      }
      runtime.mode = null;
      if (runtime.restartTimer) {
        clearTimer(runtime.restartTimer);
        runtime.restartTimer = null;
      }
      // Nothing needs this plugin now; keep the process briefly so toggling a
      // view does not respawn it, then release its memory entirely.
      if (sandbox?.isRunning(plugin.id) && !runtime.idleTimer) {
        runtime.idleTimer = setTimer(() => {
          runtime.idleTimer = null;
          if (runtime.mode) return;
          stopWorker(plugin, { immediate: true });
          reconcile();
          emitChanged();
        }, IDLE_GRACE_MS);
        runtime.idleTimer?.unref?.();
      } else if (!sandbox?.isRunning(plugin.id) && runtime.state !== 'error') {
        runtime.state = 'stopped';
      }
      return;
    }
    if (runtime.idleTimer) {
      clearTimer(runtime.idleTimer);
      runtime.idleTimer = null;
    }
    const changed = runtime.mode !== mode;
    runtime.mode = mode;
    runtime.capabilityLane ??= createCapabilityLane({ now, setTimer, clearTimer });
    if (!sandbox?.isRunning(plugin.id)) {
      startWorker(plugin);
      return;
    }
    if (changed && runtime.state === 'running') {
      sandbox.send(plugin.id, { type: 'mode', mode });
      for (const source of runtime.subscriptions) {
        const current = bus.read(source);
        if (current) sandbox.send(plugin.id, { type: 'data', source, value: current.value });
      }
      sendTick(plugin);
      scheduleTick(plugin);
    }
  }

  function handleExit(pluginId, reason) {
    const plugin = plugins.get(pluginId);
    if (!plugin) return;
    const runtime = plugin.runtime;
    const wantedMode = runtime.mode;
    releaseWorkerData(plugin);
    runtime.generation += 1;
    runtime.pendingInteractions.clear();
    cancelRequests(runtime);
    clearRuntimeTimers(runtime);
    runtime.inTick = false;
    runtime.subscriptions.clear();
    if (reason === 'stopped') {
      runtime.state = 'stopped';
      return;
    }
    runtime.lastError = reason;
    addLog(plugin, 'error', `process exited: ${reason}`);
    const decision = supervisor.exited(pluginId, reason);
    if (decision.action === 'disable') {
      runtime.state = 'crashed';
      runtime.mode = null;
      log(`[plugins] ${pluginId} disabled after repeated failures (${reason})`);
      reconcile();
      pushAll();
      emitChanged();
      return;
    }
    runtime.state = 'backoff';
    runtime.restartTimer = setTimer(() => {
      runtime.restartTimer = null;
      runtime.state = 'stopped';
      runtime.mode = null;
      if (wantedMode) reconcile();
      emitChanged();
    }, decision.delayMs);
    runtime.restartTimer?.unref?.();
    reconcile();
    emitChanged();
  }

  function ensureMetricsTimer() {
    if (metricsTimer || !sandbox) return;
    metricsTimer = setTimer(function sampleMetrics() {
      metricsTimer = null;
      const running = sandbox.running();
      if (!running.length) return;
      const metrics = sandbox.metrics();
      let changed = false;
      for (const pluginId of running) {
        const plugin = plugins.get(pluginId);
        if (!plugin) continue;
        if ([...plugin.runtime.pendingInteractions.values()].some(at => now() - at > 30_000)) { changed = true; sandbox.kill(pluginId, 'interaction-timeout'); continue; }
        const previous = plugin.runtime.metrics;
        const next = metrics[pluginId] || null;
        if (!Object.is(previous?.cpuPercent ?? null, next?.cpuPercent ?? null)
          || !Object.is(previous?.memoryMB ?? null, next?.memoryMB ?? null)) changed = true;
        // Copy the readings so a mutable sandbox sample cannot erase the delta.
        plugin.runtime.metrics = next ? { cpuPercent: next.cpuPercent, memoryMB: next.memoryMB } : null;
        const reason = supervisor.checkMetrics(pluginId, plugin.runtime.metrics || {});
        if (reason) {
          changed = true;
          addLog(plugin, 'error', `${reason}: ${JSON.stringify(plugin.runtime.metrics)}`);
          sandbox.kill(pluginId, reason);
        }
      }
      for (const pluginId of supervisor.staleHeartbeats(sandbox.running())) {
        if (plugins.get(pluginId)?.runtime.state === 'running') {
          changed = true;
          sandbox.kill(pluginId, 'no-heartbeat');
        }
      }
      if (changed) emitChanged();
      ensureMetricsTimer();
    }, METRICS_INTERVAL_MS);
    metricsTimer?.unref?.();
  }

  // ---- Messages from a plugin's sandbox ----------------------------------

  async function handleCall(plugin, message) {
    const id = Number(message.id);
    if (!Number.isSafeInteger(id)) return;
    const runtime = plugin.runtime;
    const generation = runtime.generation;
    const reply = (_plugin, _id, result) => {
      if (plugins.get(plugin.id) !== plugin || plugin.runtime !== runtime || runtime.generation !== generation || !isActive(plugin)) return;
      sandbox?.send(plugin.id, { type: 'result', id, ...result });
    };
    const args = message.args && typeof message.args === 'object' ? message.args : {};
    const grant = grantOf(plugin);
    try {
      if (!runtime.mode || !['starting', 'running'].includes(runtime.state) || !sandbox?.isRunning(plugin.id)) throw new Error('plugin is idle');
      if (message.op.startsWith('data.') || message.op.startsWith('settings.')) {
        if (!isCapabilityRequest(message.op, args)) throw new Error('invalid capability request');
        if (!capabilities) throw new Error('capability unavailable');
        let owner = dataOwners.get(plugin.id);
        if (!owner) { owner = { pluginId: plugin.id, generation }; dataOwners.set(plugin.id, owner); }
        const valid = () => plugins.get(plugin.id) === plugin && runtime.generation === generation && runtime.mode && ['starting', 'running'].includes(runtime.state) && sandbox?.isRunning(plugin.id) && dataOwners.get(plugin.id) === owner && isActive(plugin);
        const value = await runtime.capabilityLane.run(message.op, args, () => {
          if (!valid()) throw new Error('capability revoked');
          return capabilities.call(owner, message.op, args, {
            auth: () => ({ ...dataAuth(plugin), revision: generation, active: Boolean(valid()) }),
            settings: authorSettingsAccess(plugin, true),
            send: event => { if (valid()) sandbox?.send(plugin.id, { type: 'business-data', ...event }); }
          });
        }, id);
        if (!valid()) throw new Error('capability revoked');
        return reply(plugin, id, { ok: true, value });
      }
      if (message.op === 'storage.get') return reply(plugin, id, { ok: true, value: plugin.storage.get(args.key) });
      if (message.op === 'storage.set') return reply(plugin, id, { ok: true, value: plugin.storage.set(args.key, args.value) });
      if (message.op === 'storage.delete') return reply(plugin, id, { ok: true, value: plugin.storage.delete(args.key) });
      if (message.op === 'notify') {
        if (!permissionsApi.hasPermission(grant, 'notify')) throw new Error('notify permission not granted');
        if (!backgroundAllowed(plugin) && plugin.runtime.mode !== 'visible') throw new Error('background activity is turned off for this plugin');
        const note = broker.validateNotification(args);
        if (!note.ok) throw new Error(note.error);
        if (!plugin.runtime.notifyLimiter.take()) throw new Error('notification rate limit reached');
        notify({ title: `${localize(plugin.manifest.name, getLocale())} · ${note.title}`, body: note.body, pluginId: plugin.id });
        return reply(plugin, id, { ok: true, value: true });
      }
      if (message.op === 'net.fetch') {
        if (!permissionsApi.hasPermission(grant, 'network')) throw new Error('network permission not granted');
        const checked = broker.validateNetRequest({ ...plugin.manifest, network: { hosts: grant.hosts } }, args);
        if (!checked.ok) throw new Error(checked.error);
        if (!netFetch) throw new Error('network is unavailable');
        if (runtime.requests.size >= 4 || !runtime.netLimiter.take()) throw new Error('network rate limit reached');
        const controller = new AbortController();
        runtime.requests.add(controller);
        try {
          const response = await broker.performNetRequest(netFetch, checked.request, { signal: controller.signal });
          return reply(plugin, id, { ok: true, value: response });
        } finally {
          runtime.requests.delete(controller);
        }
      }
      throw new Error(`unknown operation ${String(message.op).slice(0, 40)}`);
    } catch (error) {
      if (error.code === 'request-limit') { sandbox?.kill(plugin.id, 'protocol-rate-limit'); return; }
      reply(plugin, id, { ok: false, error: capabilityError(error).message, code: capabilityError(error).code, fields: capabilityError(error).fields });
    }
  }

  function handleMessage(pluginId, message) {
    const plugin = plugins.get(pluginId);
    if (!plugin?.manifest || !isActive(plugin) || !message || typeof message !== 'object') return;
    const runtime = plugin.runtime;
    if (!validMessage(message, { trusted: true })) {
      if (!runtime.limiter.take()) { sandbox?.kill(pluginId, 'protocol-rate-limit'); return; }
      addLog(plugin, 'warn', 'invalid plugin message ignored');
      if (message.type === 'call' && Number.isSafeInteger(message.id)) sandbox?.send(pluginId, { type: 'result', id: message.id, ok: false, error: 'invalid message or message quota exceeded' });
      return;
    }
    try {
      dispatchMessage(pluginId, plugin, runtime, message);
    } catch (error) {
      // Plugin input must never escape into main's event loop.
      addLog(plugin, 'warn', `invalid plugin message: ${error.message}`);
    }
  }

  function dispatchMessage(pluginId, plugin, runtime, message) {
    if (message.type === 'heartbeat') {
      supervisor.heartbeat(pluginId);
      return;
    }
    const request = message.type === 'call' && isCapabilityRequest(message.op, message.args);
    if (!request && !runtime.limiter.take()) {
      if (['ready', 'tick-done', 'interaction-done', 'call'].includes(message.type)) {
        sandbox?.kill(pluginId, 'protocol-rate-limit');
        return;
      }
      runtime.dropped += 1;
      if (runtime.dropped === 1 || runtime.dropped % 100 === 0) addLog(plugin, 'warn', `message rate limit: ${runtime.dropped} dropped`);
      if (runtime.dropped >= FLOOD_DROPS) sandbox?.kill(pluginId, 'flooding');
      return;
    }
    switch (message.type) {
      case 'ready':
        if (runtime.state !== 'starting') return;
        if (runtime.bootTimer) clearTimer(runtime.bootTimer);
        runtime.bootTimer = null;
        runtime.state = 'running';
        runtime.dropped = 0;
        if (runtime.mode) {
          sandbox.send(pluginId, { type: 'mode', mode: runtime.mode });
          sendTick(plugin);
          scheduleTick(plugin);
        }
        pushAll();
        emitChanged();
        return;
      case 'interaction-done':
        runtime.pendingInteractions.delete(message.seq);
        return;
      case 'tick-done':
        if (!runtime.inTick || message.seq !== runtime.seq) return;
        if (runtime.tickDeadline) clearTimer(runtime.tickDeadline);
        runtime.tickDeadline = null;
        runtime.inTick = false;
        return;
      case 'publish': {
        if (!runtime.mode) return;
        const metric = plugin.manifest.metrics.find((entry) => entry.id === message.metric);
        if (!metric) {
          addLog(plugin, 'warn', `publish to undeclared metric "${String(message.metric).slice(0, 40)}" ignored`);
          return;
        }
        const checked = broker.validateMetricValue(metric.kind, message.value);
        if (!checked.ok) {
          addLog(plugin, 'warn', `publish ${metric.id}: ${checked.error}`);
          return;
        }
        bus.publish(`plugin.${pluginId}.${metric.id}`, checked.value);
        return;
      }
      case 'subscribe': {
        if (!runtime.mode) return;
        const source = String(message.source || '');
        if (!permissionsApi.canReadSource(grantOf(plugin), source)) {
          addLog(plugin, 'warn', `subscribe ${source.slice(0, 40)} denied: no permission`);
          return;
        }
        if (runtime.subscriptions.has(source) || runtime.subscriptions.size >= 16) return;
        runtime.subscriptions.add(source);
        const current = bus.read(source);
        if (current) sandbox.send(pluginId, { type: 'data', source, value: current.value });
        reconcile();
        return;
      }
      case 'call':
        void handleCall(plugin, message);
        return;
      case 'log':
        addLog(plugin, message.level === 'warn' ? 'warn' : 'info', message.text);
        return;
      case 'error':
        runtime.lastError = String(message.message || 'error').slice(0, 300);
        addLog(plugin, 'error', runtime.lastError);
        if (runtime.state === 'starting') sandbox.kill(pluginId, 'boot-error');
        return;
      case 'dropped':
        addLog(plugin, 'warn', `message dropped by host: ${String(message.reason).slice(0, 40)}`);
        return;
      default:
    }
  }

  // ---- Bus fan-out: views, workers, alerts -------------------------------

  function onBusChange(changed) {
    // Worker subscriptions: forward only the sources each worker asked for.
    for (const plugin of plugins.values()) {
      if (plugin.runtime.state !== 'running' || !plugin.runtime.mode || !isActive(plugin)) continue;
      for (const source of plugin.runtime.subscriptions) {
        if (!changed.has(source)) continue;
        const reading = bus.read(source);
        if (reading) sandbox.send(plugin.id, { type: 'data', source, value: reading.value });
      }
    }
    evaluateAlerts(changed);
    for (const [surface, refs] of surfaceDemand) {
      for (const ref of refs) {
        const resolved = resolveRef(ref);
        if (!resolved?.view) continue;
        if (resolved.view.sources.some((source) => changed.has(busId(resolved.plugin.id, source)))) {
          schedulePush(surface);
          break;
        }
      }
    }
  }

  function resolverFor(plugin, locale = getLocale()) {
    return createResolver({
      read: (id) => bus.read(id),
      history: (id, count, field) => bus.history(id, count, field),
      historyPoints: (id, count, field) => bus.historyPoints(id, count, field),
      sourceInterval: id => bus.effectiveInterval(id),
      pluginId: plugin.id,
      locale,
      sanitizeDraw: (list) => (Array.isArray(list) ? sanitizeDisplayList(list) : []),
      sanitizeRows: (rows) => (Array.isArray(rows) ? normalizeRows(rows) : [])
    });
  }

  function evaluateAlerts(changed) {
    for (const plugin of plugins.values()) {
      if (!plugin.manifest?.alerts.length || !isActive(plugin) || !backgroundAllowed(plugin)) continue;
      const resolver = resolverFor(plugin);
      for (const alert of plugin.manifest.alerts) {
        if (!alert.sources.some((source) => changed.has(busId(plugin.id, source)))) continue;
        const value = resolver.raw(alert.source);
        const result = evaluateAlert(alert, typeof value === 'number' ? value : null, now(), plugin.alertStates.get(alert.id));
        plugin.alertStates.set(alert.id, result.state);
        if (!result.fire) continue;
        const locale = getLocale();
        const formatted = formatValue(value, alert.source, locale);
        notify({
          title: `${localize(plugin.manifest.name, locale)} · ${localize(alert.title, locale)}`,
          body: alertMessage(localize(alert.message, locale), formatted),
          pluginId: plugin.id
        });
        addLog(plugin, 'info', `alert ${alert.id} fired at ${formatted}`);
      }
    }
  }

  function viewState(ref, surface, locale) {
    const resolved = resolveRef(ref);
    if (!resolved?.plugin || !resolved.view) return { ref, status: 'missing' };
    const { plugin, view } = resolved;
    const base = {
      ref,
      pluginId: plugin.id,
      viewId: view.id,
      title: localize(view.title, locale),
      pluginName: localize(plugin.manifest.name, locale),
      icon: view.icon
    };
    const status = pluginStatus(plugin);
    if (status !== 'active') return { ...base, status };
    if (!view.surfaces.includes(surface)) return { ...base, status: 'unsupported' };
    const resolver = resolverFor(plugin, locale);
    try {
      const out = { ...base, status: 'ok', revision: plugin.runtime.revision };
      out.webDocuments = (plugin.manifest.webUi?.documents || []).filter(doc => doc.target === surface && doc.view === view.id).map(doc => ({ ref: `${plugin.id}/${doc.id}`, variant: doc.variant, height: doc.height }));
      if (surface === 'tray') {
        out.tray = resolver.resolveTray(view.tray) || null;
        out.compact = resolver.resolveCompact(view.compact);
      } else {
        out.tree = resolver.resolveNode(layoutFor(view, surface));
        if (surface === 'edgeDock') out.compact = resolver.resolveCompact(view.compact);
      }
      const runtime = plugin.runtime;
      if (plugin.manifest.main && runtime.state !== 'running') out.pending = runtime.state;
      return out;
    } catch (error) {
      addLog(plugin, 'error', `view ${view.id}: ${error.message}`);
      return { ...base, status: 'error' };
    }
  }

  function payloadFor(surface) {
    const locale = getLocale();
    const views = {};
    let remainingBytes = 512 * 1024;
    let remainingDraws = 3200;
    const drawingCount = node => !node ? 0 : (node.type === 'draw' ? node.list?.length || 0 : 0) + (node.children || []).reduce((sum, child) => sum + drawingCount(child), 0);
    for (const ref of surfaceDemand.get(surface) || []) {
      if (remainingBytes <= 0 || remainingDraws <= 0) { views[ref] = { ref, status: 'error' }; continue; }
      const value = viewState(ref, surface, locale);
      remainingBytes -= JSON.stringify(value).length * 3;
      remainingDraws -= drawingCount(value.tree) + (value.tray?.draw?.length || 0);
      views[ref] = remainingBytes >= 0 && remainingDraws >= 0 ? value : { ref, status: 'error' };
    }
    return { surface, views, appearance: getAppearance() };
  }

  function schedulePush(surface) {
    if (pushTimers.has(surface) || disposed) return;
    pushTimers.set(surface, setTimer(() => {
      pushTimers.delete(surface);
      const payload = payloadFor(surface);
      for (const listener of [...viewListeners]) {
        try { listener(surface, payload); } catch (error) { log(`[plugins] view listener failed: ${error.message}`); }
      }
    }, PUSH_THROTTLE_MS));
  }

  function pushAll() {
    for (const surface of SURFACES) if (surfaceDemand.get(surface).size) schedulePush(surface);
  }

  const unsubscribeBus = bus.subscribe(onBusChange);

  // ---- Public surface ----------------------------------------------------

  function describe(plugin) {
    const locale = getLocale();
    const manifest = plugin.manifest;
    const state = states()[plugin.id] || null;
    const base = {
      id: plugin.id,
      source: plugin.source,
      status: pluginStatus(plugin),
      enabled: state?.enabled === true,
      errors: plugin.errors.slice(0, 8)
    };
    if (!manifest) return { ...base, name: plugin.id };
    const missing = permissionsApi.missingGrant(manifest, state?.grant);
    const runtime = plugin.runtime;
    return {
      ...base,
      name: localize(manifest.name, locale),
      version: manifest.version,
      description: localize(manifest.description, locale),
      author: manifest.author,
      identityIcon: manifest.identityIcon,
      homepage: manifest.homepage,
      permissions: [...manifest.permissions],
      hosts: [...manifest.network.hosts],
      missing,
      risk: permissionsApi.riskSummary(manifest),
      hasCode: Boolean(manifest.main),
      settings: manifest.settings || null,
      background: {
        supported: Boolean(manifest.background || manifest.alerts.length),
        enabled: state?.background === true
      },
      webDocuments: (manifest.webUi?.documents || []).map(doc => ({ ...doc, ref: `${plugin.id}/${doc.id}` })),
      views: manifest.views.map((view) => ({
        ref: placements.pluginRef(plugin.id, view.id),
        id: view.id,
        title: localize(view.title, locale),
        icon: view.icon,
        surfaces: [...view.surfaces]
      })),
      skins: manifest.skins.map((skin) => ({ id: skin.id, ref: `${plugin.id}/${skin.id}`, name: localize(skin.name, locale), colors: { ...skin.colors }, vendorColors: { ...skin.vendorColors }, ...(skin.appearance ? { appearance: structuredClone(skin.appearance) } : {}) })),
      alerts: manifest.alerts.map((alert) => ({ id: alert.id, title: localize(alert.title, locale) })),
      runtime: manifest.main ? {
        state: runtime.state,
        mode: runtime.mode,
        cpuPercent: runtime.metrics?.cpuPercent ?? null,
        memoryMB: runtime.metrics?.memoryMB ?? null,
        failures: supervisor.failures(plugin.id),
        lastError: runtime.lastError
      } : null,
      settingsIdentity: plugin.settingsIdentity,
      webRevision: runtime.webRevision,
      logs: plugin.logs.slice(-20)
    };
  }

  function authorSettingsAccess(plugin, publicAccess = false) {
    const project = value => publicAccess ? publicSettings(value) : value;
    const schema = plugin?.manifest?.settings;
    const requireStore = () => {
      if (disposed || plugins.get(plugin?.id) !== plugin || !schema || !authorSettings) throw new Error('plugin settings unavailable');
    };
    return {
      get() { requireStore(); return project(authorSettings.get(plugin.id, schema)); },
      update(input) { requireStore(); const result = authorSettings.update(plugin.id, schema, input); notifyAuthorSettings(plugin, result); return project(result); },
      reset(input) { requireStore(); const result = authorSettings.reset(plugin.id, schema, publicAccess ? { schemaVersion: input?.schemaVersion ?? null, revision: input?.expectedRevision } : input); notifyAuthorSettings(plugin, result); return project(result); }
    };
  }
  const authorSettingsListeners = new Set();
  function notifyAuthorSettings(plugin, value) {
    // A failed observer must never turn a committed save into a failed request.
    const observe = fn => { try { fn(); } catch (error) { addLog(plugin, 'warn', `settings observer: ${error.message}`); } };
    observe(() => {
      if (plugin.runtime.mode && isActive(plugin)) sandbox?.send(plugin.id, { type: 'author-settings', value: publicSettings(value) });
    });
    for (const listener of authorSettingsListeners) observe(() => listener(plugin.id, publicSettings(value)));
    observe(emitChanged);
  }

  function writeState(pluginId, patch) {
    const current = states();
    const next = { ...current, [pluginId]: { enabled: false, background: false, grant: { permissions: [], hosts: [] }, ...current[pluginId], ...patch } };
    saveStates(next);
  }

  return {
    webDocument(ref) {
      const [id, docId, extra] = String(ref || '').split('/');
      const plugin = plugins.get(id);
      const document = plugin?.manifest?.webUi?.documents.find(doc => doc.id === docId);
      if (extra || !document || !isActive(plugin) || !permissionsApi.hasPermission(grantOf(plugin), 'ui.web') || (['model', 'tool', 'device'].includes(document.target) && !permissionsApi.hasPermission(grantOf(plugin), 'tm.pages')) || mutating || disposed) throw new Error('web document is unavailable');
      return { pluginId: id, document, manifest: plugin.manifest, dir: plugin.dir, assets: plugin.assets, revision: plugin.runtime.webRevision, locale: getLocale() };
    },
    getAuthorSettings(id) { return authorSettingsAccess(plugins.get(String(id))).get(); },
    getPublicAuthorSettings(id) { return authorSettingsAccess(plugins.get(String(id)), true).get(); },
    updateAuthorSettings(id, input) { return authorSettingsAccess(plugins.get(String(id))).update(input); },
    webAuthorSettings(ref) { return authorSettingsAccess(plugins.get(this.webDocument(ref).pluginId), true); },
    onAuthorSettings(callback) { authorSettingsListeners.add(callback); return () => authorSettingsListeners.delete(callback); },
    webDataAuth(ref) {
      const { pluginId } = this.webDocument(ref);
      return dataAuth(plugins.get(pluginId));
    },
    setWebVisible(owner, ref) {
      if (ref) { this.webDocument(ref); webVisible.set(owner, ref); } else webVisible.delete(owner);
      reconcile();
    },
    webReadAllowed(ref, source) {
      const { pluginId, manifest } = this.webDocument(ref);
      if (source.startsWith('@')) return manifest.metrics.some(metric => source === `@${metric.id}`);
      return permissionsApi.canReadSource(grantOf(plugins.get(pluginId)), source);
    },
    webSource(ref, source) {
      if (!this.webReadAllowed(ref, source)) throw new Error('source permission denied');
      return busId(this.webDocument(ref).pluginId, source);
    },
    webStorage(ref, op, key, value) {
      const { pluginId } = this.webDocument(ref);
      if (!['get', 'set', 'delete'].includes(op)) throw new Error('unsupported storage operation');
      return plugins.get(pluginId).storage[op](key, value);
    },
    reload,
    beginMutation() {
      for (const plugin of plugins.values()) plugin.storage?.flush();
      mutating = true;
      for (const plugin of plugins.values()) stopWorker(plugin, { immediate: true });
    },
    endMutation() { mutating = false; reconcile(); pushAll(); emitChanged(); },
    // Availability only: hot surface composition must not build Settings DTOs.
    surfaceCatalog(surface) {
      if (!SURFACES.includes(surface) || disposed || mutating) return [];
      const locale = getLocale();
      return [...plugins.values()].filter(isActive).flatMap(plugin => plugin.manifest.views
        .filter(view => view.surfaces.includes(surface)).map(view => ({
          ref: placements.pluginRef(plugin.id, view.id), title: localize(view.title, locale), icon: view.icon
        })));
    },
    list() {
      return {
        safeMode,
        enabled: masterEnabled(),
        userDir,
        plugins: [...plugins.values()].map(describe)
      };
    },
    // Enabling records consent for exactly what the manifest asks for now.
    setEnabled(pluginId, enabled) {
      const plugin = plugins.get(pluginId);
      if (!plugin?.manifest) throw new Error('unknown or invalid plugin');
      if (enabled) {
        supervisor.reset(pluginId);
        plugin.runtime.lastError = '';
        writeState(pluginId, { enabled: true, grant: permissionsApi.grantFor(plugin.manifest) });
      } else {
        writeState(pluginId, { enabled: false });
        stopWorker(plugin, { immediate: true });
        plugin.alertStates.clear();
      }
      reconcile();
      pushAll();
      emitChanged();
    },
    setBackground(pluginId, enabled) {
      if (!plugins.get(pluginId)?.manifest) throw new Error('unknown or invalid plugin');
      writeState(pluginId, { background: enabled === true });
      reconcile();
      emitChanged();
    },
    restart(pluginId) {
      const plugin = plugins.get(pluginId);
      if (!plugin) return;
      supervisor.reset(pluginId);
      stopWorker(plugin, { immediate: true });
      plugin.runtime = freshRuntime();
      reconcile();
      pushAll();
      emitChanged();
    },
    // Called whenever settings move (master switch, states, locale).
    settingsChanged() {
      reconcile();
      pushAll();
      // With nothing active, an unrelated patch has no plugin output to repaint.
      if ([...plugins.values()].some(isActive) || currentChangeSignature() !== changeSignature) emitChanged();
    },
    // No active plugin means no consumer for host data; publishers stay idle.
    hasActive() { return !disposed && !mutating && [...plugins.values()].some(isActive); },
    setSurfaceDemand(surface, refs) {
      if (!SURFACES.includes(surface)) return;
      const next = new Set(placements.normalizeRefList(refs, 32));
      const current = surfaceDemand.get(surface);
      const same = next.size === current.size && [...next].every((ref) => current.has(ref));
      if (same) return;
      surfaceDemand.set(surface, next);
      reconcile();
      schedulePush(surface);
    },
    surfaceDemand(surface) {
      return [...(surfaceDemand.get(surface) || [])];
    },
    interact(surface, ref, event, revision) {
      const resolved = resolveRef(ref);
      if (!resolved?.view || !resolved.plugin.manifest.main || !isActive(resolved.plugin) || mutating || disposed) throw new Error('plugin interaction is unavailable');
      const { plugin, view } = resolved, runtime = plugin.runtime;
      if (surface === 'tray' || !view.surfaces.includes(surface) || !surfaceDemand.get(surface)?.has(ref) || runtime.state !== 'running' || !runtime.mode) throw new Error('plugin view is not active on this surface');
      if (revision !== runtime.revision) throw new Error('plugin view changed; try again');
      if (!event || typeof event.action !== 'string') throw new Error('invalid plugin interaction');
      if (!runtime.interactionLimit.take() || runtime.pendingInteractions.size >= 8) throw new Error('plugin is busy; try again');
      const node = findAction(layoutFor(view, surface), event.action);
      const checked = node && validateInteraction(resolverFor(plugin).resolveNode(node), event);
      if (!checked) throw new Error('interaction does not match the declared control');
      const seq = ++runtime.interactionSeq;
      runtime.pendingInteractions.set(seq, now());
      if (!sandbox.send(plugin.id, { type: 'interaction', seq, view: view.id, surface, event: checked })) {
        runtime.pendingInteractions.delete(seq); throw new Error('plugin is unavailable');
      }
      return true;
    },
    payload: payloadFor,
    skins() {
      const locale = getLocale();
      return [...plugins.values()].filter((plugin) => isActive(plugin) && plugin.manifest.skins.length)
        .flatMap((plugin) => plugin.manifest.skins.map((skin) => ({
          id: `${plugin.id}/${skin.id}`,
          ref: `${plugin.id}/${skin.id}`,
          pluginId: plugin.id,
          name: localize(skin.name, locale),
          pluginName: localize(plugin.manifest.name, locale),
          colors: { ...skin.colors },
          vendorColors: { ...skin.vendorColors }, ...(skin.appearance ? { appearance: structuredClone(skin.appearance) } : {})
        })));
    },
    onViews(listener) {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    onChanged(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    handleMessage,
    handleExit,
    // Diagnostics: the bus cadence per source and each plugin's runtime.
    diagnostics() {
      return {
        bus: bus.stats(),
        demands: Object.fromEntries([...appliedDemands.keys()].map((consumer) => [consumer, bus.demandFor(consumer)])),
        plugins: [...plugins.values()].map((plugin) => ({ id: plugin.id, status: pluginStatus(plugin), runtime: plugin.runtime.state, mode: plugin.runtime.mode }))
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeBus();
      for (const timer of pushTimers.values()) clearTimer(timer);
      pushTimers.clear();
      if (metricsTimer) clearTimer(metricsTimer);
      metricsTimer = null;
      for (const plugin of plugins.values()) {
        stopWorker(plugin, { immediate: true });
        try { plugin.storage?.flush(); } catch (error) { log(`[plugins] ${plugin.id} storage flush failed: ${error.message}`); }
      }
      sandbox?.stopAll();
      for (const consumer of appliedDemands.keys()) bus.clearDemand(consumer);
      appliedDemands.clear();
      viewListeners.clear(); changeListeners.clear(); authorSettingsListeners.clear();
    }
  };
}

module.exports = { SURFACES, createPluginManager, normalizePluginStates };
