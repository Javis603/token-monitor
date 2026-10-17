'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// The same archive/SQLite inputs can be replayed against pinned repository trees.
// No collector, scanner, provider, subprocess or user data is involved.
function runRecoveryScenario(root, scenario) {
  const { normalizePeriod, extractUsageFromTokscale } = require(path.join(root, 'src/shared/usage.js'));
  const { captureDailyHistoryArchive, captureLiveDailyHistory } = require(path.join(root, 'src/shared/dailyHistoryArchive.js'));
  const { createUsageTransform } = require(path.join(root, 'src/shared/usage/usageTransform.js'));
  const { createSessionUsageArchiveStore, readSessionUsageArchiveSnapshot } = require(path.join(root, 'src/shared/usage/sessionUsageArchiveStore.js'));
  const sessionApi = require(path.join(root, 'src/shared/usage/sessionUsageArchive.js'));
  const historyApi = require(path.join(root, 'src/shared/dailyHistoryArchive.js'));
  const clientApi = require(path.join(root, 'src/shared/usage/clientUsageArchive.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-history-recovery-'));
  const storeOptions = { databasePath: path.join(dir, 'sessions.sqlite'), path: path.join(dir, 'legacy.json') };
  const historyPath = path.join(dir, 'daily.json');
  const day = '2026-07-09';
  let stamp = 0;
  let daily = {};
  let settings = { projectsEnabled: false };
  let store = createSessionUsageArchiveStore(storeOptions);
  const makeTransform = () => createUsageTransform({ store, dailyHistoryArchive: { path: historyPath },
    getSettings: () => settings, log: () => {} });
  let transform = makeTransform();
  const snapshot = () => store.snapshot ? store.snapshot() : store.read(new Date(`${day}T12:30:00Z`));
  let headless;
  const headlessProject = (input, dryRun = false) => {
    if (!headless || dryRun) {
      const source = fs.readFileSync(path.join(root, 'src/agent/agent.js'), 'utf8');
      const start = source.indexOf('function summaryWithSessionUsageArchive(');
      const body = source.slice(start, source.indexOf('\n}\n', start) + 3);
      const context = { ...sessionApi, allTimeSince: settings.allTimeSince, sessionUsageArchiveEnabled: settings.sessionUsageArchiveEnabled !== false,
        projectsEnabled: false, dryRun, sessionUsageArchive: undefined, sessionUsageArchiveStore: store, cursorUsageEvents: undefined,
        readSessionUsageArchiveSnapshot: () => readSessionUsageArchiveSnapshot(storeOptions),
        applyDailyHistoryAllTimeFloor: clientApi.applyDailyHistoryAllTimeFloor,
        loadDailyHistoryFloor: allTimeSince => historyApi.allTimeCumulativeFromArchive(daily, { allTimeSince }), console: { error() {} } };
      vm.runInNewContext(body, context);
      if (dryRun) return context.summaryWithSessionUsageArchive(input);
      headless = context.summaryWithSessionUsageArchive;
    }
    return headless(input);
  };
  const row = (tokens, model = 'opus', cost = tokens / 100, client = 'claude', id = 'one') => ({ tokens, model, cost, client, id });
  const period = rows => {
    const input = { totalTokens: 0, costUsd: 0, clients: {}, clientCosts: {}, models: {}, modelCosts: {},
      clientModels: {}, clientModelCosts: {}, sessions: {} };
    for (const r of rows) {
      input.totalTokens += r.tokens;
      input.costUsd += r.cost;
      input.clients[r.client] = (input.clients[r.client] || 0) + r.tokens;
      input.clientCosts[r.client] = (input.clientCosts[r.client] || 0) + r.cost;
      input.models[r.model] = (input.models[r.model] || 0) + r.tokens;
      input.modelCosts[r.model] = (input.modelCosts[r.model] || 0) + r.cost;
      const models = input.clientModels[r.client] ||= {};
      models[r.model] = (models[r.model] || 0) + r.tokens;
      const costs = input.clientModelCosts[r.client] ||= {};
      costs[r.model] = (costs[r.model] || 0) + r.cost;
      input.sessions[`${r.client}:${r.id}`] = { client: r.client, sessionId: r.id,
        totalTokens: r.tokens, costUsd: r.cost, models: { [r.model]: r.tokens }, modelCosts: { [r.model]: r.cost } };
    }
    return normalizePeriod(input);
  };
  const writeDaily = () => {
    fs.writeFileSync(historyPath, JSON.stringify(daily));
    fs.utimesSync(historyPath, 1000 + stamp, 1000 + stamp);
    stamp += 1;
  };
  const seed = rows => {
    daily = captureDailyHistoryArchive(daily, { contributions: rows.map(r => ({ date: r.date || '2026-06-07', clients: [{
      client: r.client, modelId: r.model, tokens: { input: r.tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: r.cost, messages: 1
    }] })) });
    writeDaily();
  };
  const record = rows => ({ updatedAt: `${day}T12:00:${String(stamp).padStart(2, '0')}.000Z`,
    today: period(rows), month: period(rows), allTime: period(rows), sessionUsageArchiveFullScan: true });
  const collect = (rows, options = {}) => {
    const input = record(rows);
    if (options.scanned) {
      const scanned = extractUsageFromTokscale({ entries: rows.map(r => ({
        client: r.client, sessionId: r.id, model: r.model, input: r.tokens, output: 0, cost: r.cost
      })) });
      for (const name of ['today', 'month', 'allTime']) input[name] = structuredClone(scanned);
    }
    if (options.captureDaily !== false) {
      daily = captureLiveDailyHistory(daily, input.today, { todayKey: day });
      writeDaily();
    }
    return scenario.startsWith('headless') ? headlessProject(input)
      : transform.transform(input, 'fixture', options.preview ? { preview: true } : {});
  };
  const result = visible => ({ tokens: visible.allTime.totalTokens, cost: visible.allTime.costUsd,
    models: { ...visible.allTime.models }, clientModels: visible.allTime.clientModels });
  const graphResult = () => {
    const { parseGraphResult } = require(path.join(root, 'src/shared/history.js'));
    const graph = parseGraphResult(historyApi.graphFromDailyHistoryArchive([], daily, { todayKey: day }));
    return { tokens: graph.contributions.reduce((sum, r) => sum + r.tokens, 0),
      cost: graph.contributions.reduce((sum, r) => sum + r.cost, 0),
      models: Object.assign({}, ...graph.contributions.map(r => Object.fromEntries(
        Object.entries(r.perModel).map(([model, value]) => [model, value.tokens])))) };
  };
  const reopen = () => { if (transform.release) transform.release(); else store.close(); store = createSessionUsageArchiveStore(storeOptions); transform = makeTransform(); headless = undefined; };
  const seedLegacySessions = rows => {
    const sessions = {};
    for (const [key, session] of Object.entries(period(rows).sessions)) {
      sessions[key] = { client: session.client, sessionId: session.sessionId,
        capturedAt: `${day}T11:00:00Z`, periods: { allTime: session } };
    }
    fs.writeFileSync(storeOptions.path, JSON.stringify({ version: 1, sessions }));
  };
  try {
    switch (scenario) {
      case 'graph-rename':
      case 'headless-graph-rename':
      case 'graph-daily-only':
      case 'graph-full-rename': {
        seed([row(100, 'old-model', 1, 'claude', 'one')].concat(scenario === 'graph-full-rename'
          ? [row(120, 'new-model', 1.2, 'claude', 'one')] : []).map(r => ({ ...r, date: day })));
        if (scenario !== 'graph-daily-only') collect([row(100, 'old-model')], { scanned: true });
        const visible = result(collect([row(120, 'new-model')], { scanned: true }));
        const graph = graphResult();
        const observedModels = snapshot().sessions['claude:one'].observedModels;
        reopen();
        const absent = result(collect([], { captureDaily: false, scanned: true }));
        return { visible, graph, absent, graphAfterReopen: graphResult(), observedModels };
      }
      case 'legacy':
      case 'legacy-profile':
      case 'headless-legacy-profile':
      case 'legacy-profile-preview': {
        const june = [7, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 22, 24, 25, 28, 29];
        const july = [1, 2, 3, 7];
        const rows = [];
        for (const [month, days, total] of [[6, june, 182676412], [7, july, 51436260]]) {
          days.forEach((date, i) => rows.push({ ...row(Math.floor(total / days.length) + (i === 0 ? total % days.length : 0), 'claude-opus-4-8', 0),
            date: `2026-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}` }));
        }
        seed(rows);
        // Reconstruct the reporter's archive shape, not their private profile:
        // 2,859 legacy sessions with no model-history fields and no target model.
        const oldRows = scenario === 'legacy' ? []
          : Array.from({ length: 2859 }, (_, i) => row(1, 'sonnet', 0, 'claude', `old-${i}`));
        if (oldRows.length) seedLegacySessions(oldRows);
        const before = JSON.stringify(readSessionUsageArchiveSnapshot(storeOptions));
        const visible = collect([row(20, 'sonnet')], { captureDaily: false,
          preview: scenario === 'legacy-profile-preview' });
        const again = transform.project(visible, snapshot(), new Date(visible.updatedAt));
        const after = readSessionUsageArchiveSnapshot(storeOptions);
        let absent;
        if (scenario !== 'legacy-profile-preview') {
          reopen();
          absent = result(collect([], { captureDaily: false }));
        }
        return { first: result(visible), repeated: result(again), dailyDays: Object.keys(daily.days).length,
          legacySessions: oldRows.length, archiveUnchanged: JSON.stringify(after) === before, absent };
      }
      case 'headless-corrections':
      case 'corrections': {
        const states = [100, 20, 0].map(tokens => result(collect([row(tokens)])));
        reopen();
        const committed = snapshot().sessions['claude:one'].periods.allTime.totalTokens;
        states.push(result(collect([], { captureDaily: false })));
        return { states, committed };
      }
      case 'rename': {
        collect([row(100, 'old-model')]);
        const renamed = result(collect([row(100, 'new-model')], { captureDaily: false }));
        reopen();
        const omitted = collect([], { captureDaily: false });
        const absent = result(omitted);
        return { renamed, absent, leaksLocalCoverage: JSON.stringify(omitted).includes('"observedModels"'), observedModels: snapshot().sessions['claude:one'].observedModels };
      }
      case 'repricing': {
        collect([row(100, 'opus', 10)]);
        const lower = result(collect([row(120, 'opus', 1)], { captureDaily: false }));
        const free = result(collect([row(120, 'opus', 0)], { captureDaily: false }));
        reopen();
        return { lower, free, absent: result(collect([], { captureDaily: false })) };
      }
      case 'partial': {
        seed([row(1000, 'opus', 10)]);
        return result(collect([row(400, 'opus', 2)], { captureDaily: false }));
      }
      case 'unknown': {
        seed([row(100)]);
        return result(collect([row(50, 'unknown')], { captureDaily: false }));
      }
      case 'cost-only': {
        seed([row(0, 'retired-billing', 5)]);
        return result(collect([row(20, 'sonnet', 1)], { captureDaily: false }));
      }
      case 'disabled': {
        seed([row(100)]);
        settings = { ...settings, sessionUsageArchiveEnabled: false };
        return result(collect([row(20, 'sonnet')], { captureDaily: false }));
      }
      case 'codex-owned':
      case 'codex-native':
      case 'headless-codex-native': {
        seed([row(100, 'gpt', 1, 'codex')]);
        return result(collect([], { captureDaily: false }));
      }
      case 'codex-with-dots':
      case 'codex-with-known-dots':
      case 'codex-preview-zero': {
        seed([row(100, 'retired-native', 1, 'codex')]);
        const rows = [row(50, scenario === 'codex-with-dots' ? 'unknown' : 'retired-native', 0, 'codex', 'dots')];
        if (scenario === 'codex-preview-zero') rows.push(row(0, 'retired-native', 0, 'codex', 'native'));
        const input = record(rows);
        input.codexLocalSessionKeys = ['codex:dots'];
        for (const name of ['today', 'month', 'allTime']) {
          input[name].sessions['codex:dots'].usageSource = 'codex-dots-local';
        }
        const before = JSON.stringify(snapshot());
        const projected = transform.transform(input, 'fixture', { preview: scenario === 'codex-preview-zero' });
        const visible = result(projected);
        const repeated = result(transform.project(projected, snapshot(), new Date(input.updatedAt)));
        const archiveUnchanged = JSON.stringify(snapshot()) === before;
        if (scenario === 'codex-preview-zero') return { visible, repeated, archiveUnchanged };
        const hidden = result(collect([], { captureDaily: false }));
        reopen();
        return { visible, hidden, repeated, reopened: result(collect([], { captureDaily: false })) };
      }
      case 'alias': {
        collect([row(100, 'mimo-model', 1, 'micode')]);
        const zero = result(collect([row(0, 'mimo-model', 0, 'mimo')]));
        reopen();
        return { zero, absent: result(collect([], { captureDaily: false })) };
      }
      case 'stale-capture': {
        collect([row(20, 'current-model')]);
        const stale = record([row(100, 'old-model')]);
        stale.updatedAt = `${day}T11:00:00Z`;
        store.capture(stale, new Date(stale.updatedAt));
        seed([row(100, 'old-model')]);
        reopen();
        return { visible: result(collect([], { captureDaily: false })),
          observedModels: snapshot().sessions['claude:one'].observedModels };
      }
      case 'unknown-upgrade': {
        collect([row(50, 'unknown')]);
        collect([row(50, 'sonnet')]);
        seed([row(100, 'opus')]);
        reopen();
        return result(collect([], { captureDaily: false }));
      }
      case 'unknown-client-zero': {
        collect([row(100, 'opus', 1, 'unknown')]);
        collect([row(0, 'opus', 0, 'unknown')]);
        seed([row(100, 'opus')]);
        reopen();
        return result(collect([], { captureDaily: false }));
      }
      case 'cross-client-unknown': {
        seed([row(100, 'opus')]);
        return result(collect([row(50, 'unknown', 1, 'unknown')], { captureDaily: false }));
      }
      case 'legacy-session': {
        seed([row(100)]);
        seedLegacySessions([row(20, 'sonnet')]);
        return result(collect([row(20, 'sonnet')], { captureDaily: false }));
      }
      case 'legacy-rename':
      case 'legacy-zero':
      case 'legacy-repricing':
      case 'legacy-unknown': {
        seed([row(100, 'opus', 10)]);
        seedLegacySessions([row(100, scenario === 'legacy-unknown' ? 'unknown' : 'opus', 10)]);
        const next = scenario === 'legacy-rename' || scenario === 'legacy-unknown' ? row(20, 'sonnet', 1)
          : scenario === 'legacy-zero' ? row(0, 'opus', 0)
            : row(120, 'opus', 1);
        const first = result(collect([next], { captureDaily: false }));
        reopen();
        return { first, absent: result(collect([], { captureDaily: false })) };
      }
      case 'dry-run': {
        collect([row(100)]);
        const before = JSON.stringify(snapshot());
        const visible = headlessProject(record([row(20)]), true);
        return { visible: result(visible), archiveUnchanged: JSON.stringify(snapshot()) === before };
      }
      case 'preview': {
        collect([row(100)]);
        const before = JSON.stringify(snapshot());
        const visible = collect([row(20)], { captureDaily: false, preview: true });
        return { visible: result(visible), archiveUnchanged: JSON.stringify(snapshot()) === before };
      }
      default: throw new Error(`Unknown fixture: ${scenario}`);
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runRecoveryScenario };
