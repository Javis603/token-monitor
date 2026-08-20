'use strict';

(function exposeSessionDetail(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSessionDetail = api;
})(typeof window !== 'undefined' ? window : null, function createSessionDetailApi() {
  function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function compactTime(value, now) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    return sameDay ? time : `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${time}`;
  }

  function formatToolList(tools) {
    return Array.from(new Set((tools || []).filter(Boolean))).join(' · ');
  }

  function turnRow(turn, index) {
    return {
      key: `turn:${index}`,
      label: `Reply #${index + 1}`,
      value: finiteNumber(turn.tokens && turn.tokens.total),
      tokensAvailable: turn.tokensAvailable !== false,
      cost: finiteNumber(turn.costEstimate),
      tokens: turn.tokens || {},
      tools: formatToolList(turn.tools)
    };
  }

  function timeValue(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
  }

  function exchangeRows(detail, options = {}) {
    const now = options.now || new Date();
    const sortBy = options.sortBy === 'tokens' ? 'tokens' : 'time';
    const exchanges = (detail && detail.exchanges) || [];
    const rows = exchanges.map((ex, i) => {
      const turnCount = finiteNumber(ex.turnCount);
      const toolCount = (ex.tools || []).length;
      const subtitleParts = [
        compactTime(ex.startedAt, now),
        `${turnCount} turn${turnCount === 1 ? '' : 's'}`,
        toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : ''
      ].filter(Boolean);
      return {
        key: `exchange:${i}`,
        isPrompt: Boolean(ex.promptPreview),
        title: ex.promptPreview ? ex.promptPreview : '(session start)',
        subtitle: subtitleParts.join(' · '),
        value: finiteNumber(ex.tokens && ex.tokens.total),
        tokensAvailable: ex.tokensAvailable !== false,
        cost: finiteNumber(ex.costEstimate),
        startTime: timeValue(ex.startedAt),
        turnCount,
        turns: (ex.turns || []).map(turnRow) // inner turns kept in chronological (file) order
      };
    });
    if (sortBy === 'tokens') rows.sort((a, b) => b.value - a.value || b.startTime - a.startTime);
    else rows.sort((a, b) => b.startTime - a.startTime || b.value - a.value);
    return rows;
  }

  return { exchangeRows, formatToolList };
});
