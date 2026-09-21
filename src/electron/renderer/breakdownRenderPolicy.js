'use strict';

(function exposeBreakdownRenderPolicy(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorBreakdownRenderPolicy = api;
})(typeof window !== 'undefined' ? window : null, function createBreakdownRenderPolicy() {
  // FLIP captures force synchronous layout and every animated row creates both Web
  // Animations and a number-counting rAF. Keep that polish for the compact views it was
  // designed for, but never fan it out across a Hub-sized session collection.
  const MAX_ANIMATED_BREAKDOWN_ROWS = 40;
  const SESSION_BREAKDOWN_PAGE_SIZE = 100;

  function rowCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  function shouldAnimateBreakdownRows(count, options = {}) {
    return options.reducedMotion !== true && rowCount(count) <= MAX_ANIMATED_BREAKDOWN_ROWS;
  }

  function toolIconsEnabled(value) {
    return value === true;
  }

  function breakdownPage(rows, options = {}) {
    const allRows = Array.isArray(rows) ? rows : [];
    const pageSize = Math.max(1, rowCount(options.pageSize) || SESSION_BREAKDOWN_PAGE_SIZE);
    if (options.breakdown !== 'session' || allRows.length <= pageSize) {
      return {
        rows: allRows,
        page: 0,
        pageCount: 1,
        pageSize,
        start: allRows.length > 0 ? 1 : 0,
        end: allRows.length,
        total: allRows.length,
        paginated: false
      };
    }
    const pageCount = Math.ceil(allRows.length / pageSize);
    const requestedPage = Number.isFinite(Number(options.page)) ? Math.floor(Number(options.page)) : 0;
    const page = Math.max(0, Math.min(pageCount - 1, requestedPage));
    const offset = page * pageSize;
    return {
      rows: allRows.slice(offset, offset + pageSize),
      page,
      pageCount,
      pageSize,
      start: offset + 1,
      end: Math.min(allRows.length, offset + pageSize),
      total: allRows.length,
      paginated: true
    };
  }

  // The bar scale is the largest value actually rendered, with no artificial floor.
  // Clamping the maximum to 1 works for token counts (integers, effectively always
  // above 1) but silently breaks cost-ranked bars, where a $0.30 / $0.10 pair would
  // scale against 1 and render as 30% / 10% instead of 100% / 33%.
  function barScaleMax(rows) {
    return (Array.isArray(rows) ? rows : []).reduce((max, row) => {
      const value = Number(row?.barValue ?? row?.value);
      return Number.isFinite(value) && value > max ? value : max;
    }, 0);
  }

  // A zero maximum means nothing measurable was rendered, so every bar collapses
  // rather than dividing by it; the 2% floor keeps a non-zero row visible.
  function rowWidth(value, max) {
    if (Number(value) <= 0) return 0;
    return max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  }

  function rowRenderFingerprint(row, max, context = {}) {
    return JSON.stringify([row || null, Number(max) || 0, context || null]);
  }

  return {
    MAX_ANIMATED_BREAKDOWN_ROWS,
    SESSION_BREAKDOWN_PAGE_SIZE,
    barScaleMax,
    breakdownPage,
    rowRenderFingerprint,
    rowWidth,
    shouldAnimateBreakdownRows,
    toolIconsEnabled
  };
});
