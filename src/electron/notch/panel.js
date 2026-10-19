'use strict';

const { normalizeEdgeDockItems } = require('../renderer/edgeDock/items');
const { connectedLimitProviders } = require('../renderer/edgeDock/presentation');
const { localDayKey, dayKeyAddDays } = require('../../shared/history');

const NOTCH_WEEK_DAYS = 7;

// The open panel draws fixed readouts instead of a user-composed card list.
// Stored notchItems still choose which limit providers appear, in what order
// and with which hidden accounts; their usage items have no panel slot.
const NOTCH_PANEL_STAT_ITEMS = Object.freeze([
  Object.freeze({ type: 'stat', metric: 'today' }),
  Object.freeze({ type: 'stat', metric: 'month' }),
  Object.freeze({ type: 'stat', metric: 'sessions', runningOnly: false, groupBy: 'none', cellDetail: 'clients' }),
  Object.freeze({ type: 'stat', metric: 'liveRate' })
]);

// null keeps the automatic choice: every provider that reports something.
function notchLimitItems(settings = {}) {
  const configured = normalizeEdgeDockItems(settings.notchItems);
  return configured ? configured.filter((item) => item.type === 'limit') : null;
}

function notchPanelItems(stats, settings = {}) {
  const limits = notchLimitItems(settings) || connectedLimitProviders(stats, {
    limitsEnabled: settings.limitsEnabled !== false,
    limitProviders: settings.limitProviders,
    limitProviderOrder: settings.limitProviderOrder
  }).map((provider) => ({
    type: 'limit', provider, hiddenAccounts: [], showSessions: false,
    windowKey: '', accountMode: provider === 'codex' ? 'active' : 'lowest'
  }));
  return [...limits.map((item) => ({ ...item, windowKey: '', showUsage: false, showSessions: false })), ...NOTCH_PANEL_STAT_ITEMS];
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// The seven days ending today. Past days come from History's preview; today
// comes from the live period so the newest bar moves with every push.
function notchWeek(stats, now = new Date(), history = stats?.historyPreview) {
  const todayKey = localDayKey(now);
  const daily = new Map((history?.daily || []).map((day) => [String(day.date).slice(0, 10), day]));
  const today = stats?.periods?.today;
  const days = [];
  for (let offset = NOTCH_WEEK_DAYS - 1; offset >= 0; offset -= 1) {
    const date = dayKeyAddDays(todayKey, -offset);
    const day = date === todayKey && today ? { tokens: today.totalTokens, cost: today.costUsd, unpricedTokens: today.unpricedTokens }
      : daily.get(date) || (history?.complete ? { tokens: 0, cost: 0 } : null);
    const clients = Object.entries(day?.perClient || {}).map(([client, value]) => ({ client, tokens: finite(value.tokens) }))
      .filter((entry) => entry.tokens > 0).sort((a, b) => b.tokens - a.tokens);
    days.push({ date, tokens: day ? finite(day.tokens) : null, costUsd: day ? finite(day.cost) : null, unpricedTokens: finite(day?.unpricedTokens), clients });
  }
  const clients = Object.entries(today?.clients || {})
    .map(([client, tokens]) => ({ client, tokens: finite(tokens) }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  return {
    days,
    // Past days are whole only when every joined device answered for History.
    complete: history?.complete === true,
    todayClients: clients,
    available: days.some((day, index) => index < days.length - 1 && day.tokens !== null)
  };
}

module.exports = { NOTCH_PANEL_STAT_ITEMS, NOTCH_WEEK_DAYS, notchLimitItems, notchPanelItems, notchWeek };
