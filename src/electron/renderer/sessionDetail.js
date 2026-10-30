'use strict';

(function exposeSessionDetail(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSessionDetail = api;
})(typeof window !== 'undefined' ? window : null, function createSessionDetailApi() {
  const nonReplyLabels = {
    'compaction-summary': 'Compaction summary',
    'assistant-attempt': 'Model attempt',
    'branch-summary': 'Branch summary',
    'tool-usage': 'Tool usage',
    'cache-warm': 'Cache warming',
    usage: 'Usage'
  };

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

  function turnRow(turn, index, replyIndex) {
    return {
      key: `turn:${index}`,
      label: Object.hasOwn(nonReplyLabels, turn.type) ? nonReplyLabels[turn.type] : `Reply #${replyIndex + 1}`,
      value: finiteNumber(turn.tokens && turn.tokens.total),
      tokensAvailable: turn.tokensAvailable !== false,
      cost: finiteNumber(turn.costEstimate),
      ...(turn.unpricedTokens > 0 ? { unpricedTokens: finiteNumber(turn.unpricedTokens) } : {}),
      tokens: turn.tokens || {},
      tools: formatToolList(turn.tools)
    };
  }

  function turnRows(turns) {
    let replyIndex = 0;
    return (turns || []).map((turn, index) => {
      const row = turnRow(turn, index, replyIndex);
      if (!Object.hasOwn(nonReplyLabels, turn.type)) replyIndex += 1;
      return row;
    });
  }

  function timeValue(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
  }

  function exchangeRows(detail, options = {}) {
    const now = options.now || new Date();
    const sortBy = options.sortBy === 'tokens' ? 'tokens' : 'time';
    const exchanges = (detail && detail.exchanges) || [];
    const occurrences = new Map();
    const rows = exchanges.map((ex) => {
      // Appending replies or changing display order must not change identity.
      // Disambiguate repeated prompts in transcript order, including missing times.
      const identity = JSON.stringify([ex.startedAt || '', ex.promptPreview || '']);
      const occurrence = occurrences.get(identity) || 0;
      occurrences.set(identity, occurrence + 1);
      const turnCount = finiteNumber(ex.turnCount);
      const toolCount = (ex.tools || []).length;
      const subtitleParts = [
        compactTime(ex.startedAt, now),
        `${turnCount} turn${turnCount === 1 ? '' : 's'}`,
        toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : ''
      ].filter(Boolean);
      return {
        key: `exchange:${identity}:${occurrence}`,
        isPrompt: Boolean(ex.promptPreview),
        title: ex.promptPreview ? ex.promptPreview : '(session start)',
        subtitle: subtitleParts.join(' · '),
        value: finiteNumber(ex.tokens && ex.tokens.total),
        tokensAvailable: ex.tokensAvailable !== false,
        cost: finiteNumber(ex.costEstimate),
        ...(ex.unpricedTokens > 0 ? { unpricedTokens: finiteNumber(ex.unpricedTokens) } : {}),
        startTime: timeValue(ex.startedAt),
        turnCount,
        turns: turnRows(ex.turns) // usage entries stay chronological; summaries do not consume reply numbers
      };
    });
    if (sortBy === 'tokens') rows.sort((a, b) => b.value - a.value || b.startTime - a.startTime);
    else rows.sort((a, b) => b.startTime - a.startTime || b.value - a.value);
    return rows;
  }

  return { exchangeRows, formatToolList };
});
