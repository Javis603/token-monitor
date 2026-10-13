'use strict';

// Home list modules compete for one bounded panel: a fixed-height scroller
// whose bottom module gets clipped when the rows above it are taller than the
// budget assumed. The allocator works from measured geometry instead of a
// fixed 640px base and an assumed 32px row:
//
//  - every list module reports its real chrome (head, padding and status
//    lines), row height (which grows on narrow widths because session and
//    speed rows wrap) and inner gap;
//  - modules that share one grid row (the two-column layout) cost the height of
//    their tallest member, so growing the shorter member can be free;
//  - the panel's spare height is spent one equally-deepened row at a time: only
//    modules at the current shallowest depth grow, so no list runs away with
//    the budget while its neighbours stay at one row;
//  - a short panel reduces rows below the old fixed floor, never below one row
//    per non-empty list, and reports fitted:false when even that minimum cannot
//    fit so the caller leaves native scrolling in charge.
(function exposeHomeRowBudget(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorHomeRowBudget = api;
})(typeof window !== 'undefined' ? window : null, function createHomeRowBudgetApi() {
  const DEFAULT_MAX_EXTRA = 6;
  const DEFAULT_GAP = 12;

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nonNegative(value, fallback) {
    return Math.max(0, finite(value, fallback));
  }

  function clampRows(value, min, max) {
    const count = Math.floor(nonNegative(value, min));
    return Math.min(max, Math.max(min, count));
  }

  // Rows a module may preview: its base count plus the shared extra allowance,
  // still bounded by the rows the data actually carries. This is the number of
  // candidate rows rendered; the allocator hides the ones the panel cannot show.
  function previewCount(base, available) {
    const floor = Math.max(0, Math.floor(nonNegative(base, 0)));
    const cap = floor + DEFAULT_MAX_EXTRA;
    const limit = Number(available);
    if (!Number.isFinite(limit)) return cap;
    return Math.max(0, Math.min(cap, Math.floor(limit)));
  }

  // DOM order -> grid rows. Two columns pair modules; an odd last module spans
  // the full row on its own (the stylesheet gives it grid-column: 1 / -1).
  function layoutGroups(count, columns) {
    const total = Math.max(0, Math.floor(nonNegative(count, 0)));
    const groups = [];
    if (finite(columns, 1) >= 2) {
      for (let index = 0; index < total; index += 2) {
        groups.push(index + 1 < total ? [index, index + 1] : [index]);
      }
    } else {
      for (let index = 0; index < total; index += 1) groups.push([index]);
    }
    return groups;
  }

  function normalizeEntries(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry) => {
      const source = entry || {};
      const maxRows = Math.max(0, Math.floor(nonNegative(source.maxRows, 0)));
      const minRows = maxRows > 0 ? clampRows(source.minRows ?? 1, 1, maxRows) : 0;
      return {
        id: source.id,
        chromeHeight: nonNegative(source.chromeHeight, 0),
        rowHeight: nonNegative(source.rowHeight, 0),
        innerGap: nonNegative(source.innerGap, 0),
        minRows,
        maxRows
      };
    });
  }

  // The height of one module showing `rows` preview rows.
  function moduleHeight(entry, rows) {
    const count = Math.max(0, Math.floor(nonNegative(rows, 0)));
    if (count === 0) return entry.chromeHeight;
    return entry.chromeHeight + count * entry.rowHeight + (count - 1) * entry.innerGap;
  }

  // Height of the whole panel for one plan: a grid row costs its tallest member.
  function estimateHeight(plan, layout) {
    const entries = layout.entries || [];
    const heights = entries.map((entry, index) => moduleHeight(entry, plan[index] ?? 0));
    let total = 0;
    for (const group of layout.groups || []) {
      let groupHeight = 0;
      for (const index of group) groupHeight = Math.max(groupHeight, heights[index] || 0);
      total += groupHeight;
    }
    total += Math.max(0, (layout.groups || []).length - 1) * nonNegative(layout.gap, DEFAULT_GAP);
    return total;
  }

  // A pure allocation plan: same input -> same rows, no DOM and no mutation.
  function allocateHomeRows(input = {}) {
    const entries = normalizeEntries(input.entries);
    const columns = finite(input.columns, 1) >= 2 ? 2 : 1;
    const groups = Array.isArray(input.groups) && input.groups.length
      ? input.groups
      : layoutGroups(entries.length, columns);
    const gap = nonNegative(input.gap, DEFAULT_GAP);
    const layout = { entries, groups, gap };
    const panelHeight = finite(input.panelHeight, 0);
    const rows = entries.map((entry) => entry.minRows);
    let usedHeight = estimateHeight(rows, layout);
    if (panelHeight <= 0 || usedHeight > panelHeight) {
      return { rows, usedHeight, fitted: false, overflow: true };
    }
    for (;;) {
      let lowest = Infinity;
      for (let index = 0; index < entries.length; index += 1) {
        if (rows[index] < entries[index].maxRows) lowest = Math.min(lowest, rows[index]);
      }
      if (!Number.isFinite(lowest)) break;
      let progressed = false;
      for (let index = 0; index < entries.length; index += 1) {
        if (rows[index] !== lowest || rows[index] >= entries[index].maxRows) continue;
        const candidate = rows.slice();
        candidate[index] += 1;
        const candidateHeight = estimateHeight(candidate, layout);
        if (candidateHeight > panelHeight) continue;
        rows[index] += 1;
        usedHeight = candidateHeight;
        progressed = true;
      }
      if (!progressed) break;
    }
    // Free growth: a grid row whose other member is taller can carry more rows
    // of the shorter list without spending any height. Those rows cost the
    // panel nothing, so take them up to the preview bound.
    for (;;) {
      let added = false;
      for (let index = 0; index < entries.length; index += 1) {
        if (rows[index] >= entries[index].maxRows) continue;
        const candidate = rows.slice();
        candidate[index] += 1;
        if (estimateHeight(candidate, layout) !== usedHeight) continue;
        rows[index] += 1;
        added = true;
      }
      if (!added) break;
    }
    return { rows, usedHeight, fitted: true, overflow: false };
  }

  return {
    DEFAULT_MAX_EXTRA,
    DEFAULT_GAP,
    previewCount,
    layoutGroups,
    moduleHeight,
    estimateHeight,
    allocateHomeRows
  };
});
