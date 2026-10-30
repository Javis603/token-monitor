'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { evaluate } = require('./evaluator.cjs');
const { deliver, deliverTest } = require('./delivery.cjs');
const { createPreferences } = require('./preferences.cjs');

function createBackend({ dataDirectory, host, publish }, { now = Date.now, intervalMs = 5000, preferences = createPreferences(dataDirectory) } = {}) {
  const file = path.join(dataDirectory, 'crossings.json');
  let ledger = { version: 1, policy: null, keys: [] };
  let observations = new Map();
  try {
    ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (ledger.version !== 1 || !Array.isArray(ledger.keys) || ledger.keys.length > 4096
        || ledger.keys.some(k => typeof k !== 'string' || k.length > 512)) throw Error('Invalid alert state');
  } catch (error) { if (error.code !== 'ENOENT') throw Error('Cannot read alert state; monitoring stopped', { cause: error }); }
  let stopped = false, running = null, timer = null, generation = 0, dirty = false, sourceKey, testing = false;
  let controller = new AbortController();
  let status = { state: 'starting', active: [], receipts: [], skipped: 0, background: false };
  const emit = value => { status = { ...status, ...value }; if (!stopped) publish(status); };
  const save = next => {
    if (next.keys.length > 4096) throw Error('Alert state full; monitoring stopped');
    if (JSON.stringify(next) === JSON.stringify(ledger)) return;
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temporary, file);
    ledger = next;
  };
  async function scan() {
    const epoch = generation;
    const current = () => !stopped && epoch === generation;
    const settings = preferences.get();
    if (!current()) return;
    if (settings.status !== 'ready') throw Error('Plugin settings need attention');
    const s = settings.values;
    const appSettings = await host.call('app.settings');
    if (!current()) return;
    const { resolveLocale } = await import('./i18n.mjs');
    if (!current()) return;
    const locale = resolveLocale(appSettings.language === 'auto' ? Intl.DateTimeFormat().resolvedOptions().locale : appSettings.language);
    emit({ locale });
    const policy = createHash('sha256').update(JSON.stringify([s.lowQuota, s.threshold, s.recovery])).digest('hex');
    // Opting into a new delivery policy starts a new alert episode. Appearance
    // alone does not. Persist before delivery for at-most-once attempts.
    const alerted = new Set(ledger.policy === policy ? ledger.keys : []);
    if (!s.lowQuota && !s.recovery) {
      observations.clear();
      save({ version: 1, policy, keys: [] });
      emit({ state: 'off', settings: s, active: [], receipts: [], skipped: 0 }); return;
    }
    let cursor, envelope, rows = [];
    for (let page = 0; page < 20; page++) {
      envelope = await host.call('data.query', { resource: 'limits', period: 'today', page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      if (!current()) return;
      // Envelope freshness follows usage collection; quota rows carry their own
      // observation timestamps, checked by the evaluator even when usage is idle.
      if (envelope.availability !== 'available'
          || envelope.aggregateCoverage?.kind !== 'authorizedCollection') {
        emit({ state: 'unavailable', settings: s, active: [], skipped: 0 }); return;
      }
      rows.push(...envelope.rows);
      if (!envelope.pageInfo.hasMore) break;
      cursor = envelope.pageInfo.nextCursor;
      if (!cursor || page === 19) throw Error('Quota snapshot exceeds plugin scan budget');
    }
    const nextObservations = ledger.policy === policy ? new Map(observations) : new Map();
    const result = evaluate(rows, s.threshold, alerted, now(), nextObservations);
    if (nextObservations.size > 4096) throw Error('Recovery state full; monitoring stopped');
    if (!current()) return;
    save({ version: 1, policy, keys: [...alerted] });
    observations = nextObservations;
    const notifications = result.triggered.filter(alert => alert.event === 'low' ? s.lowQuota : s.recovery);
    emit({ state: 'monitoring', settings: s, active: result.active, skipped: result.skipped,
      checkedAt: new Date(now()).toISOString(), receipts: notifications.length ? [] : status.receipts });
    const receipts = [];
    for (const alert of notifications) {
      if (!current()) return;
      receipts.push(...(await deliver(alert, s, { host, signal: controller.signal, now: now(), locale }))
        .map(r => ({ ...r, provider: alert.provider, providerLabel: alert.providerLabel, event: alert.event })));
    }
    if (current() && notifications.length) emit({ receipts: receipts.slice(-20) });
  }
  function refresh() {
    if (stopped) return Promise.resolve(status);
    if (running) { dirty = true; return running; }
    clearTimeout(timer);
    running = (async () => {
      do {
        dirty = false;
        try { await scan(); }
        catch (_) { emit({ state: 'error', active: [], error: 'Monitoring paused: check data, settings or plugin storage.' }); }
      } while (dirty && !stopped);
      return status;
    })().finally(() => {
      running = null;
      if (!stopped && intervalMs > 0) timer = setTimeout(refresh, intervalMs);
    });
    return running;
  }
  return {
    call(method, args) {
      if (method === 'status') return status;
      if (method === 'notification.test') {
        if (stopped || testing) throw Error('Notification test unavailable');
        testing = true;
        return (async () => {
          try {
            const appSettings = await host.call('app.settings');
            const { resolveLocale } = await import('./i18n.mjs');
            const locale = resolveLocale(appSettings.language === 'auto' ? Intl.DateTimeFormat().resolvedOptions().locale : appSettings.language);
            return await deliverTest({ host, signal: controller.signal, now: now(), locale });
          } finally { testing = false; }
        })();
      }
      if (method === 'preferences.get') return preferences.get();
      if (method === 'preferences.update') {
        const saved = preferences.update(args);
        generation++; controller.abort(); controller = new AbortController();
        emit({ state: saved.values.lowQuota || saved.values.recovery ? 'starting' : 'off', active: [], settings: saved.values });
        return refresh().then(() => saved);
      }
      if (method === 'refresh') return refresh();
      throw Error('Unknown quota-alerts operation');
    },
    update(context) {
      // The host replays context during ordinary data/demand updates. Those
      // are not a transition in this plugin's monitoring state.
      if (typeof context.background === 'boolean' && context.background !== status.background) emit({ background: context.background });
      const nextSource = JSON.stringify([context.source, context.mode, context.hubMode, context.hubUrl, context.deviceId]);
      if (nextSource === sourceKey && !context.settings) return;
      if (sourceKey !== undefined && nextSource !== sourceKey) {
        observations.clear();
        emit({ active: [], receipts: [], skipped: 0, state: preferences.get().values.lowQuota || preferences.get().values.recovery ? 'starting' : 'off' });
      }
      sourceKey = nextSource;
      generation++; controller.abort(); controller = new AbortController();
      return refresh();
    },
    async dispose() {
      stopped = true; generation++; controller.abort(); clearTimeout(timer);
      await running;
    },
    start: refresh
  };
}

exports.activate = context => {
  const backend = createBackend(context);
  void backend.start();
  return backend;
};
exports.createBackend = createBackend;
