/* global state, els, renderLimits, renderTrends, renderSessionDetail, renderRows, updateRow, sessionRowsForPeriod, renderSessionGroupDetail, sessionRowsApi, document, PointerEvent */
'use strict';
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  state.breakdown = 'limits'; state.settings.limitProviders = ['codex']; state.settings.limitsEnabled = true;
  const record = { provider: 'codex', status: 'ok', accountKey: 'fixture', resetCredits: { availableCount: 2, expirations: [new Date(Date.now() + 86400000).toISOString()] }, windows: [
    { kind: 'session', label: 'Session', remainingPercent: 75, usedPercent: 25, infoRows: [{ label: 'Requests', value: '1' }] }
  ] };
  state.stats.limits = { providers: [record] };
  els.limitsPanel.classList.remove('hidden');
  renderLimits();
  const limitRow = els.limitsPanel.querySelector('.limit-row');
  const trigger = limitRow.querySelector('.limit-detail-tooltip-trigger');
  assert(trigger, 'limits tooltip exists');
  const popover = trigger.parentNode.querySelector('[popover]');
  const refreshButton = limitRow.querySelector('.limit-refresh-button');
  trigger.focus();
  for (let i = 2; i < 4; i++) {
    const before = popover.textContent;
    record.windows[0].remainingPercent--; record.resetCredits.expirations = [new Date(Date.now() + i * 86400000).toISOString()];
    state.stats.limits.providers = [{ ...record, accountLabel: `Updated ${i}` }]; renderLimits();
    assert(els.limitsPanel.querySelector('.limit-row') === limitRow, 'limits account stays connected');
    assert(document.activeElement === trigger && popover.matches(':popover-open'), 'limits focus/popover survives pushes');
    assert(popover.textContent !== before, 'open limits tooltip updates');
    assert(limitRow.querySelector('.limit-refresh-button') === refreshButton, 'refresh button retained');
    assert(window.TokenMonitorDomReconcile.data(refreshButton).accountLabel === `Updated ${i}`, 'retained refresh button receives current provider DTO');
  }
  state.settings.limitsHistoryOpenMode = 'hover'; state.settings.limitProviders = ['mimo'];
  const mimo = { provider: 'mimo', status: 'ok', accountKey: 'mimo-dom', windows: [{ kind: 'weekly', remainingPercent: 75, usedPercent: 25 }] };
  state.stats.limits.providers = [mimo]; renderLimits();
  const mimoRow = els.limitsPanel.querySelector('.limit-row');
  mimo.balance = { remaining: 100, currency: 'CNY', cashBalance: 80, giftBalance: 20 };
  mimo.windows.push({ kind: 'billing', metric: 'credits', remaining: 100, limit: 200, currency: 'CNY' });
  renderLimits(); assert(els.limitsPanel.querySelector('.limit-row') === mimoRow, 'MiMo account retained when a balance appears');
  const balanceInfo = mimoRow.querySelector('[data-usage-item="credits"] .limit-detail-tooltip-wrap');
  assert(balanceInfo, 'new MiMo balance disclosure exists');
  const historyCount = () => window.tokenMonitor.limits.openHistory('__dom_probe__', { x: 0, y: 0, width: 0, height: 0 });
  const opens = await historyCount();
  mimoRow.dispatchEvent(new PointerEvent('pointerenter'));
  balanceInfo.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  balanceInfo.dispatchEvent(new PointerEvent('pointerenter'));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert(await historyCount() === opens, 'a newly inserted balance disclosure suppresses its retained row history timer');
  mimoRow.dispatchEvent(new PointerEvent('pointerleave'));
  state.breakdown = 'session';
  const raw = { client: 'codex', sessionId: 'test', title: 'Test session', totalTokens: 100,
    models: { 'gpt-5': 70, 'gpt-5-mini': 30 }, lastUsedAt: new Date().toISOString() };
  state.stats.periods.today.sessions = { 'codex:test': raw };
  els.breakdown.classList.remove('hidden');
  renderRows(sessionRowsForPeriod(state.stats.periods.today));
  const row = els.breakdown.querySelector('[data-key]');
  const model = row.querySelector('.session-models');
  assert(model, 'sessions list has multi-model metadata');
  model.focus();
  const modelPopover = model.querySelector('[popover]');
  for (let i = 0; i < 2; i++) {
    const before = modelPopover.textContent;
    raw.models['gpt-5-mini'] += 1000; raw.totalTokens += 1000;
    state.stats = { ...state.stats, periods: { ...state.stats.periods, today: { ...state.stats.periods.today, sessions: { 'codex:test': { ...raw, models: { ...raw.models } } } } } };
    state.sessionRowsCache = null;
    renderRows(sessionRowsForPeriod(state.stats.periods.today));
    assert(els.breakdown.querySelector('[data-key]') === row, 'session list row identity');
    assert(row.querySelector('.session-models') === model, 'session metadata identity');
    assert(document.activeElement === model && modelPopover.matches(':popover-open'), 'session list focused tooltip survives');
    assert(modelPopover.textContent !== before, 'focused model tooltip gets new data');
  }
  const metadata = { client: 'codex', modelLabel: 'gpt', reasoningEffort: 'high' };
  const label = sessionRowsApi.sessionModelMetadataLabel(metadata);
  const options = { ...metadata, name: 'Test session', subtitle: `Codex · ${label}`, value: 100, max: 100, color: '#abc' };
  for (let i = 0; i < 2; i++) {
    updateRow(row, options);
    updateRow(row, { ...options, subtitle: '12:00 · 2 calls', reasoningEffort: '', modelLabel: '' });
    updateRow(row, options);
    assert(row.querySelector('.row-subtitle').textContent === options.subtitle, 'metadata/plain/metadata transition leaves no stale plain text');
  }
  state.openSession = { kind: 'session', client: 'codex', sessionId: 'test', period: 'today', title: 'Test session' };
  const detail = { found: true, exchanges: [{ promptPreview: 'Keep my exchange open', startedAt: '2026-11-13T10:00:00Z',
    tokens: { total: 100 }, turns: [{ startedAt: '2026-11-13T10:00:01Z', tokens: { total: 100, input: 70, output: 30 }, model: 'gpt-5' }], turnCount: 1 }] };
  renderSessionDetail({ detail });
  const exchange = els.sessionDetail.querySelector('.detail-exchange');
  exchange.querySelector('.detail-ex-head').click();
  const heading = els.sessionDetailHead.querySelector('.detail-heading'); heading.tabIndex = 0; heading.focus();
  const turn = exchange.querySelector('.detail-turn');
  for (let i = 0; i < 2; i++) {
    detail.exchanges[0].tokens.total++; detail.exchanges[0].turns[0].tokens.total++;
    renderSessionDetail({ detail, preserveScroll: true });
    assert(els.sessionDetail.querySelector('.detail-exchange') === exchange, 'exchange identity');
    assert(exchange.querySelector('.detail-turn') === turn, 'turn identity');
    assert(exchange.classList.contains('expanded'), 'exchange stays expanded');
    assert(document.activeElement === heading, 'detail heading retains focus');
  }
  exchange.querySelector('.detail-ex-head').click();
  assert(!exchange.classList.contains('expanded'), 'retained exchange handler still toggles current turns');
  const rawMember = { ...raw, sessionKind: 'background-review', costUsd: 1 };
  const parent = { kind: 'session-group', summary: { name: 'Reviews', groupRows: sessionRowsApi.sessionRowsForPeriod({ sessions: { 'codex:test': rawMember } }) } };
  state.openSession = parent; renderSessionGroupDetail(parent);
  const member = els.sessionDetail.querySelector('.session-group-run');
  const memberModel = member.querySelector('.session-models'); memberModel.focus();
  for (let i = 2; i < 4; i++) {
    parent.summary.groupRows = sessionRowsApi.sessionRowsForPeriod({ sessions: { 'codex:test': { ...rawMember, costUsd: i, totalTokens: 4000 + i } } });
    renderSessionGroupDetail(parent);
    assert(els.sessionDetail.querySelector('.session-group-run') === member, 'review group member identity');
    assert(member.querySelector('.session-models') === memberModel && document.activeElement === memberModel, 'review group focused model identity');
  }
  member.click();
  assert(state.openSession.sessionCost === 3, 'retained navigation handler uses current row data');
  state.breakdown = 'trends'; state.period = 'today';
  els.trendsPanel.classList.remove('hidden');
  renderTrends();
  const spark = els.trendsPanel.querySelector('.trends-spark'); spark.focus();
  const trendTooltip = document.querySelector('.trends-tooltip');
  for (let i = 0; i < 2; i++) {
    const before = trendTooltip.textContent;
    state.stats.periods.today.totalTokens += 100000; renderTrends();
    assert(els.trendsPanel.querySelector('.trends-spark') === spark, 'Trends chart retained');
    assert(document.activeElement === spark && trendTooltip.dataset.visible === 'true', 'Trends focus and tooltip survive pushes');
    assert(trendTooltip.textContent !== before, 'Trends reading updates while focused');
  }
  return 'PASS actual App Limits, Sessions list, review groups, transcript and Trends DOM retention';
})()
