'use strict';

(function exposeAccountRows(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorAccountRows = api;
})(typeof window !== 'undefined' ? window : null, function createAccountRowsApi() {
  const fallbackColors = ['#6ab4f0', '#cc7c5e', '#a57df0', '#49a3b0', '#f0d66a', '#f06a7b'];

  function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function stableColor(value, colors = fallbackColors) {
    let hash = 0;
    for (const char of String(value || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return colors[Math.abs(hash) % colors.length] || fallbackColors[0];
  }

  // A rollup key is `client:accountKey`, but accounts may also arrive as loose
  // objects (hub snapshots) where only client + accountKey fields identify the
  // row. Normalize to one row key so both shapes land in the same bucket.
  function accountRowKey(client, accountKey) {
    const clientName = String(client || '').trim();
    const account = String(accountKey || '').trim();
    if (!clientName || !account) return '';
    return `${clientName}:${account}`;
  }

  function accountLabel(accountKey, explicitLabel = '') {
    const label = String(explicitLabel || '').trim();
    if (label) return label;
    const raw = String(accountKey || '').trim();
    if (/^sha256:[a-f0-9]{64}$/i.test(raw)) return `…${raw.slice(-12)}`;
    return raw;
  }

  // Rows straight from the period's accounts rollup. Sessions remain the
  // fallback for snapshots that predate the rollup: attribution lives on the
  // session itself, so the same view keeps working against old data.
  function accountRowsForPeriod(period, options = {}) {
    if (!period || typeof period !== 'object') return [];
    const rows = new Map();
    const addAccount = (client, accountKey, explicitLabel, tokens, costUsd) => {
      const key = accountRowKey(client, accountKey);
      if (!key) return;
      if (!rows.has(key)) {
        rows.set(key, { key, client, accountKey, value: 0, cost: 0 });
      }
      const row = rows.get(key);
      const label = String(explicitLabel || '').trim();
      if (label && !row.accountLabel) row.accountLabel = label;
      row.value += Math.max(0, finiteNumber(tokens));
      row.cost += finiteNumber(costUsd);
    };

    const rollup = period.accounts && typeof period.accounts === 'object' ? period.accounts : null;
    if (rollup) {
      for (const entry of Object.values(rollup)) {
        if (!entry || typeof entry !== 'object') continue;
        addAccount(entry.client, entry.accountKey, entry.accountLabel, entry.tokens, entry.costUsd);
      }
    } else {
      for (const session of Object.values(period.sessions || {})) {
        if (!session || typeof session !== 'object') continue;
        addAccount(session.client, session.accountKey, session.accountLabel, session.totalTokens, session.costUsd);
      }
    }

    return Array.from(rows.values())
      .filter((row) => row.value > 0 || row.cost > 0)
      .map((row) => {
        const color = typeof options.stableColor === 'function'
          ? options.stableColor(row.key, options.fallbackColors || fallbackColors)
          : stableColor(row.key, options.fallbackColors);
        const clientLabel = row.client
          ? (options.clientLabels?.[row.client] || row.client)
          : '';
        return {
          ...row,
          name: accountLabel(row.accountKey, row.accountLabel),
          subtitle: clientLabel,
          detail: '',
          color,
          barBackground: color,
          stale: false
        };
      })
      .sort((a, b) => b.cost - a.cost || b.value - a.value || a.name.localeCompare(b.name));
  }

  return { accountRowKey, accountRowsForPeriod };
});
