'use strict';

// Cloud records join the ordinary session row array before its existing sort
// and pagination. Main-process accounting owns the period totals and billing;
// the renderer never accumulates repeated lifetime snapshots itself.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCloudSessionRows = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const EN = { cloud: 'Cloud', both: 'Local + cloud', lifetime: 'Lifetime · cloud', unavailable: 'Unknown',
    aeon: 'Dot', aeon_child: 'Dot task', subagent: 'Subagent', dreaming: 'Background task', user: 'Cloud session', unknown: 'Cloud session',
    stale: 'Last known', running: 'Running', idle: 'Idle', retained: 'Saved before restart',
    note: 'Cloud rows show each thread\u2019s lifetime counters. Eligible cloud counts are included in the total above: the first lifetime snapshot counts toward TOTAL, and increases observed later count toward Today/Month on the observation date. Same-thread local and cloud totals are reconciled within comparable periods. Unverified parent/fork overlap and unavailable comparable periods remain excluded or incomplete. Chargeable cloud costs without model/rate data are unknown.',
    fee: 'Billing', normalPrice: 'Cost pending',
    detail: 'Cloud engine counters', notFound: 'Cloud observation is unavailable for the current login. No local transcript is requested for a cloud-only session.',
    total: 'Lifetime tokens', input: 'Input (including cached)', cached: 'Cached input (part of input)', output: 'Output (including reasoning)', reasoning: 'Reasoning output (part of output)',
    observed: 'Last observed', activity: 'Last activity', parent: 'Engine parent', delegation: 'Delegated by', gaps: 'Connection gaps',
    accounting: 'Counted in total', includedNow: 'Yes — eligible counts are included', excludedLocal: 'No — matches a local session (no double count)', excludedParent: 'No — parent/child overlap unverified', accountingUnknown: 'Unknown for this thread', partialNote: 'counter reset or unknown components observed', bridgedNote: 'counted after a monitoring gap',
    includesCloud: 'Cloud included', baselinePart: 'lifetime baseline (TOTAL only)', excludedLabel: 'excluded', localMatchReason: 'local match', parentOverlapReason: 'parent overlap', partialPart: 'with resets/gaps',
    accountingPaused: 'Cloud counting paused · saved values retained', partialComponents: 'Some cloud token components are unknown',
    setting: 'Automatically monitor Codex cloud sessions', settingNote: 'Show cloud tasks and subagents in Sessions. Monitoring remains active when this window closes.',
    disabled: 'Monitoring stopped', enabled: 'Monitoring active', missing: 'Cloud monitoring service is not installed', error: 'Cloud monitoring data is unavailable', failed: 'Could not change monitoring. Refresh to retry.' };
  const ZH = { cloud: '云端', both: '本地 + 云端', lifetime: '累计 · 云端', unavailable: '未知',
    aeon: 'Dot 主线程', aeon_child: 'Dot 任务', subagent: '子代理', dreaming: '后台任务', user: '云端会话', unknown: '云端会话',
    stale: '历史观测', running: '运行中', idle: '空闲', retained: '重启前留存',
    note: '云会话行显示各线程累计值。符合条件的云端计数已计入上方总量：首次累计快照计入 TOTAL，之后观测到的增量按观测日期计入今日/本月。本地与云端的同一线程按可比较时段去重补足；父子重叠或缺少可比较数值的部分会保守排除。正常计价的云会话缺少模型和费率时，费用待确认。',
    fee: '计价', normalPrice: '费用待确认',
    detail: '云端引擎计数', notFound: '当前登录下的云端观测暂不可用。云会话不会尝试读取本机聊天日志。',
    total: '累计 Token', input: '输入（包含缓存）', cached: '缓存输入（包含于输入）', output: '输出（包含推理）', reasoning: '推理输出（包含于输出）',
    observed: '最近计数', activity: '最近活动', parent: '引擎父线程', delegation: '委派父线程', gaps: '连接缺口',
    accounting: '计入总量', includedNow: '是（符合条件的计数已计入）', excludedLocal: '否（与本地会话同一线程，不重复计数）', excludedParent: '否（父子计数重叠未验证，保守排除）', accountingUnknown: '该线程状态未知', partialNote: '观测到计数重置或未知分项', bridgedNote: '跨监听缺口后补记',
    includesCloud: '含云端', baselinePart: '历史基线仅计入 TOTAL', excludedLabel: '已排除', localMatchReason: '本地重复', parentOverlapReason: '父子重叠', partialPart: '项计数有重置/缺口',
    accountingPaused: '云端计数暂停 · 已保存数值保留', partialComponents: '部分云端 Token 分项未知',
    setting: '自动监听 Codex 云会话', settingNote: '将云端任务和子代理显示在“会话”中。关闭窗口不会停止后台监听。',
    disabled: '监听已停止', enabled: '监听中', missing: '尚未安装云会话监听服务', error: '暂时无法取得云会话状态', failed: '监听设置未能更改，请刷新后重试。' };
  const labels = (locale) => String(locale || '').startsWith('zh') ? ZH : EN;
  const id = (v) => typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null;
  const timestamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0;
  function tokens(raw) {
    if (!raw) return null;
    const safe = (v) => Number.isSafeInteger(v) && v >= 0;
    if (![raw.inputTokens, raw.outputTokens, raw.totalTokens].every(safe)
      || !Number.isSafeInteger(raw.inputTokens + raw.outputTokens) || raw.inputTokens + raw.outputTokens !== raw.totalTokens) return null;
    const result = {};
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens']) {
      if (raw[field] != null && !safe(raw[field])) return null;
      result[field] = raw[field] ?? null;
    }
    if (result.cachedInputTokens > result.inputTokens || result.reasoningOutputTokens > result.outputTokens) return null;
    return result;
  }
  function inPeriod(thread, period, now) {
    if (period === 'allTime') return true;
    // Capture time is not activity time: replaying an old counter today must
    // not make an old session appear in today's list.
    const activity = timestamp(thread.lastActivityAt) || timestamp(thread.createdAt);
    if (!activity || activity > now.getTime() + 300000) return false;
    let start;
    if (period === 'today') start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    else if (period === 'month') start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    else return false; // Derived ranges keep their existing availability gate.
    return activity >= start;
  }
  function find(snapshot, threadId) {
    if (!snapshot || snapshot.errorCode || !id(threadId)) return null;
    return (snapshot.threads || []).find((t) => id(t.threadId) === id(threadId)) || null;
  }
  function current(snapshot, now) {
    const at = timestamp(snapshot?.observedAt);
    return !snapshot?.stale && snapshot?.state === 'listening' && at > 0 && now.getTime() - at <= 30000 && at <= now.getTime() + 300000;
  }
  function localIdentity(session, key) {
    if (session?.client !== 'codex') return null;
    for (const value of [session.canonicalSessionId, session.threadId, session.sessionId]) if (id(value)) return id(value);
    // Only the canonical Codex key is accepted. UUID-looking fragments inside
    // filenames or user labels are display hints, not proof of shared identity.
    return id(String(key || '').replace(/^codex:/, ''));
  }
  function mergeRows(localRows, period, snapshot, options = {}) {
    if (!snapshot || snapshot.errorCode || !Array.isArray(snapshot.threads)) return localRows;
    const now = options.now || new Date(), text = labels(options.locale), rows = [...localRows];
    const identities = new Map(), localIndex = new Map(localRows.map((row, i) => [row.key, i]));
    for (const [key, session] of Object.entries(period?.sessions || {})) {
      const canonical = localIdentity(session, key);
      const index = localIndex.get(`session:${key}`);
      if (canonical && index !== undefined && !identities.has(canonical)) identities.set(canonical, index);
    }
    const seen = new Set();
    for (const thread of snapshot.threads) {
      const threadId = id(thread?.threadId);
      if (!threadId || seen.has(threadId) || !inPeriod(thread, options.period || 'allTime', now)) continue;
      seen.add(threadId);
      const live = current(snapshot, now) && thread.runtimeStatus === 'active' && !thread.archived;
      const value = thread.status === 'observed' ? tokens(thread.total) : null;
      const existing = identities.get(threadId);
      if (existing !== undefined) {
        // Keep the local row's period tokens, cost, title and request semantics.
        // Add provenance and the cloud detail, never a second row or added total.
        const index = existing, local = rows[index];
        rows[index] = { ...local, subtitle: [local.subtitle, text.both].filter(Boolean).join(' · '), cloudThreadId: threadId, cloudOnly: false };
        continue;
      }
      const activity = timestamp(thread.lastActivityAt) || timestamp(thread.createdAt);
      const state = thread.retainedFromPriorRun ? text.retained : !current(snapshot, now) ? text.stale : live ? text.running : text.idle;
      rows.push({ key: `session:codex:cloud:${threadId}`, kind: 'session', client: 'codex',
        name: `Codex · ${text[thread.kind] || text.unknown}`, subtitle: [text.cloud, state, text.lifetime, activity ? new Date(activity).toLocaleString(options.locale || 'en') : ''].filter(Boolean).join(' · '),
        detail: threadId, value: value?.totalTokens ?? 0, tokenDataUnavailable: value === null,
        cost: null, costLabel: text.normalPrice, costDataUnavailable: true, periodTokenDataUnavailable: true, barValue: 0,
        color: options.color || '', stale: !current(snapshot, now), running: live || undefined,
        activityState: live ? 'running' : 'idle', sortTime: activity,
        cloudThreadId: threadId, cloudOnly: true, title: `Codex ${text.cloud} ${threadId}` });
    }
    return rows;
  }
  function accountingLabel(entry, text) {
    if (!entry || !entry.status) return text.accountingUnknown;
    const base = entry.status === 'included' ? text.includedNow
      : entry.status === 'matched-local' ? text.excludedLocal
        : entry.status === 'parent-overlap' ? text.excludedParent : text.accountingUnknown;
    const suffix = entry.partial ? ` · ${text.partialNote}` : entry.bridged ? ` · ${text.bridgedNote}` : '';
    return base + suffix;
  }
  function detail(snapshot, threadId, locale = 'en', accounting = null) {
    const t = find(snapshot, threadId), text = labels(locale);
    if (!t) return { title: text.detail, note: text.notFound, fields: [] };
    const usage = t.status === 'observed' ? tokens(t.total) : null;
    const n = (v) => Number.isSafeInteger(v) && v >= 0 ? v.toLocaleString('en-US') : text.unavailable;
    const d = (v) => timestamp(v) ? new Date(v).toLocaleString(locale) : text.unavailable;
    const entry = accounting && typeof accounting === 'object' && accounting.threads ? accounting.threads[t.threadId] : null;
    return { title: text.detail, note: text.note, fields: [
      [text.total, n(usage?.totalTokens)], [text.input, n(usage?.inputTokens)], [text.cached, n(usage?.cachedInputTokens)],
      [text.output, n(usage?.outputTokens)], [text.reasoning, n(usage?.reasoningOutputTokens)],
      [text.observed, d(t.observedAt) + (t.retainedFromPriorRun ? ` · ${text.retained}` : '')], [text.activity, d(t.lastActivityAt)],
      [text.parent, id(t.engineParentId) || text.unavailable], [text.delegation, id(t.delegationParentId) || text.unavailable], [text.gaps, n(t.gapCount)],
      [text.fee, text.normalPrice],
      [text.accounting, accountingLabel(entry, text)]
    ] };
  }
  // One short line under the headline total. Only the current period\u2019s
  // included cloud tokens are shown; the lifetime baseline is called out once
  // because it was never observed as an increment.
  function accountingNote(accounting, period, locale = 'en') {
    if (!accounting || typeof accounting !== 'object' || accounting.version !== 1) return '';
    const text = labels(locale), summary = accounting.periods?.[period];
    const parts = [];
    if (accounting.state === 'inactive' && typeof accounting.reason === 'string' && accounting.reason) parts.push(text.accountingPaused);
    if (!summary) return parts.join(' · ');
    const included = Number(summary.totalTokens) || 0;
    if (included > 0) parts.push(`${text.includesCloud} ${included.toLocaleString('en-US')}`);
    if (period === 'allTime' && (Number(accounting.baselineTokens) || 0) > 0) parts.push(text.baselinePart);
    const excluded = [];
    if (accounting.excludedReasons?.matchedLocal) excluded.push(`${accounting.excludedReasons.matchedLocal} ${text.localMatchReason}`);
    if (accounting.excludedReasons?.parentOverlap) excluded.push(`${accounting.excludedReasons.parentOverlap} ${text.parentOverlapReason}`);
    if (excluded.length) parts.push(`${text.excludedLabel} ${excluded.join(' · ')}`);
    if (Number(accounting.partialThreads) > 0) parts.push(`${accounting.partialThreads} ${text.partialPart}`);
    if (accounting.unknownCost && included > 0) parts.push(locale.startsWith('zh') ? '部分云端费用待确认' : 'Some cloud costs pending');
    if (accounting.partialComponents === true) parts.push(text.partialComponents);
    return parts.join(' · ');
  }
  // Coalesce UI reads within a generation. Inactive surfaces do not poll and failures clear the
  // old snapshot, including a changed login, rather than rendering stale IDs.
  // `invalidate` is the UI's synchronous boundary: a changed login clears the
  // old rows and detail immediately, and a read or timer that started before
  // the boundary can never publish, so the next refresh reads fresh instead of
  // joining data that belongs to the previous account or pre-control service.
  function createSource({ get, onChange, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
    let active = false, disposed = false, pending = null, timer = null, last = 0, value = null, generation = 0;
    function arm() { if (timer) cancel(timer); timer = active && !disposed ? schedule(() => { timer = null; void refresh(); }, 3000) : null; }
    function start() {
      const started = generation;
      const entry = { generation: started, promise: null };
      entry.promise = (async () => {
        let next;
        try { next = await get(); } catch (_) { next = { errorCode: 'IPC_FAILED', threads: [], stale: true }; }
        if (!disposed && started === generation) { value = next; last = now(); onChange(next); }
        return next;
      })();
      pending = entry;
      const settle = () => { if (pending === entry) pending = null; arm(); };
      entry.promise.then(settle, settle);
      return entry.promise;
    }
    function refresh(options = {}) {
      if (disposed) return null;
      if (options.fresh) generation += 1;
      if (pending && pending.generation === generation) return pending.promise;
      return start();
    }
    function invalidate({ clear = true, refetch = false } = {}) {
      generation += 1;
      if (clear) { const had = value !== null; value = null; last = 0; if (had) onChange(null); }
      if (refetch && active && !disposed) void refresh();
      return generation;
    }
    return { snapshot: () => value, refresh, invalidate,
      setActive(next) { const changed = active !== Boolean(next); active = Boolean(next); if (!active) { if (timer) cancel(timer); timer = null; }
        else if (changed && (!last || now() - last >= 3000)) void refresh(); else if (changed) arm(); },
      dispose() { disposed = true; active = false; if (timer) cancel(timer); }
    };
  }
  return { labels, mergeRows, inPeriod, localIdentity, find, detail, accountingNote, accountingLabel, createSource };
});
