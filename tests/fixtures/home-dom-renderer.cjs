/* eslint-disable no-unused-vars, no-undef -- Evaluated beside extracted app.js functions by test-home-dom.cjs. */
'use strict';
const assert = require('node:assert/strict');
const load = file => require(root + '/src/electron/renderer/' + file);
const charts = load('usageCharts');
window.TokenMonitorUsageCharts = charts;
window.TokenMonitorSessionLive = require(root + '/src/shared/sessionLive');
const homeOverviewApi = load('homeOverview');
const homeModulePreferencesApi = load('homeModulePreferences');
const sessionRowsApi = load('sessionRows');
const limitProviderPresentationApi = load('limits/providerPresentation');
const { clientColors, fallbackModelColors } = charts;
const { limitFillPercent } = load('limits/displayMode');
const optionalFiniteNumber = n => n == null ? null : Number(n);
const isCreditsWindow = w => w.metric === 'credits';
let homeSessionRenderPending = false;
const pluginContent = null;
const homeActivityProgrammaticScrollers = new WeakSet();
const homeDom = load('homeDom').create();
let homeActivityScroller = null;
const t = (key, args) => key + (args ? ' ' + Object.values(args).join(' ') : '');
const formatCompact = n => String(n), formatPercent = n => n.toFixed(1) + '%';
const stableColor = () => '#abcdef', deviceAccent = '#abc', deviceStaleColor = '#888';
const VIEW_ICON_CLASSES = {};
const renderBreakdownChange = () => {}, openHomeSettings = () => {}, openTrendSettings = () => {};
const loadHomeHistory = () => {};
const visibleStatsSurface = () => 'main';
const prefersReducedMotion = () => false;
const sessionTooltipShouldHoldRender = () => false;
const sessionPresentationOptions = () => ({});
const compactMonthLabel = value => value, trendShortLabel = value => value;
const formatLimitBoundary = () => '2h', formatHomeLimitWindowValue = w => w.remainingPercent + '%';
const iconKindFor = () => 'dot';
const applyHomeListMark = mark => { mark.className = 'home-list-mark'; };
const now = Date.now();
const tools = Array.from({ length: 10 }, (_, i) => ({ key: 'tool-' + i, name: 'Tool ' + i, value: (10 - i) * 100000, color: '#abc' }));
const models = Array.from({ length: 10 }, (_, i) => ({ key: 'model-' + i, name: 'Model ' + i, value: (10 - i) * 100000, color: '#abc' }));
const sessions = Array.from({ length: 20 }, (_, i) => ({ key: 'session-' + i, client: 'codex', title: 'A long ongoing engineering task with a title that overflows the card ' + i, totalTokens: 100000 + i, model: 'gpt-5', models: { 'gpt-5': 100000 }, lastUsedAt: new Date(now - i * 60000).toISOString() }));
const devices = Array.from({ length: 8 }, (_, i) => ({ deviceId: 'device-' + i, displayName: 'Computer ' + i, platform: 'darwin', periods: { today: { totalTokens: 10000 * (8 - i) } } }));
const limits = Array.from({ length: 6 }, (_, i) => ({ key: 'account-' + i, providerId: 'codex', name: 'Account ' + i, color: '#abc', windows: [{ kind: 'session', label: 'Session', remainingPercent: 75, detailEntries: [['Used', '25%']] }, { kind: 'weekly', label: 'Weekly', remainingPercent: 60, detailEntries: [['Used', '40%']] }] }));
const daily = Array.from({ length: 365 }, (_, i) => ({ date: charts.localDayKey(new Date(now - (364 - i) * 86400000)), tokens: 100000 + i * 300, costUsd: 2 + i / 100 }));
const state = { period: 'today', breakdown: 'home', settings: { historyEnabled: true, homeModuleCounts: { tool: 10, model: 10, device: 8, session: 20 }, homeLimitDisplayMode: 'bars' }, stats: { periods: { today: { totalTokens: 5500000, clients: Object.fromEntries(tools.map(r => [r.key, r.value])) } }, historyPreview: { daily, summary: { activeDays: 365, activeDaysComplete: true } } }, homeActivityScrollLeft: null, homeActivityFollowEnd: true };
const limitWindowsView = load('limits/windowsView').createLimitWindowsView({ document, t, tooltip: { hasOpened: () => false, markOpened() {}, release() {} }, settings: () => state.settings, presentation: limitProviderPresentationApi, formatCompact, formatPercent, optionalFiniteNumber, limitFillPercent, colorWithAlpha: color => color, applyBarScale: (node, scale) => node.style.setProperty('--bar-scale', scale) });
const overflowText = load('overflowText').create({ document, window, prefersReducedMotion: () => false });
const bindHoverMarquee = node => overflowText.bind(node);
const homeLimitRows = () => limits;
const homeToolSourceRows = () => tools;
const modelRowsForPeriod = () => models;
const fixedPeriodDevices = () => devices;
const ids = ['limits', 'tool', 'model', 'session', 'device', 'trends'];
const homeModuleIds = () => ids;
window.TokenMonitorEdgeDockPresentation = { ...load('edgeDock/presentation'), recentSessionRows: () => sessions };
document.head.innerHTML = '<link rel="stylesheet" href="file://' + root + '/src/electron/renderer/styles.css">';
document.body.innerHTML = '<div class="home-panel" style="height:700px;overflow:auto"></div>';
const els = { homePanel: document.querySelector('.home-panel') };
async function check() {
  renderHome();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(document.querySelector('.home-activity-scroll').scrollWidth > document.querySelector('.home-activity-scroll').clientWidth, 'real heatmap overflow');
  assert.ok(els.homePanel.scrollHeight > els.homePanel.clientHeight, 'real panel overflow');
  const row = document.querySelector('.home-session-row');
  const trigger = document.querySelector('.home-limit-window .limit-detail-tooltip-trigger');
  const tooltip = trigger.parentNode.querySelector('[popover]');
  const scroller = document.querySelector('.home-activity-scroll');
  const cell = scroller.querySelector('.heat[data-d]');
  const marquee = row.querySelector('.home-list-name');
  trigger.focus();
  trigger.parentNode.dispatchEvent(new PointerEvent('pointerenter'));
  marquee.dispatchEvent(new MouseEvent('mouseenter', { clientX: 30, clientY: 30 }));
  scroller.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 40, bubbles: true }));
  cell.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 40, bubbles: true }));
  els.homePanel.scrollTop = 140;
  scroller.scrollLeft = 100;
  await new Promise(resolve => setTimeout(resolve, 20));
  // A user scroll dismisses the heatmap tooltip; open it again before pushes.
  cell.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 40, bubbles: true }));
  const scrollLeft = scroller.scrollLeft, scrollTop = els.homePanel.scrollTop;
  assert.ok(scrollLeft > 0 && scrollTop > 0, 'both scroll positions are nonzero');
  const identities = [...els.homePanel.querySelectorAll('.home-module, .home-list-row, .home-limit-account, .home-limit-window, .heat[data-d]')];
  for (let i = 0; i < 2; i++) {
    sessions[0].totalTokens++;
    tools[0].value++;
    limits[0].windows[0].detailEntries = [['Used', (26 + i) + '%']];
    renderHome();
  }
  const survived = { nodes: identities.every(node => node.isConnected), focus: document.activeElement === trigger, popover: tooltip.matches(':popover-open'), scroller: document.querySelector('.home-activity-scroll') === scroller, scroll: scroller.scrollLeft === scrollLeft && els.homePanel.scrollTop === scrollTop, heatmapTooltip: document.querySelector('.home-heatmap-tooltip').dataset.visible === 'true' };
  if (assertPreservation) {
    for (const [name, ok] of Object.entries(survived)) assert.ok(ok, name);
    assert.equal(tooltip.textContent.includes('27%'), true, 'open tooltip content updates');
    assert.equal(row.querySelector('.home-list-value').textContent, String(sessions[0].totalTokens));
    assert.ok(marquee.classList.contains('is-hover-reading'), 'marquee keeps reading');
    // Adding/removing tooltip capability changes its event-listener lifecycle.
    for (const modelCount of [2, 1, 2]) {
      sessions[0].models = modelCount === 1 ? { 'gpt-5': 100000 } : { 'gpt-5': 100000, 'gpt-5-mini': 5000 };
      renderHome();
      assert.equal(document.querySelector('.home-session-row'), row);
      const label = row.querySelector('.session-models');
      const popover = label.querySelector('[popover]');
      if (modelCount === 1) { assert.equal(popover, null); continue; }
      label.dispatchEvent(new PointerEvent('pointerenter'));
      assert.equal(popover.matches(':popover-open'), true, 'new model tooltip opens on hover');
      label.dispatchEvent(new PointerEvent('pointerleave'));
      assert.equal(popover.matches(':popover-open'), false);
      label.focus();
      assert.equal(popover.matches(':popover-open'), true, 'new model tooltip opens on focus');
      const content = popover.textContent;
      sessions[0].models['gpt-5-mini']++;
      renderHome();
      assert.equal(row.querySelector('.session-models'), label);
      assert.equal(label.querySelector('[popover]'), popover);
      assert.equal(document.activeElement, label);
      assert.equal(popover.matches(':popover-open'), true);
      assert.notEqual(popover.textContent, content, 'open model tooltip updates in place');
      label.blur();
    }
    sessions[0].models = { 'gpt-5': 100000 }; renderHome();

    // Ranking changes and optional fields must not move focus to a different row.
    const firstTool = document.querySelector('.home-tool-row'); firstTool.tabIndex = 0; firstTool.focus();
    tools[1].value = tools[0].value + 100;
    renderHome();
    assert.equal(document.activeElement, firstTool);
    assert.equal(document.querySelectorAll('.home-tool-row')[1], firstTool);
    // Exercise the real clock callback without waiting a minute.
    const sessionName = row.querySelector('.home-list-name'); sessionName.tabIndex = 0; sessionName.focus();
    const originalSetTimeout = window.setTimeout;
    let repaint;
    window.setTimeout = callback => { repaint = callback; return 0; };
    try {
      scheduleHomeSessionRepaint(sessions);
      for (let i = 0; i < 2; i++) {
        sessions[0].totalTokens++; repaint();
        assert.equal(document.activeElement, sessionName, 'clock repaint preserves focused session name');
        assert.equal(document.querySelector('.home-session-row'), row);
        assert.equal(row.querySelector('.home-list-value').textContent, String(sessions[0].totalTokens));
      }
    } finally { window.setTimeout = originalSetTimeout; }
    // A removed logical row must really disappear, not be recycled as its neighbour.
    const removed = document.querySelector('.home-tool-row');
    tools.splice(1, 1); renderHome(); assert.equal(removed.isConnected, false);
    tools.splice(1, 0, { key: 'replacement', name: 'Replacement', value: 999999, color: '#abc' }); renderHome();
    assert.equal(document.querySelectorAll('.home-tool-row').length, 10);
    // Optional siblings do not replace the next stable slot.
    const windows = document.querySelector('.home-limit-windows');
    limits[0].plan = 'Pro'; renderHome(); assert.equal(document.querySelector('.home-limit-windows'), windows);
    delete limits[0].plan; renderHome(); assert.equal(document.querySelector('.home-limit-windows'), windows);
    state.animateChartsOnRender = true; renderHome();
    assert.equal(state.animateChartsOnRender, false, 'returning to a retained activity module still reveals its charts');
    ids.splice(0, ids.length); renderHome();
    const empty = document.querySelector('.home-empty'); empty.querySelector('button').focus();
    renderHome(); assert.equal(document.querySelector('.home-empty'), empty);
    assert.equal(document.activeElement, empty.querySelector('button'), 'empty Home action retains focus');
    ids.push('limits', 'tool', 'model', 'session', 'device', 'trends'); renderHome();
    const snapshot = html => { const element = document.createElement('div'); element.innerHTML = html; return element; };
    const controls = homeDom.reconcile(null, snapshot('<input data-key="draft" class="draft" aria-invalid="true" style="opacity:.5"><button data-key="action">Old</button>'));
    document.body.append(controls);
    const input = controls.firstChild; input.value = 'unsubmitted'; input.focus();
    input.classList.add('is-reading'); input.style.transform = 'translateX(4px)';
    homeDom.reconcile(controls, snapshot('<button data-key="action">New</button><input data-key="draft" class="draft is-disabled" style="opacity:1">'));
    assert.equal(controls.lastChild, input); assert.equal(document.activeElement, input);
    assert.equal(input.value, 'unsubmitted'); assert.equal(input.hasAttribute('aria-invalid'), false);
    assert.ok(input.classList.contains('is-reading') && input.classList.contains('is-disabled'));
    assert.equal(input.style.transform, 'translateX(4px)'); assert.equal(input.style.opacity, '1');
    controls.remove();


  }
  tools.splice(0, tools.length, ...Array.from({ length: 10 }, (_, i) => ({ key: 'tool-' + i, name: 'Tool ' + i, value: (10 - i) * 100000, color: '#abc' })));
  renderHome();
  stopHomeSessionRepaint();
  // Time the actual Home render including subtree creation, reconciliation and
  // synchronous layout. Alternate token values; do not benchmark a no-op cache.
  const times = [];
  for (let i = 0; i < 120; i++) {
    sessions[0].totalTokens++;
    const start = performance.now(); renderHome(); void els.homePanel.offsetHeight;
    if (i >= 20) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  stopHomeSessionRepaint();
  return { baseline, survived, payload: { bytes: JSON.stringify({ stats: state.stats, tools, models, sessions, devices, limits }).length, limits: 6, windows: 12, tools: 10, models: 10, sessions: 20, devices: 8, days: 365 }, renderMs: { samples: times.length, median: times[50], p95: times[95] }, elements: els.homePanel.querySelectorAll('*').length };
}
