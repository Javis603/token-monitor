(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TokenMonitorCloudUsagePanel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const EN = { title: 'Codex cloud', subtitle: 'Automatic discovery · live engine counters', unknown: 'Unknown',
    refresh: 'Refresh', start: 'Start monitoring', stop: 'Stop monitoring', search: 'Find a thread ID or type',
    all: 'All threads', measured: 'With counters', listening: 'Listening', discovered: 'Discovered', waiting: 'Waiting for capacity',
    state: 'Service', updated: 'Last discovery', thread: 'Thread / relationship', runtime: 'Activity', input: 'Input', cached: 'Cached input',
    output: 'Output', total: 'Cumulative tokens', seen: 'Last counter / gaps', gaps: 'connection gaps', empty: 'No matching cloud threads.',
    note: 'Engine lifetime snapshots, not daily usage or a bill. Cached input is part of input; reasoning is part of output. Parent/child overlap is unverified: these values are not added to local totals or summed together.',
    coverage: 'Short tasks, offline periods and capacity limits may leave gaps. Unknown does not mean zero. Only the current observer run is shown.',
    unavailable: 'Cloud monitoring data is not available.', stale: 'The observer is stopped or this snapshot is stale. The numbers below are historical observations, not live readings.',
    installing: 'The cloud observer service is not installed on this device.', account: 'The saved cloud report does not match the current Codex login. No counters are displayed.',
    notReady: 'Waiting for the first report from the observer.', actionFailed: 'The service action did not complete. Refresh to check its state.',
    engineParent: 'Engine parent', delegatedParent: 'Delegated by', unknownParent: 'Parent unverified', received: 'Received events', retained: 'Saved before service restart',
    serviceStates: { listening: 'Listening', starting: 'Starting', connecting: 'Connecting', reconnecting: 'Reconnecting', stopped: 'Stopped', stale: 'Stale snapshot', unavailable: 'Unavailable', unknown: 'Unknown', blocked: 'Blocked', error: 'Error' },
    kinds: { aeon: 'Dot root', aeon_child: 'Dot delegated task', subagent: 'Subagent', dreaming: 'Background task', user: 'Cloud conversation', unknown: 'Cloud thread' },
    states: { active: 'Running', idle: 'Idle', notLoaded: 'Unloaded', systemError: 'Error', unknown: 'Unknown' } };
  const ZH = { title: 'Codex 云端', subtitle: '自动发现 · 实时引擎计数', unknown: '未知', refresh: '刷新', start: '启动监听', stop: '停止监听',
    search: '搜索线程 ID 或类型', all: '全部线程', measured: '已有计数', listening: '正在监听', discovered: '发现线程', waiting: '等待空位',
    state: '服务状态', updated: '最近发现', thread: '线程 / 归属关系', runtime: '运行状态', input: '输入', cached: '缓存输入', output: '输出', total: '累计 Token',
    seen: '最近计数 / 缺口', gaps: '次连接缺口', empty: '没有符合条件的云端线程。',
    note: '这里是各线程的引擎累计快照，不是今日用量或账单。缓存输入包含于输入，推理输出包含于输出。父子计数是否重叠尚未验证，因此不与本地总数合并，也不把这些线程直接相加。',
    coverage: '极短任务、离线时段和监听容量限制可能造成漏采；未知不等于零。当前仅展示这次监听进程运行以来取得的数据。',
    unavailable: '暂时无法取得云端监听数据。', stale: '监听已停止或快照已过期。下方保留的是历史观测值，不是当前实时读数。',
    installing: '这台设备尚未安装云端监听服务。', account: '保存的云端报告与当前 Codex 登录不匹配，已隐藏计数。',
    notReady: '等待监听器生成第一份报告。', actionFailed: '服务操作未完成，请刷新确认状态。',
    engineParent: '引擎父线程', delegatedParent: '委派父线程', unknownParent: '父级未验证', received: '已收事件', retained: '重启前留存计数',
    serviceStates: { listening: '监听中', starting: '启动中', connecting: '连接中', reconnecting: '重连中', stopped: '已停止', stale: '快照过期', unavailable: '不可用', unknown: '未知', blocked: '受阻', error: '错误' },
    kinds: { aeon: 'Dot 主线程', aeon_child: 'Dot 委派任务', subagent: '子代理', dreaming: '后台任务', user: '云端会话', unknown: '云端线程' },
    states: { active: '运行中', idle: '空闲', notLoaded: '未加载', systemError: '错误', unknown: '未知' } };
  const strings = (locale) => String(locale || '').startsWith('zh') ? ZH : EN;
  const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const numeric = (v, text) => Number.isSafeInteger(v) && v >= 0 ? v.toLocaleString('en-US') : text.unknown;
  function date(v, locale, text) {
    if (!v || !Number.isFinite(Date.parse(v))) return text.unknown;
    try { return new Date(v).toLocaleString(locale || 'en', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
    catch (_) { return new Date(v).toISOString(); }
  }
  function selectRows(snapshot, filter, query) {
    const q = String(query || '').toLowerCase().trim();
    return (snapshot?.threads || []).filter((r) => (filter !== 'measured' || r.total !== null)
      && (filter !== 'listening' || r.listening)
      && (!q || [r.threadId, r.kind, r.engineParentId, r.delegationParentId].some((v) => String(v || '').toLowerCase().includes(q))));
  }
  function rowsHtml(rows, locale = 'en') {
    const t = strings(locale);
    if (!rows.length) return `<tr><td colspan="7" class="cloud-empty">${escape(t.empty)}</td></tr>`;
    return rows.map((r) => {
      const parent = [[t.engineParent, r.engineParentId], [t.delegatedParent, r.delegationParentId]].filter(([, v]) => v);
      const relationships = parent.length ? parent.map(([label, v]) => `<small title="${escape(v)}">${escape(label)} · ${escape(v.slice(0, 8))}…</small>`).join('') : `<small>${escape(t.unknownParent)}</small>`;
      return `<tr data-cloud-thread="${escape(r.threadId)}"><td class="cloud-thread"><code title="${escape(r.threadId)}">${escape(r.threadId)}</code><span class="cloud-kind">${escape(t.kinds[r.kind] || t.kinds.unknown)}</span>${relationships}</td>
<td><span class="cloud-status ${r.listening ? 'is-listening' : ''}">${escape(t.states[r.runtimeStatus] || t.unknown)}</span><small>${r.listening ? escape(t.listening) : ''}</small></td>
<td class="cloud-number">${numeric(r.total?.inputTokens, t)}</td><td class="cloud-number cloud-muted">${numeric(r.total?.cachedInputTokens, t)}</td>
<td class="cloud-number" title="Reasoning: ${numeric(r.total?.reasoningOutputTokens, t)}">${numeric(r.total?.outputTokens, t)}</td><td class="cloud-number cloud-total">${numeric(r.total?.totalTokens, t)}</td>
<td class="cloud-observed">${escape(date(r.observedAt, locale, t))}<small>${r.retainedFromPriorRun ? escape(t.retained) : numeric(r.gapCount, t) + ' ' + escape(t.gaps)}</small></td></tr>`;
    }).join('');
  }
  function createPanel({ root, api, getLocale = () => 'en', document: doc = root.ownerDocument, schedule = setTimeout, cancel = clearTimeout }) {
    let active = false, dead = false, timer = null, pending = null, current = null, filter = 'all', query = '', locale = '', actionBusy = false, actionError = false;
    root.innerHTML = `<div class="cloud-heading"><div><h2 data-cloud-text="title"></h2><p data-cloud-text="subtitle"></p></div><div class="cloud-actions"><button type="button" data-cloud-action="start"></button><button type="button" data-cloud-action="stop"></button><button type="button" data-cloud-action="refresh"></button></div></div>
<div class="cloud-status-line" role="status" aria-live="polite"></div><div class="cloud-message" role="status" hidden></div>
<div class="cloud-cards">${['discovered', 'listening', 'measured', 'waiting'].map((key) => `<div><span data-cloud-text="${key}"></span><strong data-cloud-card="${key}">—</strong></div>`).join('')}</div>
<p class="cloud-scope-note" data-cloud-text="note"></p><div class="cloud-toolbar"><input type="search" class="cloud-search" autocomplete="off" spellcheck="false"><select class="cloud-filter"><option value="all"></option><option value="measured"></option><option value="listening"></option></select></div>
<div class="cloud-table-wrap"><table><thead><tr>${['thread', 'runtime', 'input', 'cached', 'output', 'total', 'seen'].map((key) => `<th data-cloud-text="${key}"></th>`).join('')}</tr></thead><tbody></tbody></table></div><p class="cloud-coverage-note" data-cloud-text="coverage"></p>`;
    const find = (s) => root.querySelector(s), all = (s) => root.querySelectorAll(s);
    function translate() {
      locale = getLocale(); const t = strings(locale);
      for (const el of all('[data-cloud-text]')) el.textContent = t[el.dataset.cloudText];
      for (const el of all('[data-cloud-action]')) el.textContent = t[el.dataset.cloudAction];
      for (const el of all('.cloud-filter option')) el.textContent = t[el.value];
      find('.cloud-search').placeholder = t.search; find('.cloud-search').setAttribute('aria-label', t.search);
      find('.cloud-filter').setAttribute('aria-label', t.all);
    }
    function paint() {
      if (dead) return; if (locale !== getLocale()) translate(); const t = strings(locale);
      const s = current;
      find('tbody').innerHTML = rowsHtml(selectRows(s, filter, query), locale);
      const message = find('.cloud-message');
      let note = !s ? t.notReady : s.errorCode === 'CLOUD_ACCOUNT_MISMATCH' || s.errorCode === 'CLOUD_ACCOUNT_CHANGED' ? t.account
        : !s.service?.installed ? t.installing : s.errorCode ? t.unavailable : s.stale ? t.stale : '';
      if (actionBusy) note = ''; else if (actionError) note = t.actionFailed; message.textContent = note; message.hidden = !note;
      find('.cloud-status-line').textContent = `${t.state}: ${t.serviceStates[s?.state] || t.unknown} · ${t.updated}: ${date(s?.lastDiscoveryAt, locale, t)}`;
      for (const [key, value] of Object.entries({ discovered: s?.knownThreads, listening: s?.listeningThreads, measured: s?.measuredThreads, waiting: s?.waitingForSlot })) find(`[data-cloud-card="${key}"]`).textContent = numeric(value, t);
      for (const el of all('[data-cloud-action]')) el.disabled = actionBusy || (el.dataset.cloudAction !== 'refresh' && !s?.service?.canControl);
    }
    function arm() { if (timer) cancel(timer); timer = active && !dead ? schedule(() => { timer = null; void refresh(); }, 3000) : null; }
    async function refresh() {
      if (dead || !active || doc.hidden) { arm(); return; }
      if (pending) return pending;
      pending = (async () => {
        try { current = await api.get(); }
        catch (_) { current = { state: 'unavailable', errorCode: 'IPC_FAILED', threads: [], stale: true }; }
        if (!dead) paint();
      })();
      try { await pending; } finally { pending = null; arm(); }
    }
    const onClick = async (event) => {
      const button = event.target.closest('[data-cloud-action]'); if (!button || !root.contains(button) || button.disabled) return;
      const action = button.dataset.cloudAction;
      if (action === 'refresh') { actionError = false; await refresh(); return; }
      actionError = false; actionBusy = true; paint();
      try { const result = await api.control(action); if (!result?.ok) throw new Error('not-confirmed'); current = result.snapshot; }
      catch (_) { actionError = true; }
      finally { actionBusy = false; for (const el of all('[data-cloud-action]')) el.disabled = false; await refresh(); }
    };
    const onSearch = (e) => { query = e.target.value; paint(); };
    const onFilter = (e) => { filter = e.target.value; paint(); };
    const onVisibility = () => { if (!doc.hidden && active) void refresh(); };
    root.addEventListener('click', onClick); find('.cloud-search').addEventListener('input', onSearch); find('.cloud-filter').addEventListener('change', onFilter); doc.addEventListener('visibilitychange', onVisibility);
    translate(); paint();
    return { setActive(value) { active = Boolean(value); if (active) { paint(); void refresh(); } else if (timer) { cancel(timer); timer = null; } }, refresh,
      dispose() { dead = true; active = false; if (timer) cancel(timer); root.removeEventListener('click', onClick); doc.removeEventListener('visibilitychange', onVisibility); find('.cloud-search').removeEventListener('input', onSearch); find('.cloud-filter').removeEventListener('change', onFilter); } };
  }
  return { strings, rowsHtml, selectRows, createPanel };
});
