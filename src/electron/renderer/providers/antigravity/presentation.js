// @ts-check
'use strict';

(function expose(/** @type {any} */ root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) (root.TokenMonitorProviderPresentationPolicies ||= {})['antigravity'] = policy;
})(typeof window !== 'undefined' ? window : null, function createPolicy() {
  /** @param {any} value */
  function normalizeId(value) { return String(value || '').trim().toLowerCase(); }
  const COMPACT_LIMIT_CRITICAL_PERCENT = 20;
  /** @param {any} window */
  function antigravityQuotaWindow(window) {
    const kind = normalizeId(window?.kind);
    const suffix = kind === 'session'
      ? /\s+5-hour$/i
      : kind === 'weekly'
        ? /\s+weekly$/i
        : null;
    const label = String(window?.label || '').trim();
    if (!suffix || !suffix.test(label)) return null;
    const groupLabel = label.replace(suffix, '').trim();
    if (!groupLabel) return null;
    return { groupLabel, windowLabel: kind === 'session' ? '5-hour' : 'Weekly' };
  }
  /** @param {any} window */
  function compactWindowRemaining(window) {
    const rawRemaining = window?.remainingPercent;
    const remaining = rawRemaining == null || String(rawRemaining).trim() === '' ? null : Number(rawRemaining);
    if (remaining != null && Number.isFinite(remaining)) return Math.max(0, Math.min(100, remaining));
    const rawUsed = window?.usedPercent;
    const used = rawUsed == null || String(rawUsed).trim() === '' ? null : Number(rawUsed);
    return used != null && Number.isFinite(used)
      ? Math.max(0, Math.min(100, 100 - used))
      : Number.POSITIVE_INFINITY;
  }
  /** @param {any} window */
  function antigravityQuotaWindowVisible(window) {
    // Grouped quotas keep their established layout, including disabled lanes.
    // Legacy model pools need a measured percentage to offer a useful row.
    return Boolean(antigravityQuotaWindow(window))
      || [window?.remainingPercent, window?.usedPercent].some(Number.isFinite);
  }
  /** @param {any} providerOrId @param {any[]} windows */
  function limitProviderCompactWindows(providerOrId, windows = []) {
    if (!windows) return windows;
    const visibleWindows = windows.every(antigravityQuotaWindowVisible)
      ? windows
      : windows.filter(antigravityQuotaWindowVisible);
    const entries = visibleWindows.map((window, index) => ({
      window,
      index,
      groupLabel: antigravityQuotaWindow(window)?.groupLabel || ''
    }));
    if (entries.length === 0 || entries.some((entry) => !entry.groupLabel)) return visibleWindows;
    /** @type {Map<string, {window: any, index: number, groupLabel: string}[]>} */
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.groupLabel)) groups.set(entry.groupLabel, []);
      groups.get(entry.groupLabel)?.push(entry);
    }
    /** @param {{window: any, index: number, groupLabel: string}[]} entries */
    const tightest = (entries) => entries.slice().sort((a, b) => {
      const aRemaining = compactWindowRemaining(a.window);
      const bRemaining = compactWindowRemaining(b.window);
      if (aRemaining !== bRemaining) return aRemaining - bRemaining;
      return a.index - b.index;
    })[0] || null;
    // Home filters hidden items before this pick. With one visible model
    // group, its two periods can occupy both compact slots.
    if (groups.size === 1) {
      return ['session', 'weekly']
        .map((kind) => tightest(entries.filter((entry) => normalizeId(entry.window?.kind) === kind)))
        .filter(Boolean)
        .map((entry) => entry.window);
    }
    const selected = [...groups.values()].map((groupEntries, groupIndex) => {
      const session = tightest(groupEntries.filter((entry) => normalizeId(entry.window?.kind) === 'session'));
      const weekly = tightest(groupEntries.filter((entry) => normalizeId(entry.window?.kind) === 'weekly'));
      const sessionRemaining = compactWindowRemaining(session?.window);
      const weeklyRemaining = compactWindowRemaining(weekly?.window);
      const weeklyIsCritical = weeklyRemaining < COMPACT_LIMIT_CRITICAL_PERCENT;
      const entry = !session
        ? weekly
        : !weekly
          ? session
          : weeklyRemaining < sessionRemaining && (weeklyIsCritical || !Number.isFinite(sessionRemaining))
            ? weekly
            : session;
      return { ...entry, groupIndex, remaining: compactWindowRemaining(entry.window) };
    });
    return selected
      .sort((a, b) => a.remaining - b.remaining || a.groupIndex - b.groupIndex)
      .slice(0, 2)
      .sort((a, b) => a.groupIndex - b.groupIndex)
      .map((entry) => entry.window);
  }
  /** @param {any} providerOrId @param {any} window @param {any[]} visibleWindows */
  function limitProviderCompactWindowLabel(providerOrId, window, visibleWindows = []) {
    const labels = (visibleWindows || []).map((candidate) => antigravityQuotaWindow(candidate)?.groupLabel || '');
    const quota = antigravityQuotaWindow(window);
    if (!labels.length || !quota || labels.some((label) => !label)) return '';
    const groups = new Set(labels);
    if (groups.size === 1 && groups.has(quota.groupLabel)) return `${quota.groupLabel} ${quota.windowLabel}`;
    return groups.size === labels.length ? quota.groupLabel : '';
  }
  /** @param {any} providerOrId @param {any} window @param {any[]} visibleWindows */
  function limitProviderCompactWindowPeriodLabel(providerOrId, window, visibleWindows = []) {
    const quota = antigravityQuotaWindow(window);
    // Single-group labels already include the period, even without reset data.
    return quota && limitProviderCompactWindowLabel(providerOrId, window, visibleWindows) === quota.groupLabel
      ? quota.windowLabel
      : '';
  }
  return /** @satisfies {import('../../limits/presentationPolicies').PresentationPolicy} */ ({
    antigravityQuotaWindow, antigravityQuotaWindowVisible,
    compactWindows: windows => limitProviderCompactWindows(null, windows),
    compactWindowLabel: (window, windows) => limitProviderCompactWindowLabel(null, window, windows),
    compactWindowPeriodLabel: (window, windows) => limitProviderCompactWindowPeriodLabel(null, window, windows),
    statusLabel: row => row.actionRequired === 'accountVerification'
    ? { label: 'Open Antigravity to verify', key: 'settings.antigravity.verificationRequired', tone: 'setup' } : null
  });
});
