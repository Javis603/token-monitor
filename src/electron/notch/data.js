'use strict';

const trayLayout = require('../../shared/trayLayout');
const trayText = require('../../shared/trayText');
const balance = require('../../shared/limits/balanceDisplay');
const { limitProviderForClient } = require('../../shared/limits/providers');
const presentation = require('../renderer/edgeDock/presentation');
const { notchWeek } = require('./panel');
const { normalizeNotchPluginPages, normalizeNotchBuiltinPages, normalizeNotchPageOrder } = require('../../shared/plugins/placements');

const NOTCH_SUMMARY_MODES = Object.freeze(['auto', 'sessions', 'tray', 'custom']);

// `auto` adapts to what is happening; `sessions` stays quiet between sessions;
// `tray` mirrors the menu-bar preset; `custom` reads the notch's own layout.
function notchSummaryMode(settings = {}) {
  return NOTCH_SUMMARY_MODES.includes(settings.notchSummaryMode) ? settings.notchSummaryMode : 'sessions';
}

// Ordinary tray presets select canonical provider/account pairs before layout.
// Custom layouts continue to use their own source selectors unchanged.
function trayQuotaPicks(stats, settings) {
  if (notchSummaryMode(settings) === 'custom') return null;
  const mode = settings.trayContent;
  if (mode === 'limitsAllSessions' || mode === 'barsAllSessions') return trayText.pickConfiguredLimitProviders(stats, settings);
  const pick = mode === 'barsSession' ? trayText.pickLimitProviderByKindPriority(stats, ['session', 'weekly'])
    : mode === 'barsWeekly' ? trayText.pickWorstLimitProvider(stats, { kind: 'weekly' })
      : mode === 'bars' ? trayText.pickWorstLimitProvider(stats) : undefined;
  return pick === undefined ? null : pick ? [pick] : [];
}

function summaryLayout(settings, stats, picks = trayQuotaPicks(stats, settings)) {
  if (notchSummaryMode(settings) === 'custom') return trayLayout.normalizeTrayLayout(settings.notchCustomLayout);
  const mode = settings.trayContent || 'tokens';
  if (mode === 'custom') return trayLayout.normalizeTrayLayout(settings.trayCustomLayout);
  const make = (style, id) => trayLayout.createTrayLayoutItem(style, { idFactory: () => id });
  const icon = make(['icon', 'liveTokenRate'].includes(mode) ? 'appIcon' : 'providerIcon', 'notch-icon');
  icon.autoMode = ['tokens', 'tokensAll', 'both', 'bothAll'].includes(mode) ? 'tokens'
    : ['cost', 'costAll'].includes(mode) ? 'cost' : 'lowestLimit';
  icon.period = mode.endsWith('All') ? 'allTime' : 'today';
  const items = [icon];
  const period = mode.endsWith('All') ? 'allTime' : 'today';
  if (['tokens', 'tokensAll', 'both', 'bothAll'].includes(mode)) items.push({ ...make('tokens', 'notch-tokens'), period });
  if (['cost', 'costAll', 'both', 'bothAll'].includes(mode)) items.push({ ...make('cost', 'notch-cost'), period, costFormat: 'full', costDecimals: 'auto' });
  if (mode === 'liveTokenRate') items.push(make('liveTokenRate', 'notch-rate'));
  if (picks) {
    if (picks.length) icon.source.provider = picks[0].provider;
    const pair = picks.length > 1
      ? picks.map(pick => ({ pick, window: pick.primaryWindow }))
      : picks.length ? [{ pick: picks[0], window: picks[0].primaryWindow }, { pick: picks[0], window: picks[0].secondaryWindow }] : [];
    const sourceFor = ({ pick, window }) => ({
      provider: pick.provider, accountMode: 'specific', accountKey: pick.providerRecord.accountKey || '',
      window: window ? trayLayout.windowKey(window) : 'secondary',
      valueMode: settings.showLimitUsed ? 'used' : 'remaining', creditsDisplay: 'percent'
    });
    if (mode === 'limitsAllSessions') {
      for (const [i, entry] of pair.filter(entry => entry.window).entries()) {
        items.push({ ...make('percent', `notch-limit-${i}`), source: sourceFor(entry) });
      }
    } else if (pair.length) {
      items.push({ ...make('doubleBar', 'notch-limits'), rows: pair.map(sourceFor) });
    } else {
      // The original bar preset falls back to today's tokens without quotas.
      items.push(make('tokens', 'notch-tokens'));
    }
  }
  return { version: trayLayout.VERSION, items };
}

// Numeric facts beside the existing tray-formatted string. Animation never
// reverse-parses localized compact text, currencies or provider labels.
function numericMeasure(item, resolved, stats) {
  if (!resolved.available) return null;
  if (item.metric === 'tokens' || item.metric === 'cost') {
    const period = stats?.periods?.[item.period];
    if (!period) return null;
    const provider = item.usageScope === 'recent' ? trayText.pickRecentUsageProviderId(stats) : null;
    const value = provider ? (item.metric === 'tokens' ? period.clients?.[provider] : period.clientCosts?.[provider])
      : (item.metric === 'tokens' ? period.totalTokens : period.costUsd);
    return value != null && Number.isFinite(Number(value)) ? { metric: item.metric, value: Number(value), costFormat: item.costFormat, costDecimals: item.costDecimals } : null;
  }
  if (item.metric === 'liveTokenRate') {
    const value = resolved.liveTokenRate?.[item.rateMode];
    return Number.isFinite(value) ? { metric: 'rate', value, rateMode: item.rateMode } : null;
  }
  if (item.metric === 'percent') {
    const selection = resolved.selection;
    if (!selection) return null;
    if (selection.moneyText && selection.source?.creditsDisplay !== 'percent') {
      return { metric: 'balance', value: balance.creditsAmount(selection.providerRecord, selection.window), currency: balance.creditsCurrency(selection.providerRecord, selection.window) };
    }
    return { metric: 'percent', value: selection.percent };
  }
  return null;
}

// The shared formatter remains the source of countdown strings. Keep the
// static headline separate so a local clock never parses a numeric reading.
function attachSummaryClock(row, metric, nowMs) {
  if (!['reset', 'percentReset'].includes(metric) || !row.selection) return;
  const resetsAt = row.selection.window.resetsAt;
  const countdown = trayLayout.formatResetCountdown(resetsAt, nowMs);
  const suffix = countdown ? ` · ${countdown}` : '';
  row.clock = { resetsAt, headline: metric === 'percentReset' ? (suffix && row.text.endsWith(suffix) ? row.text.slice(0, -suffix.length) : row.text) : '' };
}

// The shared projection's severity covers the selected account's tightest
// metered pool, which can differ from its headline. Keep ranking and readout
// tied to that same value without rescanning hidden or unselected accounts.
function notchAlert(cells, settings) {
  if (settings.limitsEnabled === false) return null;
  let worst = null;
  for (const cell of cells) {
    const remainingPercent = cell.severityPercent;
    if (cell.kind !== 'provider' || cell.status !== 'ok' || !Number.isFinite(remainingPercent)) continue;
    if (presentation.remainingSeverity(remainingPercent) !== 'critical') continue;
    if (!worst || remainingPercent < worst.remainingPercent) worst = { provider: cell.provider, remainingPercent };
  }
  return worst;
}

function notchActivity(cells, nowMs = Date.now()) {
  const sessions = cells.find((cell) => cell.metric === presentation.SESSIONS_METRIC)?.sessions || [];
  const running = presentation.runningSessionSummary(sessions, nowMs);
  const waiting = presentation.waitingSessionSummary(sessions, nowMs);
  if (!running.count && !waiting.count) return null;
  // A grouped session is drawn with the tool that is actually active, not its parent's.
  const waitingClients = presentation.sessionMembers(waiting.rows)
    .filter((row) => presentation.sessionActivityState(row, nowMs) === 'waiting')
    .map((row) => String(row.client || '').toLowerCase());
  const clients = [...new Set([...waitingClients, ...running.clients].filter(Boolean))];
  return { running: running.count, waiting: waiting.count, clients };
}

function activitySummary(cells, options, sessionOnly = false) {
  const activity = notchActivity(cells, options.nowMs);
  if (activity) {
    const providers = activity.clients.slice(0, 3);
    return { version: trayLayout.VERSION, needsClock: false, automatic: 'activity', sessionOnly, items: [
      ...providers.map((client, index) => ({ type: 'icon', id: `notch-activity-icon-${index}`, provider: client, available: true, selection: null })),
      { type: 'activity', id: 'notch-activity', available: true, running: activity.running, waiting: activity.waiting,
        provider: activity.clients[0] || '' }
    ] };
  }
  return null;
}

// Live work takes priority; a known low quota must not hide session activity.
function automaticSummary(stats, cells, settings, options) {
  const activity = activitySummary(cells, options);
  if (activity) return activity;
  const alert = notchAlert(cells, settings);
  if (alert) {
    const used = settings.showLimitUsed === true;
    const value = Math.round(used ? 100 - alert.remainingPercent : alert.remainingPercent);
    return { version: trayLayout.VERSION, needsClock: false, automatic: 'alert', items: [
      { type: 'icon', id: 'notch-alert-icon', provider: alert.provider, available: true, selection: null },
      { type: 'text', id: 'notch-alert', metric: 'percent', available: true, text: `${value}%`, unit: used ? 'used' : 'left',
        ...(settings.notchWarnColors === true ? { tone: 'alert' } : {}), measure: { metric: 'percent', value } }
    ] };
  }
  return null;
}

function automaticIdleLayout() {
  const make = (style, id) => trayLayout.createTrayLayoutItem(style, { idFactory: () => id });
  return { version: trayLayout.VERSION, items: [make('appIcon', 'notch-icon'), { ...make('tokens', 'notch-tokens'), period: 'today' }] };
}

function buildNotchData(stats, cells, settings, options = {}) {
  const panel = {
    week: notchWeek(stats, new Date(options.nowMs ?? Date.now()), settings.historyEnabled === false ? null : stats?.historyPreview),
    // Content arrives on the plugin channel; visibility and mixed order travel here.
    pageOrder: normalizeNotchPageOrder(settings.notchPageOrder),
    builtinPages: normalizeNotchBuiltinPages(settings.notchBuiltinPages),
    pluginPages: settings.pluginsEnabled === false ? [] : normalizeNotchPluginPages(settings.notchPluginPages)
  };
  if (settings.notchSummaryEnabled === false) return { cells, summary: null, panel };
  const mode = notchSummaryMode(settings);
  if (mode === 'sessions') return { cells, summary: activitySummary(cells, options, true), panel };
  if (mode === 'auto') {
    const automatic = automaticSummary(stats, cells, settings, options);
    if (automatic) return { cells, summary: automatic, panel };
  }
  const picks = mode === 'auto' ? null : trayQuotaPicks(stats, settings);
  const layout = mode === 'auto' ? automaticIdleLayout() : summaryLayout(settings, stats, picks);
  // Preserve the selected record even for legacy accounts without accountKey:
  // reselecting all records can borrow a secondary window from another account.
  const summaryStats = picks ? { ...stats, limits: { ...stats?.limits, providers: picks.map(pick => pick.providerRecord) } } : stats;
  const resolved = trayLayout.resolveTrayLayout(layout, summaryStats, options);
  resolved.needsClock = trayLayout.trayLayoutNeedsClock(layout);
  for (const output of resolved.items) {
    if (['bars', 'stack'].includes(output.type) && output.icon !== 'none') {
      output.iconProvider = output.icon === 'app' ? 'app' : trayLayout.preferredRowProvider(output.rows, output.icon === 'second' ? 1 : 0) || '?';
    }
  }
  const iconProviders = [...new Set(resolved.items.map(item => item.type === 'icon' ? item.provider : item.iconProvider)
    .filter(provider => provider && provider !== 'app').map(provider => limitProviderForClient(provider) || provider))];
  const missingIconProviders = iconProviders.filter(provider => !cells.some(cell => cell.provider === provider));
  const iconCells = missingIconProviders.length ? presentation.buildEdgeDockCells(stats, {
    ...settings, localDeviceId: settings.deviceId, ...(options.cellOptions || {}),
    items: missingIconProviders.map((provider) => ({ type: 'limit', provider }))
  }) : [];
  for (let i = 0; i < resolved.items.length; i += 1) {
    const item = layout.items[i];
    const output = resolved.items[i];
    output.measure = numericMeasure(item, output, stats);
    attachSummaryClock(output, item.metric, options.nowMs);
    const iconProvider = output.type === 'icon' ? output.provider : output.iconProvider;
    if (iconProvider && iconProvider !== 'app') {
      const provider = limitProviderForClient(iconProvider) || iconProvider;
      // Reuse a configured headline first. A standalone icon uses the same
      // provider projection, independent of whether either dock is enabled.
      const cell = cells.find((entry) => entry.provider === provider) || iconCells.find((entry) => entry.provider === provider);
      if (cell && settings.limitsEnabled !== false && Array.isArray(stats?.limits?.providers) && stats.limits.providers.some((record) => record.provider === provider)) output.providerCell = cell;
    }
    if (item.type === 'stack') {
      for (let j = 0; j < output.rows.length; j += 1) {
        const source = item.rows?.[j] || {};
        const metric = item.metric === 'mixed' ? source.metric : item.metric;
        output.rows[j].metric = metric;
        output.rows[j].measure = numericMeasure({ ...source, metric }, output.rows[j], stats);
        attachSummaryClock(output.rows[j], metric, options.nowMs);
      }
    }
  }
  return {
    cells,
    // An explicitly empty custom layout reuses the idle shell and hover target.
    summary: resolved.items.length ? resolved : null,
    panel
  };
}
module.exports = { NOTCH_SUMMARY_MODES, buildNotchData, notchSummaryMode, summaryLayout };
