'use strict';

// Protocol approach adapted from PlanMeter (MIT), pinned at 6052afd.
// See docs/licenses/planmeter.txt. No transcript content belongs in this DTO.
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'netNewInputTokens'];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function error(code) { const e = new Error(code); e.code = code; return e; }
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function identifier(v) { if (typeof v !== 'string' || !ID.test(v)) throw error('INVALID_ID'); return v; }
function optionalId(v) { return v == null ? null : identifier(v); }
function label(v) { return typeof v === 'string' && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v) ? v : null; }
function count(v) { if (v == null) return null; if (!Number.isSafeInteger(v) || v < 0) throw error('INVALID_COUNT'); return v; }
function add(a, b) { const n = a + b; if (!Number.isSafeInteger(n)) throw error('COUNT_OVERFLOW'); return n; }
function timestamp(v, now) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > now / 1000 + 300) throw error('INVALID_TIME');
  return new Date(v * 1000).toISOString();
}
function page(raw) {
  if (!object(raw) || !Array.isArray(raw.data) || raw.data.length > 100) throw error('INVALID_PAGE');
  const cursor = raw.nextCursor;
  if (cursor != null && (typeof cursor !== 'string' || !cursor || cursor.length > 4096)) throw error('INVALID_CURSOR');
  return { data: raw.data, cursor: cursor ?? null };
}
function reference(raw, now = Date.now()) {
  if (!object(raw)) throw error('INVALID_THREAD');
  const src = raw.source;
  const spawn = object(src) && (src.subAgent || src.subagent);
  const parent = spawn && (spawn.thread_spawn || spawn.threadSpawn);
  return { threadId: identifier(raw.id), engineParentId: optionalId(raw.parentThreadId ?? parent?.parent_thread_id ?? parent?.parentThreadId),
    delegationParentId: null, dotId: null, kind: label(raw.threadSource) || (spawn ? 'subagent' : null),
    updatedAt: timestamp(raw.updatedAt, now), origin: 'cloud', metadataSource: 'cloud-rpc', bindingEvidence: null };
}
function turnPage(raw, ref, now = Date.now()) {
  const p = page(raw); const seen = new Set();
  const turns = p.data.map((row) => {
    if (!object(row)) throw error('INVALID_TURN');
    const turnId = identifier(row.id); if (seen.has(turnId)) throw error('DUPLICATE_TURN'); seen.add(turnId);
    const startedAt = timestamp(row.startedAt, now), completedAt = timestamp(row.completedAt, now);
    if (startedAt && completedAt && completedAt < startedAt) throw error('INVALID_TIME_ORDER');
    return { threadId: ref.threadId, turnId, startedAt, completedAt, dateBasis: completedAt ? 'completion' : startedAt ? 'start' : 'unknown',
      observedDate: (completedAt || startedAt)?.slice(0, 10) || null, status: label(row.status), model: null,
      tokens: null, estimatedUsdMicros: null, estimatedCreditsMicros: null, responseIds: null, usageStatus: 'unavailable' };
  });
  return { turns, cursor: p.cursor };
}
function estimates(raw, turns) {
  if (!object(raw) || !Array.isArray(raw.threads) || raw.threads.length > turns.length) throw error('INVALID_ESTIMATES');
  const key = (t) => `${t.threadId}:${t.turnId}`;
  const expected = new Map(turns.map((t) => [key(t), { ...t }]));
  if (expected.size !== turns.length) throw error('DUPLICATE_INPUT_TURN');
  const seenThreads = new Set(), seen = new Set();
  for (const thread of raw.threads) {
    if (!object(thread)) throw error('INVALID_ESTIMATES');
    const id = identifier(thread.thread_id);
    if (seenThreads.has(id) || !turns.some((t) => t.threadId === id) || !Array.isArray(thread.turns) || thread.turns.length > turns.length) throw error('UNEXPECTED_THREAD');
    seenThreads.add(id);
    for (const row of thread.turns) {
      if (!object(row)) throw error('INVALID_ESTIMATES');
      const k = `${id}:${identifier(row.turn_id)}`, prev = expected.get(k);
      if (!prev || seen.has(k)) throw error('UNEXPECTED_TURN'); seen.add(k);
      const tokens = {};
      for (const [camel, snake] of [['inputTokens', 'input_tokens'], ['cachedInputTokens', 'cached_input_tokens'],
        ['outputTokens', 'output_tokens'], ['totalTokens', 'total_tokens'], ['netNewInputTokens', 'net_new_input_tokens']]) tokens[camel] = count(row[snake]);
      const { inputTokens: i, cachedInputTokens: c, outputTokens: o, totalTokens: total, netNewInputTokens: n } = tokens;
      if (i !== null && c !== null && c > i) throw error('INVALID_SUBSET');
      if (i !== null && c !== null && n !== null && add(n, c) !== i) throw error('INVALID_SUBSET');
      if (i !== null && o !== null && total !== null && add(i, o) !== total) throw error('INVALID_TOTAL');
      let responseIds = null;
      if (row.settled_response_ids != null) {
        const ids = row.settled_response_ids;
        if (!Array.isArray(ids) || ids.length > 10000 || ids.some((r) => typeof r !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(r)) || new Set(ids).size !== ids.length) throw error('INVALID_RESPONSE_IDS');
        responseIds = ids;
      }
      expected.set(k, { ...prev, model: label(row.model), tokens: TOKEN_FIELDS.some((f) => tokens[f] !== null) ? tokens : null,
        estimatedUsdMicros: count(row.estimated_usage_usd_micros), estimatedCreditsMicros: count(row.estimated_usage_credits_micros),
        responseIds, usageStatus: total === null ? 'partial' : 'service-estimate' });
    }
  }
  return turns.map((t) => expected.get(key(t)));
}
function decimal(v, nonnegative = true) {
  if (v == null) return null;
  if (typeof v !== 'number' && typeof v !== 'string') throw error('INVALID_DECIMAL');
  if (typeof v === 'string' && (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v) || v.length > 100)) throw error('INVALID_DECIMAL');
  const n = Number(v); if (!Number.isFinite(n) || (nonnegative && n < 0)) throw error('INVALID_DECIMAL'); return n;
}
function quotas(raw, refs) {
  if (!object(raw) || !Array.isArray(raw.threads) || raw.threads.length > refs.length) throw error('INVALID_QUOTAS');
  const known = new Set(refs.map((r) => r.threadId)), seen = new Set();
  return raw.threads.map((r) => {
    if (!object(r) || !known.has(r.thread_id) || seen.has(r.thread_id)) throw error('UNEXPECTED_THREAD'); seen.add(r.thread_id);
    const balance = r.balance_usage_credits;
    if (balance != null) { if (typeof balance !== 'string') throw error('INVALID_DECIMAL'); decimal(balance, false); }
    return { threadId: r.thread_id, weeklyLimitPercent: decimal(r.weekly_limit_percent), fiveHourLimitPercent: decimal(r.five_hour_limit_percent),
      purchasedCredits: balance ?? null, dataStatus: label(r.data_status), usageSource: label(r.usage_source), measurement: 'quota-not-tokens' };
  });
}
function summary(turns) {
  const refs = new Map(); const blocked = new Set(); let withTokens = 0;
  for (const t of turns) {
    const k = `${t.threadId}:${t.turnId}`;
    if (t.tokens?.totalTokens == null) continue; withTokens += 1;
    if (t.tokens.totalTokens > 0 && !t.responseIds?.length) blocked.add(k);
    for (const r of t.responseIds || []) { if (refs.has(r) && refs.get(r) !== k) { blocked.add(k); blocked.add(refs.get(r)); } else refs.set(r, k); }
  }
  let sum = 0, eligible = 0;
  for (const t of turns) if (t.tokens?.totalTokens != null && !blocked.has(`${t.threadId}:${t.turnId}`)) { sum = add(sum, t.tokens.totalTokens); eligible += 1; }
  return { turns: turns.length, tokenTurns: withTokens, missingTokenTurns: turns.length - withTokens, safelyAggregatedTurns: eligible,
    settlementUnverifiedTurns: blocked.size, observedSettledTokens: eligible ? sum : null,
    fullTaskTokens: turns.length > 0 && eligible === turns.length ? sum : null };
}
function code(e) { return typeof e?.code === 'string' && /^[A-Z_]{1,80}$/.test(e.code) ? e.code : 'READ_FAILED'; }
function limit(v, d, min, max) { const n = v ?? d; if (!Number.isInteger(n) || n < min || n > max) throw error('INVALID_LIMIT'); return n; }
async function collectCloudUsage(rpc, options = {}) {
  const now = options.now ?? Date.now();
  const maxThreads = limit(options.maxThreads, 40, 1, 100), maxTurns = limit(options.maxTurns, 1000, 1, 3000), maxPages = limit(options.maxPages, 3, 1, 20);
  const roots = [...new Set((options.threadIds || []).map(identifier))];
  if (!roots.length && !options.discover) throw error('SELECT_THREAD_OR_DISCOVER');
  if (roots.length > maxThreads) throw error('THREAD_LIMIT');
  const diagnostics = []; const refs = new Map(); let inventoryComplete = true;
  const check = () => { if (options.signal?.aborted) throw error('ABORTED'); rpc.assertIdentity?.(); };
  const put = (r) => {
    if (!refs.has(r.threadId) && refs.size >= maxThreads) { inventoryComplete = false; return; }
    const prior = refs.get(r.threadId);
    if (prior && prior.engineParentId && r.engineParentId && prior.engineParentId !== r.engineParentId) throw error('PARENT_CONFLICT');
    refs.set(r.threadId, { ...prior, ...r, engineParentId: r.engineParentId || prior?.engineParentId || null,
      delegationParentId: prior?.delegationParentId || r.delegationParentId || null, dotId: prior?.dotId || r.dotId || null,
      bindingEvidence: prior?.bindingEvidence || r.bindingEvidence || null });
  };
  for (const id of roots) put({ threadId: id, engineParentId: null, delegationParentId: null, dotId: null, kind: null, origin: 'cloud', metadataSource: 'explicit-id' });
  const seeds = options.seedReferences || [];
  for (const r of seeds) if (roots.includes(r.threadId) || options.discover) put(r);
  if (options.discover) {
    // Null-source Aeon threads can be omitted by explicit sourceKinds.
    for (const archived of [false, true]) for (const filtered of [false, true]) {
      let cursor = null; const seen = new Set(); let done = false;
      try {
        for (let n = 0; n < maxPages; n += 1) {
          check();
          const params = { limit: 100, sortKey: 'updated_at', sortDirection: 'desc', archived };
          if (filtered) params.sourceKinds = SOURCE_KINDS;
          if (cursor) params.cursor = cursor;
          const p = page(await rpc.request('thread/list', params));
          for (const raw of p.data) put(reference(raw, now));
          if (!p.cursor) { done = true; break; }
          if (seen.has(p.cursor)) throw error('REPEATED_CURSOR'); seen.add(p.cursor); cursor = p.cursor;
        }
      } catch (e) { diagnostics.push({ stage: 'inventory', code: code(e) }); }
      if (!done) inventoryComplete = false;
    }
  }
  for (const id of roots) {
    try { check(); const r = await rpc.request('thread/read', { threadId: id, includeTurns: false }); if (r?.thread?.id !== id) throw error('THREAD_MISMATCH'); put(reference(r.thread, now)); }
    catch (e) { diagnostics.push({ stage: 'metadata', threadId: id, code: code(e) }); }
  }
  if (options.includeDescendants) {
    let changed = true;
    while (changed) { changed = false; for (const r of seeds) if (!refs.has(r.threadId) && (refs.has(r.engineParentId) || refs.has(r.delegationParentId)) && refs.size < maxThreads) { put(r); changed = true; } }
    // Cached descendants are known membership only, not complete discovery.
    inventoryComplete = false;
  }
  const turnsByKey = new Map(); const histories = []; let historyComplete = true;
  for (const r of refs.values()) {
    let cursor = null, complete = false, available = false; const cursors = new Set(); let turnCount = 0;
    try {
      for (let n = 0; n < maxPages; n += 1) {
        check(); if (turnsByKey.size >= maxTurns) throw error('TURN_LIMIT');
        const params = { threadId: r.threadId, limit: Math.min(100, maxTurns - turnsByKey.size), sortDirection: 'desc', itemsView: 'notLoaded' };
        if (cursor) params.cursor = cursor;
        const p = turnPage(await rpc.request('thread/turns/list', params), r, now); available = true;
        for (const t of p.turns) {
          const k = `${t.threadId}:${t.turnId}`, old = turnsByKey.get(k);
          if (old && (old.startedAt !== t.startedAt || old.completedAt !== t.completedAt)) throw error('HISTORY_CHANGED');
          if (!old) { if (turnsByKey.size >= maxTurns) throw error('TURN_LIMIT'); turnsByKey.set(k, t); turnCount += 1; }
        }
        if (!p.cursor) { complete = true; break; }
        if (cursors.has(p.cursor)) throw error('REPEATED_CURSOR'); cursors.add(p.cursor); cursor = p.cursor;
      }
    } catch (e) { diagnostics.push({ stage: 'history', threadId: r.threadId, code: code(e) }); }
    if (!complete) historyComplete = false;
    histories.push({ ...r, historyStatus: !available ? 'unavailable' : complete ? 'available' : 'partial', turnCount });
  }
  let turns = [...turnsByKey.values()]; let usageAccess = turns.length ? 'available' : 'not-requested';
  for (let n = 0; n < turns.length; n += 100) {
    const batch = turns.slice(n, n + 100); const grouped = new Map();
    for (const t of batch) { if (!grouped.has(t.threadId)) grouped.set(t.threadId, []); grouped.get(t.threadId).push(t.turnId); }
    try {
      check(); const body = { threads: [...grouped].map(([thread_id, turn_ids]) => ({ thread_id, turn_ids })), include_settled_response_ids: true };
      const measured = estimates(await rpc.estimates(body), batch); turns.splice(n, batch.length, ...measured);
    } catch (e) {
      usageAccess = code(e); diagnostics.push({ stage: 'turn-usage', code: code(e) });
      if (['FORBIDDEN', 'UNAUTHORIZED', 'RATE_LIMITED', 'DEADLINE', 'LOGIN_CHANGED', 'ABORTED'].includes(code(e))) break;
    }
  }
  let quotaRows = [], quotaAccess = 'not-requested';
  if (options.quotas && refs.size && !['UNAUTHORIZED', 'RATE_LIMITED'].includes(usageAccess)) {
    try { check(); quotaRows = quotas(await rpc.quotas({ threads: [...refs.keys()].map((thread_id) => ({ thread_id, created_at: null, descendant_thread_ids: [] })) }), [...refs.values()]); quotaAccess = 'available'; }
    catch (e) { quotaAccess = code(e); diagnostics.push({ stage: 'quotas', code: code(e) }); }
  }
  if (options.signal?.aborted) throw error('ABORTED');
  // Deadline exhaustion may leave useful history; identity changes may not.
  if (rpc.verifyIdentity) rpc.verifyIdentity();
  else { try { check(); } catch (e) { if (code(e) !== 'DEADLINE') throw e; diagnostics.push({ stage: 'deadline', code: 'DEADLINE' }); } }
  const totals = summary(turns);
  // A selected scope may be complete, but not the full cloud account or future turns.
  const status = histories.every((h) => h.historyStatus === 'unavailable') ? 'unavailable' :
    !inventoryComplete || !historyComplete || diagnostics.length || totals.missingTokenTurns || totals.settlementUnverifiedTurns ? 'partial' : 'available';
  if (!inventoryComplete || !historyComplete) totals.fullTaskTokens = null;
  return { version: 1, kind: 'codex-cloud-turn-usage', observedAt: new Date(now).toISOString(), source: 'planmeter-compatible-cloud-read',
    measurement: 'service-estimate-not-bill', status, scope: roots.length ? 'selected-threads' : 'bounded-cloud-catalog',
    accountCloudCoverage: 'unknown', canCombineWithLocal: false, scopeFingerprint: rpc.scopeFingerprint || null,
    inventoryComplete, historyComplete, usageAccess, quotaAccess, threads: histories, turns, quotas: quotaRows, totals, diagnostics,
    warnings: ['云端历史、token、费用估算及额度占比是不同数据，不互相换算。', '缺失值不为零；本报表不与账户累计或本地 Tokscale 总数相加。',
      '日期按轮次完成时间（未完成按开始时间）归档，不是逐请求发生时间。', 'dot 归属与引擎父子关系分别保留；缓存归属不证明全量覆盖。'] };
}
module.exports = { collectCloudUsage, reference, turnPage, estimates, quotas, summary, page, identifier, error, SOURCE_KINDS };
