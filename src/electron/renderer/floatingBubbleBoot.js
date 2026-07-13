'use strict';

(() => {
  const query = new URLSearchParams(window.location.search);
  const side = query.get('floatingBubbleSide');
  if (['left', 'right'].includes(side)) {
    document.documentElement.classList.add(`floating-bubble-collapsed-${side}`);
    window.__TOKEN_MONITOR_INITIAL_FLOATING_BUBBLE__ = { collapsed: true, side };
  }
  const period = query.get('period');
  const breakdown = query.get('breakdown');
  const viewState = {};
  if (['today', 'month', 'allTime'].includes(period)) viewState.period = period;
  if (['home', 'tool', 'status', 'device', 'model', 'project', 'session', 'limits', 'trends'].includes(breakdown)) viewState.breakdown = breakdown;
  if (Object.keys(viewState).length > 0) window.__TOKEN_MONITOR_INITIAL_VIEW_STATE__ = viewState;
  window.__TOKEN_MONITOR_SUPPRESS_INITIAL_NUMBER_ANIMATION__ =
    query.get('suppressInitialNumberAnimation') === '1';
})();
