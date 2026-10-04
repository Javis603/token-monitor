'use strict';

const { rpcError } = require('./usageRpc');
const SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const FIELDS = ['netNewInputTokens', 'cachedInputTokens', 'inputTokens', 'outputTokens', 'totalTokens'];
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : null;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const label = (v) => typeof v === 'string' && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v) ? v : null;
function count(v) {
  if (v === null || v === undefined) return null;
  if (!Number.isSafeInteger(v) || v < 0) throw rpcError('INVALID_TOKEN_COUNT');
  return v;
}
function sum(values) {
  if (!values.length || values.some((v) => v === null)) return null;
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) throw rpcError('TOKEN_SUM_OVERFLOW');
    total += value;
  }
  return total;
}
function normalizeThreadUsage(response, requestedId) {
  if (!object(response)) throw rpcError('INVALID_THREAD_RESPONSE');
  if (response.threadUsage === null || response.threadUsage === undefined) return null;
  const raw = response.threadUsage;
  if (!object(raw) || raw.threadId !== requestedId || !Array.isArray(raw.groups) || raw.groups.length > 1000) {
    throw rpcError('THREAD_RESPONSE_MISMATCH');
  }
  const seen = new Set();
  const groups = raw.groups.map((group) => {
    if (!object(group)) throw rpcError('INVALID_THREAD_GROUP');
    const row = { model: label(group.model), reasoningEffort: label(group.reasoningEffort), speed: label(group.speed) };
    const key = JSON.stringify([row.model, row.reasoningEffort, row.speed]);
    if (seen.has(key)) throw rpcError('DUPLICATE_THREAD_GROUP');
    seen.add(key);
    for (const field of FIELDS) row[field] = count(group[field]);
    if (row.cachedInputTokens !== null && row.inputTokens !== null && row.cachedInputTokens > row.inputTokens) throw rpcError('INVALID_TOKEN_RELATION');
    if (row.netNewInputTokens !== null && row.cachedInputTokens !== null && row.inputTokens !== null
      && sum([row.netNewInputTokens, row.cachedInputTokens]) !== row.inputTokens) throw rpcError('INVALID_TOKEN_RELATION');
    if (row.inputTokens !== null && row.outputTokens !== null && row.totalTokens !== null
      && sum([row.inputTokens, row.outputTokens]) !== row.totalTokens) throw rpcError('INVALID_TOKEN_RELATION');
    return row;
  });
  const totals = {};
  for (const field of FIELDS) totals[field] = sum(groups.map((g) => g[field]));
  return { source: 'account/usage/read', measurement: 'estimated', period: 'lifetime',
    includesDescendants: 'unknown', groups, tokens: totals,
    status: totals.totalTokens === null ? 'partial' : 'estimated' };
}
function metadata(raw) {
  if (!object(raw) || !id(raw.id)) throw rpcError('INVALID_THREAD_METADATA');
  let source = raw.source;
  if (typeof source === 'string' && source.startsWith('{')) {
    try { source = JSON.parse(source); } catch (_) { source = null; }
  }
  const sub = object(source) ? source.subagent || source.subAgent : null;
  const spawn = object(sub) ? sub.thread_spawn || sub.threadSpawn : null;
  return { threadId: raw.id,
    parentThreadId: id(raw.parentThreadId || raw.parent_thread_id || spawn?.parent_thread_id || spawn?.parentThreadId),
    sourceKind: sub ? 'subAgent' : SOURCES.includes(source) ? source : 'unknown' };
}
function normalizeBindings(raw) {
  if (raw === undefined || raw === null) return [];
  if (!object(raw) || raw.version !== 1 || raw.kind !== 'codex-usage-bindings' || !Array.isArray(raw.threads) || raw.threads.length > 1000) {
    throw rpcError('INVALID_BINDINGS');
  }
  const seen = new Set();
  return raw.threads.map((t) => {
    if (!object(t) || !id(t.threadId) || seen.has(t.threadId)) throw rpcError('INVALID_BINDINGS');
    seen.add(t.threadId);
    for (const field of ['parentThreadId', 'taskId', 'dotId']) if (t[field] != null && !id(t[field])) throw rpcError('INVALID_BINDINGS');
    if (t.execution !== undefined && !['local', 'cloud', 'unknown'].includes(t.execution)) throw rpcError('INVALID_BINDINGS');
    if (t.creationSource !== undefined && !['manual', 'dot', 'unknown'].includes(t.creationSource)) throw rpcError('INVALID_BINDINGS');
    return { threadId: t.threadId, parentThreadId: t.parentThreadId || null, taskId: t.taskId || null, dotId: t.dotId || null,
      execution: t.execution || 'unknown', creationSource: t.creationSource || 'unknown', bindingEvidence: 'user-declared' };
  });
}
function issueCode(error) {
  return typeof error?.code === 'string' && /^[A-Z_]{1,60}$/.test(error.code) ? error.code : 'INVALID_RESPONSE';
}
async function syncUsage(rpc, {
  threadIds = [], bindings = null, discover = false, includeDescendants = true,
  maxThreads = 500, maxPages = 20, normalizeAccount, now = () => new Date().toISOString(), signal
} = {}) {
  if (!Array.isArray(threadIds) || threadIds.some((t) => !id(t))) throw rpcError('INVALID_THREAD_ID');
  if (!Number.isInteger(maxThreads) || maxThreads < 1 || maxThreads > 1000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw rpcError('INVALID_BUDGET');
  const declared = normalizeBindings(bindings);
  const roots = [...new Set([...threadIds, ...declared.flatMap((t) => [t.threadId, t.parentThreadId]).filter(Boolean)])];
  if (roots.length > maxThreads) throw rpcError('THREAD_BUDGET_EXCEEDED');
  const accountNormalizer = normalizeAccount || require('../../cloudUsageImport').normalizeCodexAccountUsage;
  const diagnostics = [];
  const check = () => { if (signal?.aborted) throw rpcError('SYNC_ABORTED'); };
  const start = now();
  let account = null; let accountStatus = 'unavailable';
  check();
  try {
    account = accountNormalizer(await rpc.call('account/usage/read', {}));
    accountStatus = account.summary.lifetimeTokens !== null || account.summary.peakDailyTokens !== null
      || (account.dailyUsageBuckets || []).length > 0 ? 'reported' : 'unknown';
  } catch (e) { diagnostics.push({ code: issueCode(e), scope: 'account' }); }
  const catalog = new Map();
  const add = (row) => {
    if (catalog.has(row.threadId)) {
      const previous = catalog.get(row.threadId);
      if (previous.parentThreadId && row.parentThreadId && previous.parentThreadId !== row.parentThreadId) {
        previous.parentThreadId = null; previous.parentConflict = true;
        diagnostics.push({ code: 'CONFLICTING_PARENT', threadId: row.threadId });
      } else if (!previous.parentConflict) previous.parentThreadId ||= row.parentThreadId;
      if (previous.sourceKind === 'unknown' && row.sourceKind !== 'unknown') previous.sourceKind = row.sourceKind;
      return;
    }
    if (catalog.size >= maxThreads) throw rpcError('THREAD_BUDGET_EXCEEDED');
    catalog.set(row.threadId, row);
  };
  for (const threadId of roots) add({ threadId, parentThreadId: null, sourceKind: 'unknown' });
  let enumeration = 'not-requested';
  if (discover || (roots.length && includeDescendants)) {
    // Do not exhaust the root's budget on unrelated account-local threads.
    // Unsupported experimental ancestry filters remain an explicit gap.
    const scopes = discover ? [null] : roots;
    enumeration = discover ? 'complete-for-connected-catalog' : 'complete-for-requested-ancestry';
    let listRequests = 0;
    try {
      for (const ancestorThreadId of scopes) {
        for (const archived of [false, true]) {
          let cursor = null; const cursors = new Set(); let complete = false;
          for (let page = 0; page < maxPages; page += 1) {
            check();
            if (++listRequests > maxPages * 2) throw rpcError('PAGE_BUDGET_EXCEEDED');
            const params = { limit: 100, cursor, archived, sourceKinds: SOURCES, useStateDbOnly: true };
            if (ancestorThreadId) params.ancestorThreadId = ancestorThreadId;
            const result = await rpc.call('thread/list', params);
            if (!object(result) || !Array.isArray(result.data) || result.data.length > 1000) throw rpcError('INVALID_THREAD_PAGE');
            if (result.nextCursor !== undefined && result.nextCursor !== null &&
              (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096)) throw rpcError('INVALID_THREAD_CURSOR');
            for (const raw of result.data) add(metadata(raw));
            cursor = result.nextCursor || null;
            if (!cursor) { complete = true; break; }
            if (cursors.has(cursor)) throw rpcError('REPEATED_THREAD_CURSOR');
            cursors.add(cursor);
          }
          if (!complete) throw rpcError('PAGE_BUDGET_EXCEEDED');
        }
      }
    } catch (e) { enumeration = 'partial'; diagnostics.push({ code: issueCode(e), scope: 'inventory' }); }
  }
  for (const threadId of roots) {
    check();
    try {
      const response = await rpc.call('thread/read', { threadId, includeTurns: false });
      if (response?.thread?.id !== threadId) throw rpcError('THREAD_RESPONSE_MISMATCH');
      add(metadata(response.thread));
    } catch (e) { diagnostics.push({ code: issueCode(e), scope: 'thread-metadata', threadId }); }
  }
  for (const binding of declared) {
    const row = catalog.get(binding.threadId);
    if (binding.parentThreadId && row.parentThreadId && binding.parentThreadId !== row.parentThreadId) {
      row.parentConflict = true; row.parentThreadId = null;
      diagnostics.push({ code: 'CONFLICTING_PARENT', threadId: row.threadId });
    } else if (!row.parentConflict) row.parentThreadId ||= binding.parentThreadId;
    row.binding = { ...binding, parentThreadId: row.parentThreadId };
  }
  const selected = new Set(roots);
  if (discover) for (const tid of catalog.keys()) selected.add(tid);
  if (includeDescendants) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of catalog.values()) if (selected.has(row.parentThreadId) && !selected.has(row.threadId)) {
        selected.add(row.threadId); changed = true;
      }
    }
  }
  for (const tid of selected) {
    const seen = new Set(); let current = tid;
    while (current && catalog.has(current)) {
      if (seen.has(current)) { diagnostics.push({ code: 'PARENT_CYCLE', threadId: tid }); break; }
      seen.add(current); current = catalog.get(current).parentThreadId;
    }
  }
  const threads = [];
  for (const tid of [...selected].sort()) {
    check(); const row = catalog.get(tid); let usage = null; let status = 'unavailable';
    try { usage = normalizeThreadUsage(await rpc.call('account/usage/read', { threadId: tid }), tid); status = usage?.status || 'unavailable'; }
    catch (e) { diagnostics.push({ code: issueCode(e), scope: 'thread-usage', threadId: tid }); }
    threads.push({ threadId: tid, parentThreadId: row.parentThreadId, sourceKind: row.sourceKind,
      execution: row.binding?.execution || 'unknown', creationSource: row.binding?.creationSource || 'unknown',
      taskId: row.binding?.taskId || null, dotId: row.binding?.dotId || null,
      bindingEvidence: row.binding ? 'user-declared' : null, status, usage });
  }
  check();
  if (rpc.accountChanged) throw rpcError('ACCOUNT_CHANGED_DURING_SYNC');
  const measured = threads.filter((t) => t.usage?.tokens.totalTokens !== null && t.usage?.tokens.totalTokens !== undefined).length;
  return { version: 1, kind: 'codex-live-usage', startedAt: start, observedAt: now(), source: 'codex-app-server',
    accountCloudCoverage: 'unknown', canCombineWithLocal: false,
    inventory: { scope: 'connected-app-server-catalog', status: enumeration, selectedThreads: threads.length,
      measuredThreads: measured, unavailableThreads: threads.length - measured },
    account: { status: accountStatus, report: account }, threads, diagnostics, taskTotalTokens: null,
    warnings: ['账户汇总不是云端专属统计；不得与本地或线程用量相加。',
      '线程接口返回估算值；未确认父线程是否包含后代，故不生成任务总和。',
      '连接端线程目录不代表完整云端/dot 任务清单；缺失值不是零。',
      '手工提供的 task/dot 关联仅作声明，不作为自动发现或服务端验证。'] };
}
module.exports = { syncUsage, normalizeThreadUsage, normalizeBindings, SOURCES };
