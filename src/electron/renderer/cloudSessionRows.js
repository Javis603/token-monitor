'use strict';

// Cloud records join the ordinary session row array before its existing sort
// and pagination. They never mutate local periods or contribute lifetime
// snapshots to a period total, project, chart, device record or local cost.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCloudSessionRows = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const EN = { cloud: 'Cloud', both: 'Local + cloud', lifetime: 'Lifetime · cloud', unavailable: 'Unknown',
    aeon: 'Dot', aeon_child: 'Dot task', subagent: 'Subagent', dreaming: 'Background task', user: 'Cloud session', unknown: 'Cloud session',
    stale: 'Last known', running: 'Running', idle: 'Idle', retained: 'Saved before restart',
    note: 'Cloud rows show lifetime counters, not usage for the selected period. They are not added to the local total above; parent/child overlap is unverified.',
    detail: 'Cloud engine counters', notFound: 'Cloud observation is unavailable for the current login. No local transcript is requested for a cloud-only session.',
    total: 'Lifetime tokens', input: 'Input (including cached)', cached: 'Cached input (part of input)', output: 'Output (including reasoning)', reasoning: 'Reasoning output (part of output)',
    observed: 'Last observed', activity: 'Last activity', parent: 'Engine parent', delegation: 'Delegated by', gaps: 'Connection gaps',
    setting: 'Automatically monitor Codex cloud sessions', settingNote: 'Show cloud tasks and subagents in Sessions. Monitoring remains active when this window closes.',
    disabled: 'Monitoring stopped', enabled: 'Monitoring active', missing: 'Cloud monitoring service is not installed', error: 'Cloud monitoring data is unavailable', failed: 'Could not change monitoring. Refresh to retry.' };
  const ZH = { cloud: '云端', both: '本地 + 云端', lifetime: '累计 · 云端', unavailable: '未知',
    aeon: 'Dot 主线程', aeon_child: 'Dot 任务', subagent: '子代理', dreaming: '后台任务', user: '云端会话', unknown: '云端会话',
    stale: '历史观测', running: '运行中', idle: '空闲', retained: '重启前留存',
    note: '云会话显示线程累计值，不是所选周期的消耗；未加入页顶本地总量。父子计数是否重叠尚未验证。',
    detail: '云端引擎计数', notFound: '当前登录下的云端观测暂不可用。云会话不会尝试读取本机聊天日志。',
    total: '累计 Token', input: '输入（包含缓存）', cached: '缓存输入（包含于输入）', output: '输出（包含推理）', reasoning: '推理输出（包含于输出）',
    observed: '最近计数', activity: '最近活动', parent: '引擎父线程', delegation: '委派父线程', gaps: '连接缺口',
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
        name: `Codex · ${text[thread.kind] || text.unknown}`, subtitle: [text.cloud, state, activity ? new Date(activity).toLocaleString(options.locale || 'en') : ''].filter(Boolean).join(' · '),
        detail: threadId, value: value?.totalTokens ?? 0, tokenDataUnavailable: value === null,
        cost: 0, costLabel: text.lifetime, periodTokenDataUnavailable: true, barValue: 0,
        color: options.color || '', stale: !current(snapshot, now), running: live || undefined,
        activityState: live ? 'running' : 'idle', sortTime: activity,
        cloudThreadId: threadId, cloudOnly: true, title: `Codex ${text.cloud} ${threadId}` });
    }
    return rows;
  }
  function detail(snapshot, threadId, locale = 'en') {
    const t = find(snapshot, threadId), text = labels(locale);
    if (!t) return { title: text.detail, note: text.notFound, fields: [] };
    const usage = t.status === 'observed' ? tokens(t.total) : null;
    const n = (v) => Number.isSafeInteger(v) && v >= 0 ? v.toLocaleString('en-US') : text.unavailable;
    const d = (v) => timestamp(v) ? new Date(v).toLocaleString(locale) : text.unavailable;
    return { title: text.detail, note: text.note, fields: [
      [text.total, n(usage?.totalTokens)], [text.input, n(usage?.inputTokens)], [text.cached, n(usage?.cachedInputTokens)],
      [text.output, n(usage?.outputTokens)], [text.reasoning, n(usage?.reasoningOutputTokens)],
      [text.observed, d(t.observedAt) + (t.retainedFromPriorRun ? ` · ${text.retained}` : '')], [text.activity, d(t.lastActivityAt)],
      [text.parent, id(t.engineParentId) || text.unavailable], [text.delegation, id(t.delegationParentId) || text.unavailable], [text.gaps, n(t.gapCount)]
    ] };
  }
  // Coalesce UI reads within a generation. Inactive surfaces do not poll; failures clear the
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
  return { labels, mergeRows, inPeriod, localIdentity, find, detail, createSource };
});
