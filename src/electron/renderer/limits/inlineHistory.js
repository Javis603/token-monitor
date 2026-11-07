'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorInlineQuotaHistory = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  // undefined means a superseded query; null genuinely invalidates this account.
  function createHistoryReader({ read, onChange }) {
    let revision = 0;
    let identity = '';
    let signature = '';
    let state = { payload: null, loading: false, error: false };
    function update(key, source, version) {
      const nextIdentity = JSON.stringify([source, key]);
      const nextSignature = JSON.stringify([nextIdentity, version]);
      if (nextSignature === signature) return;
      signature = nextSignature;
      const request = ++revision;
      if (identity !== nextIdentity) state = { payload: null, loading: false, error: false };
      identity = nextIdentity;
      if (!key) { state = { payload: null, loading: false, error: false }; onChange(state); return; }
      state = { ...state, loading: true, error: false };
      onChange(state);
      Promise.resolve().then(() => read(key)).then(payload => {
        if (request !== revision) return;
        state = { payload: payload === undefined ? state.payload : payload, loading: false, error: false };
        onChange(state);
      }, () => {
        if (request !== revision) return;
        state = { ...state, loading: false, error: true };
        onChange(state);
      });
    }
    return { update, invalidate() { revision++; identity = ''; signature = ''; state = { payload: null, loading: false, error: false }; } };
  }

  function createInlineHistory({ document, model, labels, translate, read }) {
    const root = document.createElement('section');
    root.className = 'provider-quota-history';
    let input;
    let accountKey = '';
    let windowKey = '';
    let queryState = { payload: null, loading: false, error: false };
    let scope = '';
    function el(tag, cls, text) {
      const node = document.createElement(tag); node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function t(key, args) { return translate(`limits.history.${key}`, args); }
    function number(value) { return new Intl.NumberFormat(input?.locale || 'en', { maximumFractionDigits: 2 }).format(value); }
    function date(at, options) { return new Date(at).toLocaleString(input?.locale || 'en', options); }
    function svg(tag, attrs, text) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      if (text !== undefined) node.textContent = text;
      return node;
    }
    const accounts = el('div', 'provider-history-accounts');
    accounts.setAttribute('role', 'group');
    const windows = el('div', 'provider-history-windows');
    windows.setAttribute('role', 'group');
    const content = el('div', 'provider-history-content');
    root.append(accounts, windows, content);
    const reader = createHistoryReader({ read, onChange(next) { queryState = next; render(); } });
    function chooseAccount(key) {
      if (!input?.accounts.some(a => a.key === key)) return;
      accountKey = key; windowKey = '';
      reader.update(accountKey, input.source, input.version);
    }
    function drawTrend(entry, payload) {
      const unit = entry.unit || entry.points.at(-1)?.unit || model.historyReadings(entry.window).primary?.unit || 'pp';
      const money = unit !== 'pp';
      const now = Date.now();
      const { start, end, cycle } = model.trendBounds(entry.window, now, payload.provider);
      const spent = money && entry.balance === false;
      const title = t(cycle ? (spent ? 'trendSpent' : 'trend') : (spent ? 'trendSpentRecent' : 'trendRecent'), { count: 14 });
      const section = el('section', 'provider-history-trend');
      const head = el('div', 'quota-history-heading');
      head.append(el('h3', '', title));
      const reading = model.historyReadings(entry.window).primary;
      if (reading) head.append(el('span', 'provider-history-current', unit === 'pp' ? `${number(100 - reading.value)}% ${t('remaining')}` : `${number(reading.value)} ${unit}`));
      section.append(head);
      const width = Math.max(220, root.clientWidth || 300), height = 104;
      const plot = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'provider-history-plot', role: 'img', 'aria-label': title });
      const points = entry.points.filter(p => p.at >= start && p.at <= end);
      const max = money ? Math.max(1, reading?.value || 0, ...points.map(p => p.value)) * 1.08 : 100;
      const left = 30, right = width - 5, top = 9, bottom = 81;
      const X = at => left + (at - start) / (end - start) * (right - left);
      const Y = value => bottom - Math.max(0, value) / max * (bottom - top);
      for (const value of [max, max / 2, 0]) {
        plot.append(svg('line', { x1: left, x2: right, y1: Y(value), y2: Y(value), class: 'quota-history-grid' }));
        if (value !== max / 2) plot.append(svg('text', { x: 0, y: Y(value) + 3 }, money ? number(value) : `${number(value)}%`));
      }
      if (!money && cycle) plot.append(svg('line', { x1: X(start), x2: X(end), y1: Y(100), y2: Y(0), class: 'quota-history-guide', 'aria-label': t('guide') }));
      for (const segment of model.segments(points)) {
        let d = '';
        for (const [i, point] of segment.entries()) d += `${i ? 'L' : 'M'}${X(point.at)},${Y(money ? point.value : 100 - point.value)}`;
        plot.append(svg('path', { d, class: 'quota-history-curve' }));
        if (segment.length === 1) plot.append(svg('circle', { cx: X(segment[0].at), cy: Y(money ? segment[0].value : 100 - segment[0].value), r: 1.8, class: 'quota-history-point' }));
      }
      const format = end - start < 86400000 ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' };
      plot.append(svg('text', { x: left, y: 101 }, date(start, format)), svg('text', { x: right, y: 101, 'text-anchor': 'end' }, date(end, format)));
      section.append(plot);
      if (!points.length) section.append(el('p', 'provider-history-empty', t('empty')));
      return section;
    }
    function drawDaily(entry) {
      const result = entry.distribution || model.distribution(entry.points, { now: Date.now() });
      const unit = entry.unit || entry.points.at(-1)?.unit || model.historyReadings(entry.window).primary?.unit || 'pp';
      const amount = value => unit === 'pp' ? `${number(value)}%` : `${number(value)} ${unit}`;
      const section = el('section', 'provider-history-daily');
      const head = el('div', 'quota-history-heading');
      head.append(el('h3', '', t('distribution')), el('span', '', t('lastDays', { count: 14 })));
      const bars = el('div', 'provider-daily-bars');
      bars.setAttribute('role', 'list');
      const peak = Math.max(1, ...result.buckets.map(b => b.value || 0));
      for (const bucket of result.buckets) {
        const day = el('div', `provider-daily-day${bucket.value === null ? ' is-unknown' : ''}${bucket.uncertain ? ' is-partial' : ''}`);
        day.setAttribute('role', 'listitem');
        const description = `${date(bucket.at, { month: 'numeric', day: 'numeric' })} · ${bucket.value === null ? t('unknown') : amount(bucket.value)}${bucket.uncertain ? ` · ${t('partial')}` : ''}`;
        day.setAttribute('aria-label', description);
        const value = el('span', 'provider-daily-value', bucket.value === null ? '—' : unit === 'pp' ? amount(bucket.value) : number(bucket.value));
        const track = el('span', 'provider-daily-track');
        const fill = el('i', ''); fill.style.height = `${(bucket.value || 0) / peak * 100}%`;
        track.append(fill);
        day.append(value, track, el('span', 'provider-daily-date', date(bucket.at, { day: 'numeric' })));
        bars.append(day);
      }
      section.append(head, bars);
      const today = result.buckets.find(b => b.key === model.dayKey(Date.now()));
      const meta = el('div', 'provider-history-meta');
      meta.append(el('span', '', `${t('today')} · ${today?.value == null ? t('insufficient') : amount(today.value)}`));
      if (entry.window.resetsAt) meta.append(el('span', '', t('resetAt', { time: date(entry.window.resetsAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })));
      section.append(meta);
      if (result.buckets.some(b => b.uncertain || b.value === null)) section.setAttribute('aria-description', t('notice'));
      if (result.unallocated > 0) section.append(el('p', 'provider-history-empty', t('unallocated', { amount: amount(result.unallocated) })));
      return section;
    }
    function render() {
      if (!input) return;
      const focused = root.contains(document.activeElement) ? document.activeElement.dataset.historyKey : null;
      const left = accounts.scrollLeft;
      const windowScroll = windows.scrollLeft;
      root.setAttribute('aria-busy', String(queryState.loading));
      accounts.hidden = input.accounts.length < 2;
      accounts.setAttribute('aria-label', translate('provider.historyProduct'));
      accounts.replaceChildren(...input.accounts.map(account => {
        const button = el('button', '', account.historyName || account.name);
        button.type = 'button'; button.dataset.historyKey = account.key;
        button.setAttribute('aria-pressed', String(account.key === accountKey));
        button.addEventListener('click', () => chooseAccount(account.key));
        return button;
      }));
      accounts.scrollLeft = left;
      const payload = queryState.payload;
      windows.hidden = !payload || payload.windows.length < 2;
      if (!payload) {
        windows.replaceChildren();
        content.replaceChildren(el('p', 'provider-history-empty', queryState.error ? translate('serviceStatus.checkFailed') : queryState.loading ? translate('home.historyLoading') : t('empty')));
      } else {
        root.style.setProperty('--quota-history-color', payload.color || 'var(--accent)');
        const entries = payload.windows;
        if (!entries.some(e => e.key === windowKey)) windowKey = entries.find(e => e.window.kind === 'weekly')?.key || entries[0]?.key || '';
        windows.replaceChildren(...entries.map(entry => {
          const label = labels.limitWindowLabel(payload.provider, entry.window, entry.window.kind);
          const duplicateLabel = entries.some(other => other !== entry && labels.limitWindowLabel(payload.provider, other.window, other.window.kind) === label);
          const button = el('button', '', duplicateLabel && entry.window.currency ? `${label} · ${entry.window.currency}` : label); button.type = 'button'; button.dataset.historyKey = entry.key;
          button.setAttribute('aria-pressed', String(entry.key === windowKey));
          button.addEventListener('click', () => { windowKey = entry.key; render(); });
          return button;
        }));
        const entry = entries.find(e => e.key === windowKey);
        content.replaceChildren(...(entry ? [drawTrend(entry, payload), drawDaily(entry)] : [el('p', 'provider-history-empty', t('empty'))]));
        if (payload.persistent === false) content.append(el('p', 'provider-history-empty', t('persistenceError')));
        if (queryState.error) content.append(el('p', 'provider-history-empty', translate('serviceStatus.checkFailed')));
      }
      windows.scrollLeft = windowScroll;
      if (focused) [...root.querySelectorAll('[data-history-key]')].find(n => n.dataset.historyKey === focused)?.focus({ preventScroll: true });
    }
    function update(next) {
      input = next;
      const nextScope = JSON.stringify([next.source, next.provider]);
      if (scope !== nextScope) { scope = nextScope; accountKey = ''; windowKey = ''; reader.invalidate(); queryState = { payload: null, loading: false, error: false }; }
      if (!input.accounts.some(a => a.key === accountKey)) accountKey = input.accounts[0]?.key || '';
      reader.update(accountKey, input.source, input.version);
      render();
    }
    if (typeof ResizeObserver !== 'undefined') {
      let lastWidth = 0;
      new ResizeObserver(() => { if (root.clientWidth !== lastWidth) { lastWidth = root.clientWidth; render(); } }).observe(root);
    }
    return { root, update, selectAccount: chooseAccount };
  }
  return { createHistoryReader, createInlineHistory };
});
