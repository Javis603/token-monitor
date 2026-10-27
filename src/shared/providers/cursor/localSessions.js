'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { cursorDesktopStateCandidates } = require('./desktopState');
const { resolveSessionMetadata } = require('./sessionMetadata');
const { normalizeTokscaleModelNameForClient } = require('../../history');
const { billingIdentityHash } = require('./billingLedger');
const { hookModelSelection, turnModelEvidence, mergeModelEvidence } = require('./localModels');
const { pricedBillingEntry } = require('./billingItems');

const logCache = new Map();
const tokenKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const turnIdentity = turn => createHash('sha256').update(JSON.stringify([turn.row.sessionId, turn.row.requestId])).digest('hex');

// These are existing Cursor output logs, not installed hooks. Keep only the
// scalar projection: hook inputs can contain prompts, transcripts and emails.
function parseHookLog(source) {
  const rows = [];
  let time = 0;
  const blocks = /^\[([^\]]+)\][^\r\n]*|^INPUT:\r?\n(\{[\s\S]*?^\})\r?\n\r?\nOUTPUT:/gm;
  for (const match of source.matchAll(blocks)) {
    if (match[1]) { time = Date.parse(match[1]); continue; }
    let input;
    try { input = JSON.parse(match[2]); } catch (_) { continue; }
    if (!['beforeSubmitPrompt', 'stop'].includes(input.hook_event_name)
      || !Number.isFinite(time) || time <= 0) continue;
    const sessionId = typeof input.conversation_id === 'string' ? input.conversation_id.trim() : '';
    const requestId = typeof input.generation_id === 'string' ? input.generation_id.trim() : '';
    if (!sessionId || !requestId || sessionId.length > 160 || requestId.length > 160) continue;
    const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
    const projectPath = roots.length === 1 && typeof roots[0] === 'string'
      ? roots[0].replace(/^\/([a-z]:\/)/i, '$1') : '';
    const counters = [input.input_tokens, input.output_tokens, input.cache_read_tokens, input.cache_write_tokens];
    const valid = counters.every(value => Number.isSafeInteger(value) && value >= 0);
    const modelSelection = hookModelSelection(input);
    rows.push({ time, sessionId, requestId, projectPath,
      accountHash: billingIdentityHash(input.user_email),
      event: input.hook_event_name,
      model: normalizeTokscaleModelNameForClient(input.model || input.model_id || '', 'cursor'),
      ...(modelSelection ? { modelSelection } : {}),
      ...(valid ? { counters } : {}) });
  }
  return rows;
}

function children(dir, accept) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(accept).map(entry => path.join(dir, entry.name)); }
  catch (_) { return []; }
}

function hookFiles(options) {
  const roots = cursorDesktopStateCandidates({ home: options.homeDir || os.homedir(),
    platform: options.platform || process.platform, env: options.env || process.env })
    .map(file => path.resolve(path.dirname(file), '../../logs'));
  const files = new Set();
  // Cursor's fixed directory layout bounds traversal; never recurse through
  // workspace contents, extension storage, transcripts, or arbitrary links.
  for (const root of new Set(roots)) {
    for (const run of children(root, entry => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))) {
      for (const window of children(run, entry => entry.isDirectory() && /^window\d/.test(entry.name))) {
        for (const output of children(window, entry => entry.isDirectory() && entry.name.startsWith('output_'))) {
          for (const file of children(output, entry => entry.isFile() && /^cursor\.hooks.*\.log$/.test(entry.name))) files.add(file);
        }
      }
    }
  }
  return files;
}

function readEvents(options) {
  const cache = options.cache || logCache;
  const files = hookFiles(options);
  const runs = new Map();
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > 32 * 1024 * 1024) continue;
      const stamp = `${stat.size}:${stat.mtimeMs}`;
      let cached = cache.get(file);
      if (cached?.stamp !== stamp) {
        cached = { stamp, rows: parseHookLog(fs.readFileSync(file, 'utf8')) };
        cache.set(file, cached);
      }
      const runPath = path.resolve(path.dirname(file), '../..');
      if (!runs.has(runPath)) runs.set(runPath, { path: runPath, rows: [], firstTime: Infinity });
      const run = runs.get(runPath);
      run.rows.push(...cached.rows);
      for (const row of cached.rows) run.firstTime = Math.min(run.firstTime, row.time);
    } catch (_) { /* A growing/rotating log is retried at the next collection. */ }
  }
  for (const file of cache.keys()) if (!files.has(file)) cache.delete(file);
  const profiles = new Map();
  for (const run of runs.values()) {
    if (!run.rows.length) continue;
    const profile = path.dirname(run.path);
    if (!profiles.has(profile)) profiles.set(profile, []);
    profiles.get(profile).push(run);
  }
  const result = [];
  for (const profileRuns of profiles.values()) {
    profileRuns.sort((a, b) => a.firstTime - b.firstTime);
    for (const [i, run] of profileRuns.entries()) {
      // A subsequent run in the same profile proves the old process ended.
      // Do not guess a duration for an unfinished turn in the current run.
      const runEnd = profileRuns[i + 1]?.firstTime || Infinity;
      for (const row of run.rows) result.push({ ...row, run: run.path, runEnd });
    }
  }
  return result;
}

function turnsFromEvents(events, now) {
  const turns = new Map();
  for (const event of events) {
    if (event.time > now) continue;
    const key = `${event.run}:${event.sessionId}:${event.requestId}`;
    const turn = turns.get(key) || {};
    const field = event.event === 'stop' ? 'stop' : 'start';
    if (!turn[field] || event.time >= turn[field].time) turn[field] = event;
    turns.set(key, turn);
  }
  return [...turns.values()].map(turn => ({ ...turn,
    row: turn.stop || turn.start,
    from: turn.start?.time || turn.stop.time,
    to: turn.stop?.time || now,
    bills: [] }));
}

function matchBilling(turns, rows) {
  const claims = new Map();
  for (const turn of turns) {
    const counters = turn.stop?.counters;
    if (!turn.start || !counters || turn.to < turn.from || !turn.row.model) continue;
    if (rows.some(row => row.billingAccountId) && (!turn.start.accountHash || turn.start.accountHash !== turn.stop.accountHash)) continue;
    // This pairing requires both token evidence and a unique local turn. A
    // nearby timestamp by itself is never enough to assign account billing.
    if (turns.some(other => other !== turn && other.row.sessionId !== turn.row.sessionId
      && other.row.model === turn.row.model && other.from <= turn.to && other.to >= turn.from
      && (other.stop || other.row.runEnd > turn.from))) continue;
    const candidates = rows.filter(row => row.model === turn.row.model && row.eventTime >= turn.from && row.eventTime <= turn.to
      && (!row.billingAccountId || (turn.row.accountHash && row.billingEmailHash === turn.row.accountHash)));
    if (!candidates.length) continue;
    const totals = tokenKeys.map(key => candidates.reduce((sum, row) => sum + Number(row[key] || 0), 0));
    // Cursor's turn input counter includes cache hits. The dashboard splits
    // them out; checking every component also rejects incompatible schemas.
    const [input, output, read, write] = counters;
    if (input < read + write || ![input - read - write, output, read, write].every((value, i) => value === totals[i])) continue;
    turn.bills = candidates;
    for (const row of candidates) claims.set(row, (claims.get(row) || 0) + 1);
  }
  for (const turn of turns) if (turn.bills.some(row => claims.get(row) !== 1)) turn.bills = [];
}

function localTurnUsage(turn) {
  const counters = turn.stop?.counters;
  if (!turn.start || !counters || turn.to < turn.from || !turn.start.accountHash
    || turn.start.accountHash !== turn.stop.accountHash) return null;
  const [input, output, read, write] = counters;
  const totalTokens = input + output;
  if (input < read + write || !Number.isSafeInteger(totalTokens)) return null;
  // Cursor copies its TurnEndedUpdate into turnTokenUsage and the stop hook.
  // Input already includes cache. This is an observed local turn total; the
  // selected model alone cannot prove a per-model billing breakdown.
  return { eventTime: turn.to, totalTokens, inputTokens: input - read - write,
    outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write };
}

function readCursorLocalSessions(options = {}) {
  const now = new Date(options.now || Date.now());
  const since = Date.parse(options.allTimeSince || '') || 0;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const month = new Date(today); month.setDate(1);
  const bounds = { today: Math.max(since, +today), month: Math.max(since, +month), allTime: since };
  const view = { sessions: { today: {}, month: {}, allTime: {} }, projects: { today: {}, month: {}, allTime: {} } };
  const turns = turnsFromEvents(readEvents(options), +now);
  const billingRows = options.billingRows || [];
  const localRows = new Map((options.localRows || []).map(row => [row.id, row]));
  const localConflicts = new Set(options.localConflicts || []);
  matchBilling(turns, billingRows);
  for (const turn of turns) {
    const id = turnIdentity(turn);
    if (localConflicts.has(id)) { turn.usage = []; continue; }
    const usage = localTurnUsage(turn);
    const observed = localRows.get(id);
    const local = observed && usage && ['totalTokens', ...tokenKeys].every(key => usage[key] === observed[key]) ? observed : usage;
    turn.usage = billingRows.length ? turn.bills : [local].filter(Boolean);
  }
  const ids = new Set(turns.filter(turn => turn.row.time >= since).map(turn => turn.row.sessionId));
  const metadata = options.metadata || resolveSessionMetadata(ids, { home: options.homeDir,
    now: +now, deps: { env: options.env, platform: options.platform } });
  for (const [name, from] of Object.entries(bounds)) {
    const grouped = new Map();
    for (const turn of turns) {
      const bills = turn.usage.filter(row => row.eventTime >= from && row.eventTime <= +now);
      if (turn.row.time < from && !bills.length) continue;
      const key = `cursor:${turn.row.sessionId}`;
      if (options.periods?.[name]?.sessions?.[key]) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ turn, bills });
    }
    for (const [key, entries] of grouped) {
      const latest = entries.reduce((a, b) => a.turn.row.time > b.turn.row.time ? a : b).turn.row;
      const unknown = entries.some(entry => !entry.turn.usage.length);
      const bills = [...new Set(entries.flatMap(entry => entry.bills))];
      const session = { client: 'cursor', sessionId: latest.sessionId,
        title: metadata.get(latest.sessionId)?.title || '', model: latest.model,
        startedAt: new Date(Math.min(...entries.map(entry => entry.turn.from))).toISOString(),
        lastUsedAt: new Date(latest.time).toISOString(), messageCount: entries.length,
        totalTokens: unknown ? 0 : bills.reduce((sum, row) => sum + row.totalTokens, 0),
        tokenDataUnavailable: unknown || !bills.length, models: {},
        ...(latest.event === 'stop' ? { turnEnded: true } : {}),
        sessionDetailAvailable: false };
      if (!unknown) {
        const priced = bills.map(row => pricedBillingEntry(row, options.pricingByModel));
        const missing = priced.reduce((sum, row) => sum + (row.unpricedTokens || 0), 0);
        const cost = priced.reduce((sum, row) => sum + row.cost, 0);
        if (missing > 0) session.unpricedTokens = missing;
        if (cost > 0) session.cursorEstimatedCostUsd = cost;
      }
      for (const token of tokenKeys) session[token] = unknown ? 0 : bills.reduce((sum, row) => sum + row[token], 0);
      if (!unknown) for (const row of bills) {
        if (row.model) session.models[row.model] = (session.models[row.model] || 0) + row.totalTokens;
      }
      const paths = [...new Set(entries.map(entry => entry.turn.row.projectPath).filter(Boolean))];
      const identities = options.projectsEnabled === false ? [] : paths.map(value => options.projectIdentity?.(value) || {});
      if (identities.length && identities.every(value => value.projectId && value.projectId === identities[0].projectId)) Object.assign(session, identities[0]);
      view.sessions[name][key] = session;
      if (!session.projectId) continue;
      const project = view.projects[name][session.projectId] ||= { projectId: session.projectId, label: session.projectLabel,
        tokens: 0, clients: {}, models: {}, tokenDataUnavailable: false };
      project.tokens += session.totalTokens;
      if (session.cursorEstimatedCostUsd) project.cursorEstimatedCostUsd = (project.cursorEstimatedCostUsd || 0) + session.cursorEstimatedCostUsd;
      if (session.unpricedTokens) project.unpricedTokens = (project.unpricedTokens || 0) + session.unpricedTokens;
      project.clients.cursor = (project.clients.cursor || 0) + session.totalTokens;
      project.tokenDataUnavailable ||= session.tokenDataUnavailable;
      for (const [model, tokens] of Object.entries(session.models)) project.models[model] = (project.models[model] || 0) + tokens;
    }
  }
  return view;
}

function readCursorLocalTurnUsage(options = {}) {
  const now = +new Date(options.now || Date.now());
  const rows = new Map();
  const conflicts = new Set();
  for (const turn of turnsFromEvents(readEvents(options), now)) {
    const id = turnIdentity(turn);
    const usage = localTurnUsage(turn);
    if (turn.start?.accountHash && turn.stop?.accountHash && turn.start.accountHash !== turn.stop.accountHash) conflicts.add(id);
    if (!usage || usage.totalTokens <= 0) continue;
    const row = { id, ...turnModelEvidence(turn), ...usage };
    const previous = rows.get(id);
    if (previous && ['totalTokens', ...tokenKeys].some(key => previous[key] !== row[key])) conflicts.add(id);
    else rows.set(id, { ...row, eventTime: Math.min(previous?.eventTime || row.eventTime, row.eventTime),
      ...mergeModelEvidence(previous, row) });
  }
  return { rows: [...rows.values()].filter(row => !conflicts.has(row.id)), conflicts: [...conflicts] };
}

module.exports = { parseHookLog, readCursorLocalSessions, readCursorLocalTurnUsage };
