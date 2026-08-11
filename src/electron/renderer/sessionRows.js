'use strict';

(function exposeSessionRows(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSessionRows = api;
})(typeof window !== 'undefined' ? window : null, function createSessionRowsApi(root) {
  const reasonixSessionGuard = typeof module === 'object' && module.exports
    ? require('../../shared/reasonixSessionGuard')
    : root?.TokenMonitorReasonixSessionGuard;
  const isReasonixSyntheticSession = reasonixSessionGuard?.isReasonixSyntheticSession || (() => false);
  const fallbackColors = ['#6ab4f0', '#cc7c5e', '#a57df0', '#49a3b0', '#f0d66a', '#f06a7b'];

  function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function formatNumber(value) {
    return Math.round(finiteNumber(value)).toLocaleString('en-US');
  }

  function stableColor(value, colors = fallbackColors) {
    let hash = 0;
    for (const char of String(value || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return colors[Math.abs(hash) % colors.length] || fallbackColors[0];
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function validDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  function sameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  function compactSessionTime(value, now = new Date()) {
    const date = validDate(value);
    if (!date) return '';
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    return sameLocalDay(date, now)
      ? time
      : `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${time}`;
  }

  function sessionIdLabel(id) {
    const raw = String(id || '').trim();
    if (!raw) return '';
    const reasonixPrefix = raw.match(/^reasonix:/i);
    const reasonixLabel = reasonixPrefix ? raw.slice(reasonixPrefix[0].length) : raw;
    if (reasonixLabel.toLowerCase().startsWith('reasonix-stats:')) return '';
    if (reasonixPrefix) return reasonixLabel;
    if (raw.toLowerCase().startsWith('reasonix-stats:')) return '';
    const rollout = raw.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}-(.+)$/);
    if (rollout) return rollout[1];
    if (/^\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}/.test(raw)) return '';
    return raw;
  }

  function sessionModelLabel(session) {
    const models = Object.entries(session?.models || {})
      .filter(([, value]) => finiteNumber(value) > 0)
      .map(([model]) => model)
      .sort();
    if (models.length === 0) return '';
    if (models.length === 1) return models[0];
    return `${models.length} models`;
  }

  function sessionTimestampValue(session) {
    const date = validDate(session?.lastUsedAt || session?.startedAt);
    return date ? date.getTime() : 0;
  }

  function sessionActivityLabel(session, now) {
    return compactSessionTime(session?.lastUsedAt || session?.startedAt, now);
  }

  function textValue(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function sessionTitleParts(session, labels, fallbackLabel = 'Session', explicitModel = '') {
    const client = textValue(session?.client);
    const clientLabel = labels[client] || client || fallbackLabel;
    const modelLabel = textValue(explicitModel) || sessionModelLabel(session);
    return {
      client,
      clientLabel,
      modelLabel,
      titleParts: [clientLabel, modelLabel].filter(Boolean)
    };
  }

  function messageLabel(session) {
    const count = finiteNumber(session?.messageCount);
    return count > 0 ? `${formatNumber(count)} msg${count === 1 ? '' : 's'}` : '';
  }

  function nativeSessionRow(session, key, options, now) {
    const periodTokenDataUnavailable = session?.periodTokenDataUnavailable === true;
    // Native telemetry is cumulative for a resumed Branch, but it remains a
    // trusted conversation total. Only an actually missing native total is
    // unavailable; periodTokenDataUnavailable is reserved for aggregation so
    // the same lifetime value is never counted as today's project usage.
    const tokenDataUnavailable = session?.tokenDataUnavailable === true;
    const value = tokenDataUnavailable ? 0 : finiteNumber(session?.totalTokens);
    if (value <= 0 && !tokenDataUnavailable) return null;
    const labels = options.clientLabels || {};
    const colors = options.clientColors || {};
    const stable = typeof options.stableColor === 'function' ? options.stableColor : stableColor;
    const palette = options.fallbackColors || fallbackColors;
    const client = textValue(session?.client) || 'reasonix';
    const { clientLabel, titleParts } = sessionTitleParts(
      { ...session, client },
      labels,
      'Reasonix',
      session?.model
    );
    const subtitleParts = [
      sessionActivityLabel(session, now),
      messageLabel(session)
    ].filter(Boolean);
    return {
      key: `session:${key}`,
      kind: 'session',
      name: titleParts.join(' · '),
      subtitle: subtitleParts.join(' · '),
      detail: sessionIdLabel(session?.sessionId || key),
      value,
      tokenDataUnavailable,
      periodTokenDataUnavailable,
      // A reported session cost is the same trusted conversation-level value
      // as the cumulative token total. Do not hide it merely because the
      // period cannot be split exactly.
      cost: tokenDataUnavailable ? 0 : finiteNumber(session?.reportedCostUsd),
      sessionDetailAvailable: session?.sessionDetailAvailable === true,
      color: colors[client] || stable(key, palette),
      stale: false,
      client,
      sortTime: sessionTimestampValue(session),
      title: `${clientLabel} session ${sessionIdLabel(session?.sessionId || key)}`
    };
  }

  function sessionRowsForPeriod(period, options = {}) {
    const labels = options.clientLabels || {};
    const colors = options.clientColors || {};
    const colorForModel = typeof options.modelColor === 'function' ? options.modelColor : null;
    const stable = typeof options.stableColor === 'function' ? options.stableColor : stableColor;
    const palette = options.fallbackColors || fallbackColors;
    const archivedLabel = options.archivedLabel || 'Archived';
    const now = options.now || new Date();
    const rows = Object.entries(period?.sessions || {})
      .map(([key, session]) => {
        if (isReasonixSyntheticSession(session, key)) return null;
        const value = finiteNumber(session?.totalTokens);
        if (value <= 0) return null;
        const { client, titleParts, clientLabel, modelLabel } = sessionTitleParts(session, labels);
        const sessionId = session?.sessionId || key;
        const archived = session?.archived === true || session?.deleted === true || session?.sourceDeleted === true;
        const subtitleParts = [
          archived ? archivedLabel : '',
          sessionActivityLabel(session, now),
          messageLabel(session)
        ].filter(Boolean);
        return {
          key: `session:${key}`,
          kind: 'session',
          name: titleParts.join(' · '),
          subtitle: subtitleParts.join(' · '),
          detail: sessionIdLabel(sessionId),
          value,
          cost: finiteNumber(session?.costUsd),
          color: colors[client] || (modelLabel && colorForModel ? colorForModel(modelLabel) : stable(key, palette)),
          stale: false,
          archived: archived || undefined,
          client,
          sortTime: sessionTimestampValue(session),
          title: `${clientLabel} session${sessionIdLabel(sessionId) ? ` ${sessionIdLabel(sessionId)}` : ''}`
        };
      })
      .filter(Boolean);
    for (const [key, session] of Object.entries(options.nativeSessions || {})) {
      const row = nativeSessionRow(session, key, options, now);
      if (row) rows.push(row);
    }
    return rows.sort((a, b) => b.sortTime - a.sortTime || b.value - a.value || b.cost - a.cost || a.name.localeCompare(b.name));
  }

  function sessionBreakdownIncomplete(stats, periodName) {
    const omitted = stats?.sessionDetailsOmitted || {};
    if (periodName === 'today') return finiteNumber(omitted.today) > 0;
    if (periodName === 'month') return finiteNumber(omitted.month) > 0;
    return false;
  }

  function archivedSessionCount(stats) {
    const periods = stats?.periods && typeof stats.periods === 'object' ? stats.periods : stats;
    const archivedKeys = new Set();
    for (const periodName of ['today', 'month', 'allTime']) {
      for (const [key, session] of Object.entries(periods?.[periodName]?.sessions || {})) {
        if (isReasonixSyntheticSession(session, key)) continue;
        if (session?.archived !== true && session?.deleted !== true && session?.sourceDeleted !== true) continue;
        archivedKeys.add(`${session?.client || ''}:${session?.sessionId || key}`);
      }
    }
    return archivedKeys.size;
  }

  return {
    archivedSessionCount,
    compactSessionTime,
    sessionBreakdownIncomplete,
    sessionIdLabel,
    sessionRowsForPeriod
  };
});
